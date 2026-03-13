# 照片自动分类功能实现记录

## Phase 1 & Phase 2 代码变更总结

---

### Phase 1: ML 服务 — `POST /classify` 端点

**修改文件**: `machine-learning/immich_ml/main.py`

#### 核心设计

复用已有 CLIP visual/textual encoder 实现零样本图像分类，**不引入任何新模型或新依赖**。

#### 新增内容（按顺序）

| 行号区间 | 内容 | 说明 |
|----------|------|------|
| 13, 17 | `import numpy as np` / `from numpy.typing import NDArray` | 新增导入，用于 embedding 计算 |
| 43-51 | `DEFAULT_CATEGORIES` (30个) + `SOFTMAX_TEMPERATURE = 100.0` | 模块级常量 |
| 58 | `_text_embedding_cache: dict[tuple[str, str], NDArray]` | 文本 embedding 缓存，key = `(model_name, category)` |
| 208-232 | `classify()` 端点 | 编排层，调用下面 4 个函数 |
| 235-244 | `_parse_categories()` | 输入校验：解析 JSON、校验非空、返回 `list[str]` |
| 247-251 | `_get_image_embedding()` | 加载 CLIP visual encoder → 推理 → 反序列化为 numpy |
| 254-269 | `_get_text_embeddings()` | 加载 CLIP textual encoder → 带缓存的批量文本推理 |
| 272-281 | `_cosine_softmax()` | 纯函数：余弦相似度 → temperature scaling → softmax |

#### 请求/响应格式

```
POST /classify  (multipart/form-data)
├── image: bytes          (必填)
├── model_name: str       (默认 "ViT-B-32__openai")
├── categories: str|null  (JSON 数组，默认 DEFAULT_CATEGORIES)
├── min_score: float      (默认 0.15)
└── max_results: int      (默认 5)

Response: {"classification": [{"categoryName": "landscape", "confidence": 0.85}, ...]}
```

#### 关键实现细节

1. **模型复用**: 通过 `model_cache.get(model_name, ModelType.VISUAL, ModelTask.SEARCH)` 获取与 `/predict` 完全相同的 CLIP 模型实例
2. **Embedding 反序列化**: CLIP encoder 返回 `serialize_np_array()` 的 JSON 字符串，用 `np.array(orjson.loads(...))` 转回 numpy
3. **文本缓存**: `_text_embedding_cache` 是模块级 dict，首次请求后 30 个类别的文本 embedding 被缓存，后续请求只需做一次图像推理
4. **Softmax temperature=100**: CLIP 原始相似度范围很窄（通常 0.15-0.35），temperature 放大差异使概率分布更有区分度

#### 后续替换算法时的改动点

只需修改 `classify()` 函数体——把 CLIP 调用换成新的分类模型调用，保持返回格式 `{"classification": [{categoryName, confidence}]}` 不变。

---

### Phase 2: 数据库 — 新表 + 迁移

#### 2a. 新建表定义

**新文件**: `server/src/schema/tables/asset-category.table.ts`

```
asset_categories
├── id: uuid (PK, auto-generated)
├── assetId: uuid (FK → asset.id, CASCADE DELETE/UPDATE)
├── categoryName: text
└── confidence: real
```

对标 `asset-ocr.table.ts`。不需要 `isVisible`、`createdAt`、`updatedAt` 等列——分类结果是整体替换语义（delete + insert），不做增量更新。

#### 2b. job status 表新增列

**修改文件**: `server/src/schema/tables/asset-job-status.table.ts`

在 `ocrAt` 之后新增 `classifiedAt: Timestamp | null`，用于标记资产是否已完成分类（`NULL` = 待分类）。

#### 2c. Schema 注册

**修改文件**: `server/src/schema/index.ts`

三处变更（均按字母序插入）：
- 导入 `AssetCategoryTable`
- 加入 `tables` 数组
- 加入 `DB` 接口

#### 2d. 迁移文件

**新文件**: `server/src/schema/migrations/1773301586574-CreateAssetCategories.ts`

