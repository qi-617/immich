import asyncio
import gc
import os
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from functools import partial
from typing import Any, AsyncGenerator, Callable, Iterator
from zipfile import BadZipFile

import numpy as np
import orjson
from fastapi import Depends, FastAPI, File, Form, HTTPException
from fastapi.responses import ORJSONResponse, PlainTextResponse
from numpy.typing import NDArray
from onnxruntime.capi.onnxruntime_pybind11_state import InvalidProtobuf, NoSuchFile
from PIL.Image import Image
from pydantic import ValidationError
from starlette.formparsers import MultiPartParser

from immich_ml.models import get_model_deps
from immich_ml.models.base import InferenceModel
from immich_ml.models.classification.yolo import YoloClassificationModel
from immich_ml.models.transforms import decode_pil

from .config import PreloadModelData, clean_name, log, settings
from .models.cache import ModelCache
from .schemas import (
    InferenceEntries,
    InferenceEntry,
    InferenceResponse,
    ModelFormat,
    ModelIdentity,
    ModelTask,
    ModelType,
    PipelineRequest,
    T,
)

MultiPartParser.spool_max_size = 2**26  # spools to disk if payload is 64 MiB or larger

DEFAULT_CATEGORIES = [
    "landscape", "portrait", "food", "animal", "architecture",
    "beach", "night", "city", "nature", "sport",
    "flower", "sunset", "mountain", "water", "forest",
    "indoor", "outdoor", "street", "garden", "snow",
    "car", "document", "selfie", "group photo", "pet",
    "wedding", "birthday", "travel", "art", "abstract",
]
SOFTMAX_TEMPERATURE = 100.0

model_cache = ModelCache(revalidate=settings.model_ttl > 0)
classification_model_cache: dict[str, YoloClassificationModel] = {}
thread_pool: ThreadPoolExecutor | None = None
lock = threading.Lock()
active_requests = 0
last_called: float | None = None
_text_embedding_cache: dict[tuple[str, str], NDArray[np.float32]] = {}


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncGenerator[None, None]:
    global thread_pool
    log.info(
        (
            "Created in-memory cache with unloading "
            f"{f'after {settings.model_ttl}s of inactivity' if settings.model_ttl > 0 else 'disabled'}."
        )
    )

    try:
        if settings.request_threads > 0:
            # asyncio is a huge bottleneck for performance, so we use a thread pool to run blocking code
            thread_pool = ThreadPoolExecutor(settings.request_threads) if settings.request_threads > 0 else None
            log.info(f"Initialized request thread pool with {settings.request_threads} threads.")
        if settings.model_ttl > 0 and settings.model_ttl_poll_s > 0:
            asyncio.ensure_future(idle_shutdown_task())
        if settings.preload is not None:
            await preload_models(settings.preload)
        yield
    finally:
        log.handlers.clear()
        for model in model_cache.cache._cache.values():
            del model
        classification_model_cache.clear()
        if thread_pool is not None:
            thread_pool.shutdown()
        gc.collect()


async def preload_models(preload: PreloadModelData) -> None:
    log.info(f"Preloading models: clip:{preload.clip} facial_recognition:{preload.facial_recognition}")

    async def load_models(model_string: str, model_type: ModelType, model_task: ModelTask) -> None:
        for model_name in model_string.split(","):
            model_name = model_name.strip()
            model = await model_cache.get(model_name, model_type, model_task)
            await load(model)

    if preload.clip.textual is not None:
        await load_models(preload.clip.textual, ModelType.TEXTUAL, ModelTask.SEARCH)

    if preload.clip.visual is not None:
        await load_models(preload.clip.visual, ModelType.VISUAL, ModelTask.SEARCH)

    if preload.facial_recognition.detection is not None:
        await load_models(
            preload.facial_recognition.detection,
            ModelType.DETECTION,
            ModelTask.FACIAL_RECOGNITION,
        )

    if preload.facial_recognition.recognition is not None:
        await load_models(
            preload.facial_recognition.recognition,
            ModelType.RECOGNITION,
            ModelTask.FACIAL_RECOGNITION,
        )

    if preload.ocr.detection is not None:
        await load_models(
            preload.ocr.detection,
            ModelType.DETECTION,
            ModelTask.OCR,
        )

    if preload.ocr.recognition is not None:
        await load_models(
            preload.ocr.recognition,
            ModelType.RECOGNITION,
            ModelTask.OCR,
        )

    if preload.clip_fallback is not None:
        log.warning(
            "Deprecated env variable: 'MACHINE_LEARNING_PRELOAD__CLIP'. "
            "Use 'MACHINE_LEARNING_PRELOAD__CLIP__TEXTUAL' and "
            "'MACHINE_LEARNING_PRELOAD__CLIP__VISUAL' instead."
        )

    if preload.facial_recognition_fallback is not None:
        log.warning(
            "Deprecated env variable: 'MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION'. "
            "Use 'MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__DETECTION' and "
            "'MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__RECOGNITION' instead."
        )


