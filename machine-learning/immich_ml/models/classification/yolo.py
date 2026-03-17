from __future__ import annotations

from functools import cached_property
from pathlib import Path
from typing import Any

import numpy as np
import orjson
from huggingface_hub import snapshot_download
from numpy.typing import NDArray
from PIL import Image

from immich_ml.config import clean_name, log, settings
from immich_ml.models.transforms import decode_pil
from immich_ml.sessions.ort import OrtSession


class YoloClassificationModel:
    def __init__(
        self,
        model_name: str,
        cache_dir: Path | str | None = None,
        session: OrtSession | None = None,
    ) -> None:
        self.model_name = clean_name(model_name)
        self.cache_dir = Path(cache_dir) if cache_dir is not None else self._cache_dir_default
        self.session = session
        self.loaded = session is not None
        self.input_name = "images"
        self.input_height = 224
        self.input_width = 224

    def download(self) -> None:
        if self.model_path.is_file():
            return
        log.info(f"Downloading classification model '{self.model_name}' to {self.cache_dir}. This may take a while.")
        snapshot_download(
            f"immich-app/{self.model_name}",
            cache_dir=self.cache_dir,
            local_dir=self.cache_dir,
            ignore_patterns=["*.armnn", "*.rknn"],
        )

    def load(self) -> None:
        if self.loaded:
            return

        self.download()
        log.info(f"Loading classification model '{self.model_name}' to memory")
        self.session = OrtSession(self.model_path)
        input_node = self.session.get_inputs()[0]
        self.input_name = input_node.name or "images"
        _, _, height, width = _normalize_input_shape(input_node.shape)
        self.input_height = height
        self.input_width = width
        self.loaded = True

    def predict(self, inputs: Image.Image | bytes) -> dict[str, float]:
        self.load()

        image = decode_pil(inputs)
        tensor = self._preprocess(image)
        outputs = self.session.run(None, {self.input_name: tensor})
        probabilities = _to_probabilities(outputs[0])

        if probabilities.shape[0] != len(self.labels):
            raise ValueError(
                f"Classification output size {probabilities.shape[0]} does not match labels size {len(self.labels)}"
            )

        return {label: float(probabilities[index]) for index, label in enumerate(self.labels)}

    @property
    def model_path(self) -> Path:
        return self.cache_dir / "model.onnx"

    @property
    def _cache_dir_default(self) -> Path:
        return settings.cache_folder / "classification" / self.model_name

    @cached_property
    def labels(self) -> list[str]:
        labels_path = self._resolve_labels_path()
        suffix = labels_path.suffix.lower()

        if suffix == ".json":
            parsed = orjson.loads(labels_path.read_bytes())
            if isinstance(parsed, list):
                return [str(label) for label in parsed]
            if isinstance(parsed, dict):
                try:
                    items = sorted(parsed.items(), key=lambda item: int(item[0]))
                except (TypeError, ValueError):
                    items = sorted(parsed.items(), key=lambda item: str(item[0]))
                return [str(label) for _, label in items]
            raise ValueError(f"Unsupported labels.json format for model '{self.model_name}'")

        labels = [line.strip() for line in labels_path.read_text().splitlines() if line.strip()]
        if not labels:
            raise ValueError(f"Labels file is empty for model '{self.model_name}'")
        return labels

    def _resolve_labels_path(self) -> Path:
        for candidate in (self.cache_dir / "labels.txt", self.cache_dir / "labels.json"):
            if candidate.is_file():
                return candidate
        raise FileNotFoundError(f"Labels file not found for classification model '{self.model_name}'")

    def _preprocess(self, image: Image.Image) -> NDArray[np.float32]:
        image = image.resize((self.input_width, self.input_height), resample=Image.Resampling.BILINEAR)
        image_np = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        image_np = image_np.transpose(2, 0, 1)
        return np.expand_dims(np.ascontiguousarray(image_np), 0)


def _normalize_input_shape(shape: list[Any] | tuple[Any, ...]) -> tuple[int, int, int, int]:
    dims = list(shape)
    if len(dims) != 4:
        raise ValueError(f"Unsupported classification input shape: {shape}")

    normalized: list[int] = []
    for index, dim in enumerate(dims):
        if isinstance(dim, int) and dim > 0:
            normalized.append(dim)
        elif index == 1:
            normalized.append(3)
        else:
            normalized.append(224)
    return tuple(normalized)  # type: ignore[return-value]


def _to_probabilities(output: NDArray[np.float32]) -> NDArray[np.float32]:
    logits = np.asarray(output, dtype=np.float32).reshape(-1)
    if logits.size == 0:
        raise ValueError("Classification model returned an empty output tensor")

    total = float(np.sum(logits))
    if np.all(logits >= 0) and np.isfinite(total) and np.isclose(total, 1.0, atol=1e-3):
        return logits

    shifted = logits - np.max(logits)
    exp_logits = np.exp(shifted)
    return exp_logits / np.sum(exp_logits)