`up()` 包含 6 条 SQL：

| # | SQL | 用途 |
|---|-----|------|
| 1 | `CREATE TABLE "asset_categories" (...)` | 建表 |
| 2 | `ADD CONSTRAINT ... PRIMARY KEY` | 主键 |
| 3 | `ADD CONSTRAINT ... FOREIGN KEY` | 外键(CASCADE) |
| 4 | `CREATE INDEX ... ("assetId")` | 按资产查询索引 |
| 5 | `CREATE INDEX ... ("categoryName")` | 按分类名查询索引（Explore 页面用） |
| 6 | `ALTER TABLE "asset_job_status" ADD "classifiedAt"` | job status 新列 |

`down()` 反向：先删列再删表。

---

### 测试状态（Phase 1 & 2）

| 项目 | 结果 |
|------|------|
| Python 语法 (AST parse) | ✅ |
| Ruff lint | ✅ All checks passed |
| ML pytest (88 tests) | ✅ 88 passed, 0 failed |
| TypeScript type-check | ⚠️ 环境限制未能运行（worktree 中 `pnpm install` OOM），需在完整开发环境中验证 |

---

## Phase 3 & Phase 4 & Phase 5 代码变更总结

---

### Phase 3: 枚举 + 配置 + 类型

#### 3a. 枚举

**修改文件**: `server/src/enum.ts`

| 枚举 | 新增值 | 位置 |
|------|--------|------|
| `QueueName` | `Classification = 'classification'` | `Ocr` 之后 |
| `JobName` | `ClassificationQueueAll = 'ClassificationQueueAll'` | `Ocr` 之后 |
| `JobName` | `Classification = 'Classification'` | 同上 |

#### 3b. 类型定义

**修改文件**: `server/src/types.ts`

在 `JobItem` 联合类型 OCR 部分之后新增：
```typescript
| { name: JobName.ClassificationQueueAll; data: IBaseJob }
| { name: JobName.Classification; data: IEntityJob }
```

#### 3c. 系统配置

**修改文件**: `server/src/config.ts`

1. **类型定义** — `machineLearning.classification` 块：
```typescript
classification: {
  enabled: boolean;
  modelName: string;    // 审查优化：从方法默认参数改为走配置
  minScore: number;
  maxResults: number;
  categories: string[];
};
```

2. **默认值** — 30 个场景+主题混合类别、`modelName: 'ViT-B-32__openai'`

3. **队列并发度** — `[QueueName.Classification]: { concurrency: 1 }`

#### 3d. 工具函数

**修改文件**: `server/src/utils/misc.ts`

```typescript
export const isClassificationEnabled = (machineLearning: SystemConfig['machineLearning']) =>
  isMachineLearningEnabled(machineLearning) && machineLearning.classification.enabled;
```

---

### Phase 4: Repository 层

#### 4a. CategoryRepository

**新建文件**: `server/src/repositories/category.repository.ts`

| 方法 | 说明 | 关键设计 |
|------|------|----------|
| `getByAssetId(assetId)` | 按资产查分类 | `ORDER BY confidence DESC` |
| `getDistinctCategories(userId)` | 用户分类汇总 | `INNER JOIN asset` + 过滤 `deletedAt IS NULL` + `visibility != Hidden` |
| `upsert(assetId, categories)` | 全量替换 | 事务内 `DELETE + INSERT`（整体替换语义） |
| `deleteAll()` | 清空全表 | 使用 `TRUNCATE`（与 OCR repo 保持一致） |

#### 4b. ML Repository 新增分类方法

**修改文件**: `server/src/repositories/machine-learning.repository.ts`

**审查优化**：将原 `predict()` 中 30 行重试/健康检查逻辑提取为通用方法 `postWithFailover<T>(endpoint, formData, label)`，`predict()` 和 `classifyImage()` 都调用它。

新增内容：
```
ClassificationResult   = { categoryName: string; confidence: number }
ClassificationResponse = { classification: ClassificationResult[] }
ClassificationOptions  = { modelName: string; minScore: number; maxResults: number; categories: string[] }

postWithFailover<T>() — 通用的带健康检查的 failover POST 方法
classifyImage()       — 构建 FormData, 调用 /classify 端点
```

