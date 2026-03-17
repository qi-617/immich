# 照片自动分类算法接入接口说明

## 1. 文档目的

本文档面向算法组同事，说明如何将自研照片分类算法接入当前 Immich 工程，且**不改动服务端调用链路**。

目标：只需在 ML 服务侧兼容既有接口，即可被服务端分类任务直接调用。

---

## 2. 接入边界与调用链路

当前工程调用链路如下：

1. 资产生成缩略图后触发 `Classification` 任务。
2. 服务端读取资产预览图路径（`previewFile`）。
3. 服务端向 ML 服务发送 `POST /classify`（multipart/form-data）。
4. ML 返回分类结果数组。
5. 服务端将结果写入 `asset_categories`，并更新 `asset_job_status.classifiedAt`。

> 结论：算法组只需实现并维护 ML 侧 `/classify` 与 `/ping` 契约。

---

## 3. 必须兼容的 HTTP 接口

### 3.1 健康检查

- **Method**: `GET`
- **Path**: `/ping`
- **Response**: 200 + 纯文本 `pong`

服务端会定时探活并进行多 URL failover。

### 3.2 分类推理

- **Method**: `POST`
- **Path**: `/classify`
- **Content-Type**: `multipart/form-data`

请求字段如下：

| 字段名 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `image` | binary | 是 | 图片二进制（服务端传入预览图） |
| `model_name` | string | 否 | 模型名（默认值建议兼容：`ViT-B-32__openai`） |
| `categories` | string(JSON) | 否 | 分类候选列表，JSON 字符串，如 `["landscape","portrait"]` |
| `min_score` | number | 否 | 置信度下限，低于该值可不返回 |
| `max_results` | int | 否 | 返回最多多少个类别 |

说明：`categories` 是 **JSON 字符串**，不是多值 form 字段。

---

## 4. 响应契约（必须）

### 4.1 成功响应

- **HTTP**: `200 OK`
- **Body(JSON)**:

```json
{
  "classification": [
    { "categoryName": "portrait", "confidence": 0.92 },
    { "categoryName": "selfie", "confidence": 0.41 }
  ]
}
```

字段约束：

- `classification`: 数组，可为空数组。
- `categoryName`: 字符串。
- `confidence`: 浮点数，建议范围 `[0, 1]`。

### 4.2 失败响应建议

- 参数非法（例如 `categories` 不是合法 JSON）：返回 `422`。
- 请求缺失图片：返回 `400/422`。
- 模型内部错误：返回 `5xx`。

> 服务端会对失败 URL 进行健康状态降级并尝试其它 URL。

---

## 5. 与服务端的语义对齐（关键）

为保证“零改服务端”接入，请保持以下语义：

1. 支持 `min_score` 与 `max_results`，并在 ML 侧执行过滤与截断。
2. 返回类别可按置信度降序（推荐）。
3. 允许 `categories` 为空（或未传）时使用默认类别集。
4. 单次请求只处理一张图片。
5. 接口保持路径与字段名不变：`/classify`、`categoryName`、`confidence`。

---

## 6. 可替换实现建议（算法组）

你可以替换当前 CLIP 方案为任意自研模型，但建议保持以下流程：

1. 解析 multipart（取 `image` + 参数）。
2. 将 `categories` 作为候选标签集合。
3. 推理输出每个候选标签分数。
4. 映射为统一响应结构 `[{ categoryName, confidence }]`。
5. 应用 `min_score` 过滤与 `max_results` 截断。

只要响应契约不变，服务端无需改动。

---

## 7. 联调示例

```bash
curl -X POST http://127.0.0.1:3003/classify \
  -F "image=@/path/to/test.jpg" \
  -F "model_name=ViT-B-32__openai" \
  -F 'categories=["portrait","selfie","food","landscape"]' \
  -F "min_score=0.15" \
  -F "max_results=5"
```

期望返回：

```json
{
  "classification": [
    { "categoryName": "portrait", "confidence": 0.83 }
  ]
}
```

---

## 8. 服务端配置来源（供算法联调参考）

服务端会从系统配置读取并透传以下参数到 `/classify`：

- `modelName`
- `minScore`
- `maxResults`
- `categories`

默认值（当前工程）：

- `modelName`: `ViT-B-32__openai`
- `minScore`: `0.15`
- `maxResults`: `5`
- `categories`: 30 个默认场景/主题标签

---

## 9. 验收清单（交付前）

- [ ] `GET /ping` 稳定返回 `pong`
- [ ] `POST /classify` 可处理真实预览图
- [ ] 支持自定义 `categories`（JSON 字符串）
- [ ] 正确执行 `min_score` / `max_results`
- [ ] 返回结构严格为 `classification -> [{categoryName, confidence}]`
- [ ] 空结果返回 `classification: []`（不要返回 `null`）

---

## 10. 代码位置（当前实现）

- ML 接口实现：`machine-learning/immich_ml/main.py`
- 服务端 ML 调用封装：`server/src/repositories/machine-learning.repository.ts`
- 分类任务编排：`server/src/services/classification.service.ts`
- 分类配置定义：`server/src/config.ts`