def update_state() -> Iterator[None]:
    global active_requests, last_called
    active_requests += 1
    last_called = time.time()
    try:
        yield
    finally:
        active_requests -= 1


def get_entries(entries: str = Form()) -> InferenceEntries:
    try:
        request: PipelineRequest = orjson.loads(entries)
        without_deps: list[InferenceEntry] = []
        with_deps: list[InferenceEntry] = []
        for task, types in request.items():
            for type, entry in types.items():
                parsed: InferenceEntry = {
                    "name": entry["modelName"],
                    "task": task,
                    "type": type,
                    "options": entry.get("options", {}),
                }
                dep = get_model_deps(parsed["name"], type, task)
                (with_deps if dep else without_deps).append(parsed)
        return without_deps, with_deps
    except (orjson.JSONDecodeError, ValidationError, KeyError, AttributeError) as e:
        log.error(f"Invalid request format: {e}")
        raise HTTPException(422, "Invalid request format.")


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def root() -> ORJSONResponse:
    return ORJSONResponse({"message": "Immich ML"})


@app.get("/ping")
def ping() -> PlainTextResponse:
    return PlainTextResponse("pong")


@app.post("/predict", dependencies=[Depends(update_state)])
async def predict(
    entries: InferenceEntries = Depends(get_entries),
    image: bytes | None = File(default=None),
    text: str | None = Form(default=None),
) -> Any:
    if image is not None:
        inputs: Image | str = await run(lambda: decode_pil(image))
    elif text is not None:
        inputs = text
    else:
        raise HTTPException(400, "Either image or text must be provided")
    response = await run_inference(inputs, entries)
    return ORJSONResponse(response)


@app.post("/classify", dependencies=[Depends(update_state)])
async def classify(
    image: bytes = File(),
    model_name: str = Form(default="YOLO26l-cls"),
    categories: str | None = Form(default=None),
    min_score: float = Form(default=0.15),
    max_results: int = Form(default=5),
) -> Any:
    category_list = _parse_categories(categories)

    pil_image = await run(lambda: decode_pil(image))
    label_scores = await _get_classification_scores(model_name, pil_image)

    results = _filter_classification_results(label_scores, category_list, min_score)
    results.sort(key=lambda x: x["confidence"], reverse=True)

    return ORJSONResponse({"classification": results[:max_results]})


def _parse_categories(categories: str | None) -> list[str]:
    if categories is None:
        return list(DEFAULT_CATEGORIES)
    try:
        parsed = orjson.loads(categories)
    except orjson.JSONDecodeError as e:
        raise HTTPException(422, f"Invalid categories JSON: {e}")
    if not isinstance(parsed, list) or len(parsed) == 0:
        raise HTTPException(422, "Categories must be a non-empty JSON array of strings.")
    return [str(c) for c in parsed]


async def _get_classification_scores(model_name: str, pil_image: Image) -> dict[str, float]:
    classifier = _get_classification_model(model_name)
    await run(classifier.load)
    return await run(classifier.predict, pil_image)


def _get_classification_model(model_name: str) -> YoloClassificationModel:
    cache_key = clean_name(model_name)
    with lock:
        if cache_key not in classification_model_cache:
            classification_model_cache[cache_key] = YoloClassificationModel(model_name)
        return classification_model_cache[cache_key]


def _filter_classification_results(
    label_scores: dict[str, float],
    category_list: list[str],
    min_score: float,
) -> list[dict[str, float | str]]:
    normalized_scores = {_normalize_category(label): score for label, score in label_scores.items()}
    results: list[dict[str, float | str]] = []
    for category in category_list:
        score = normalized_scores.get(_normalize_category(category))
        if score is not None and score >= min_score:
            results.append({"categoryName": category, "confidence": float(score)})
    return results


def _normalize_category(category: str) -> str:
    return category.strip().casefold()