`classifyImage()` 实现从原先 38 行缩减到 13 行。

#### 4c. AssetJobRepository 新增查询

**修改文件**: `server/src/repositories/asset-job.repository.ts`

| 方法 | 说明 | 对标方法 |
|------|------|----------|
| `getForClassification(id)` | 获取 `visibility` + `previewFile` | `getForOcr(id)` |
| `streamForClassificationJob(force?)` | 过滤 `classifiedAt IS NULL` | `streamForOcrJob(force?)` |

#### 4d. 注册到各入口

| 文件 | 变更 |
|------|------|
| `server/src/repositories/index.ts` | 导入 + 添加到 `repositories` 数组 |
| `server/src/services/base.service.ts` | 添加到 `BASE_SERVICE_DEPENDENCIES` + 构造函数参数 |
| `server/test/utils.ts` | 添加到 `ServiceOverrides` 类型 + `getMocks()` + `newTestService()` |

---

### Phase 5: Service + Controller + DTO + 任务链

#### 5a. Category DTO

**新建文件**: `server/src/dtos/category.dto.ts`

```typescript
AssetCategoryResponseDto    // id, assetId, categoryName, confidence
CategorySummaryResponseDto  // categoryName, count (审查修正: number 类型, 非 string)
```

#### 5b. ClassificationService

**新建文件**: `server/src/services/classification.service.ts`

完全对标 `ocr.service.ts` 的结构：

| 方法 | 装饰器 | 说明 |
|------|--------|------|
| `handleQueueClassification({force})` | `@OnJob(ClassificationQueueAll)` | 批量入队，支持 force 重跑 |
| `handleClassification({id})` | `@OnJob(Classification)` | 单资产分类：检查配置→获取预览图→调ML→存库→更新jobStatus |
| `getAssetCategories(auth, assetId)` | — | API 查询，带 `requireAccess` 权限校验 |
| `getCategorySummaries(auth)` | — | API 查询，按用户分组汇总 |

#### 5c. CategoryController

**新建文件**: `server/src/controllers/category.controller.ts`

```
@Controller('categories')
├── GET /categories/asset/:id  → getAssetCategories()
└── GET /categories            → getCategorySummaries()
```

使用 `@ApiTags(ApiTag.Search)` 归入 Search 文档组。

#### 5d. 任务链接入

**修改文件**: `server/src/services/job.service.ts`

在 `AssetGenerateThumbnails` 完成后的 jobs 数组中新增：
```typescript
{ name: JobName.Classification, data: item.data }
```

新上传的照片会自动触发：`Upload → Thumbnails → Classification`

#### 5e. 队列注册

| 文件 | 变更 |
|------|------|
| `server/src/services/queue.service.ts` | 新增 `case QueueName.Classification` switch 分支 |
| `server/src/dtos/queue-legacy.dto.ts` | 新增 `[QueueName.Classification]` 属性 |
| `server/src/dtos/system-config.dto.ts` | 新增 `[QueueName.Classification]` JobSettingsDto |

#### 5f. 注册 Service / Controller

| 文件 | 变更 |
|------|------|
| `server/src/services/index.ts` | 导入 + 添加 `ClassificationService` |
| `server/src/controllers/index.ts` | 导入 + 添加 `CategoryController` |

#### 5g. 测试 spec 同步

| 文件 | 变更 |
|------|------|
| `server/src/services/queue.service.spec.ts` | `[QueueName.Classification]: expected` |
| `server/src/services/system-config.service.spec.ts` | classification 配置块 + 队列并发度 |

---

### 审查优化记录

代码完成后进行了架构级审查，共修复 5 项问题：