async def _get_image_embedding(model_name: str, pil_image: Image) -> NDArray[np.float32]:
    visual_model = await model_cache.get(model_name, ModelType.VISUAL, ModelTask.SEARCH, ttl=settings.model_ttl)
    visual_model = await load(visual_model)
    embedding_json: str = await run(visual_model.predict, pil_image)
    return np.array(orjson.loads(embedding_json), dtype=np.float32)


async def _get_text_embeddings(model_name: str, category_list: list[str]) -> list[NDArray[np.float32]]:
    textual_model = await model_cache.get(model_name, ModelType.TEXTUAL, ModelTask.SEARCH, ttl=settings.model_ttl)
    textual_model = await load(textual_model)

    embeddings: list[NDArray[np.float32]] = []
    for category in category_list:
        cache_key = (model_name, category)
        if cache_key in _text_embedding_cache:
            embeddings.append(_text_embedding_cache[cache_key])
        else:
            prompt = f"a photo of {category}"
            embedding_json: str = await run(textual_model.predict, prompt)
            embedding = np.array(orjson.loads(embedding_json), dtype=np.float32)
            _text_embedding_cache[cache_key] = embedding
            embeddings.append(embedding)
    return embeddings


def _cosine_softmax(
    image_embedding: NDArray[np.float32],
    text_embeddings: NDArray[np.float32],
) -> NDArray[np.float32]:
    """Cosine similarity between one image and N texts, then softmax with temperature scaling."""
    image_norm = image_embedding / np.linalg.norm(image_embedding)
    text_norms = text_embeddings / np.linalg.norm(text_embeddings, axis=1, keepdims=True)
    logits = (text_norms @ image_norm) * SOFTMAX_TEMPERATURE
    exp_logits = np.exp(logits - np.max(logits))
    return exp_logits / exp_logits.sum()


async def run_inference(payload: Image | str, entries: InferenceEntries) -> InferenceResponse:
    outputs: dict[ModelIdentity, Any] = {}
    response: InferenceResponse = {}

    async def _run_inference(entry: InferenceEntry) -> None:
        model = await model_cache.get(
            entry["name"], entry["type"], entry["task"], ttl=settings.model_ttl, **entry["options"]
        )
        inputs = [payload]
        for dep in model.depends:
            try:
                inputs.append(outputs[dep])
            except KeyError:
                message = f"Task {entry['task']} of type {entry['type']} depends on output of {dep}"
                raise HTTPException(400, message)
        model = await load(model)
        output = await run(model.predict, *inputs, **entry["options"])
        outputs[model.identity] = output
        response[entry["task"]] = output

    without_deps, with_deps = entries
    await asyncio.gather(*[_run_inference(entry) for entry in without_deps])
    if with_deps:
        await asyncio.gather(*[_run_inference(entry) for entry in with_deps])
    if isinstance(payload, Image):
        response["imageHeight"], response["imageWidth"] = payload.height, payload.width

    return response


async def run(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    if thread_pool is None:
        return func(*args, **kwargs)
    partial_func = partial(func, *args, **kwargs)
    return await asyncio.get_running_loop().run_in_executor(thread_pool, partial_func)


async def load(model: InferenceModel) -> InferenceModel:
    if model.loaded:
        return model

    def _load(model: InferenceModel) -> InferenceModel:
        if model.load_attempts > 1:
            raise HTTPException(500, f"Failed to load model '{model.model_name}'")
        with lock:
            try:
                model.load()
            except FileNotFoundError as e:
                if model.model_format == ModelFormat.ONNX:
                    raise e
                log.warning(
                    f"{model.model_format.upper()} is available, but model '{model.model_name}' does not support it.",
                    exc_info=e,
                )
                model.model_format = ModelFormat.ONNX
                model.load()
        return model

    try:
        return await run(_load, model)
    except (OSError, InvalidProtobuf, BadZipFile, NoSuchFile):
        log.warning(f"Failed to load {model.model_type.replace('_', ' ')} model '{model.model_name}'. Clearing cache.")
        model.clear_cache()
        return await run(_load, model)


async def idle_shutdown_task() -> None:
    while True:
        if (
            last_called is not None
            and not active_requests
            and not lock.locked()
            and time.time() - last_called > settings.model_ttl
        ):
            log.info("Shutting down due to inactivity.")
            os.kill(os.getpid(), signal.SIGINT)
            break
        await asyncio.sleep(settings.model_ttl_poll_s)