| # | 问题 | 严重度 | 修复 |
|---|------|--------|------|
| 1 | ML repo `classifyImage` 复制粘贴了 `predict()` 30 行重试逻辑 | Critical/DRY | 提取 `postWithFailover<T>()` 通用方法，两处都调它 |
| 2 | DTO `CategorySummaryResponseDto.count` 标注为 `string` | Bug | 改为 `number`, `@ApiProperty({ type: 'integer' })` |
| 3 | `modelName` 硬编码在方法默认参数 `= 'ViT-B-32__openai'` | Design | 加入 config type + defaults + options type，从配置传入 |
| 4 | `getDistinctCategories` 漏掉 `visibility` 过滤 | Bug | 补 `.where('asset.visibility', '!=', AssetVisibility.Hidden)` |
| 5 | `deleteAll` 用 `DELETE FROM` 全表扫描 | Perf | 改用 `TRUNCATE`，与 OCR repo 一致 |

---

### 测试状态（Phase 3 & 4 & 5）

| 项目 | 结果 |
|------|------|
| 静态分析：枚举完整性 | ✅ QueueName + JobName 均已添加 |
| 静态分析：Config 类型 = 默认值 | ✅ 5个字段完全匹配 |
| 静态分析：JobItem 联合类型 | ✅ 两个 Classification 条目已添加 |
| 静态分析：队列注册（5个文件） | ✅ 全部包含 Classification |
| 静态分析：BaseService 参数顺序 | ✅ 依赖数组/构造函数/mock 三处对齐 |
| 静态分析：ML repo 接口一致性 | ✅ Options 类型、方法签名、Service 调用三处对齐 |
| 静态分析：Service/Controller 注册 | ✅ index.ts 均已更新 |
| 单元测试 | ⚠️ `pnpm install` OOM（Node 24.4.0 已知问题），需在完整开发环境中运行 |

---

### 新建文件清单（Phase 3-5）

| 文件 | 说明 |
|------|------|
| `server/src/repositories/category.repository.ts` | 分类数据访问层 |
| `server/src/dtos/category.dto.ts` | 分类 DTO（响应 + 汇总） |
| `server/src/services/classification.service.ts` | 分类业务逻辑（Job handler + API） |
| `server/src/controllers/category.controller.ts` | 分类 API 端点 |

### 修改文件清单（Phase 3-5）

| 文件 | 修改内容 |
|------|----------|
| `server/src/enum.ts` | +QueueName.Classification, +JobName.Classification/QueueAll |
| `server/src/types.ts` | +JobItem 联合类型 2 条 |
| `server/src/config.ts` | +classification 配置类型定义 + 默认值 + 队列并发度 |
| `server/src/utils/misc.ts` | +isClassificationEnabled() |
| `server/src/repositories/machine-learning.repository.ts` | +postWithFailover() + classifyImage() + 3 types |
| `server/src/repositories/asset-job.repository.ts` | +getForClassification() + streamForClassificationJob() |
| `server/src/repositories/index.ts` | +CategoryRepository 注册 |
| `server/src/services/base.service.ts` | +CategoryRepository 到依赖数组 + 构造函数 |
| `server/src/services/index.ts` | +ClassificationService |
| `server/src/services/job.service.ts` | +任务链新增 Classification |
| `server/src/services/queue.service.ts` | +Classification queue case |
| `server/src/controllers/index.ts` | +CategoryController |
| `server/src/dtos/queue-legacy.dto.ts` | +Classification 队列 DTO |
| `server/src/dtos/system-config.dto.ts` | +Classification JobSettings |
| `server/src/services/queue.service.spec.ts` | +Classification 队列期望值 |
| `server/src/services/system-config.service.spec.ts` | +classification 配置默认值 |
| `server/test/utils.ts` | +CategoryRepository mock + override |

---

### 待完成阶段

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 6 | OpenAPI + SQL 重新生成 | ⏳ 需在完整开发环境执行 `make open-api && make sql` |
| Phase 7 | Web 前端 — 详情面板分类组件 | ⏳ |
| Phase 8 | Web 前端 — 探索页面分类板块 | ⏳ |
| Phase 9 | i18n 翻译键 | ⏳ |
| Phase 10 | 单元测试 | ⏳ |