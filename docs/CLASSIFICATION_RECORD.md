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

---

## Phase 6 & Phase 7 & Phase 8 & Phase 9 & Phase 10 代码变更总结

---

### Phase 6: OpenAPI + SQL 重新生成

#### 执行结果

- `make open-api` ✅ 成功执行，自动生成 TypeScript SDK 和 Dart SDK
- `make sql` ⚠️ worktree 环境中 `nest build` 缺少 `@nestjs/cli`，需在完整开发环境执行

#### 自动生成的 SDK 函数

**文件**: `open-api/typescript-sdk/src/fetch-client.ts`

| 函数 | HTTP 方法 | 路径 | 说明 |
|------|-----------|------|------|
| `getAssetCategories({ id })` | GET | `/categories/asset/{id}` | 获取单个资产的分类结果 |
| `getCategorySummaries()` | GET | `/categories` | 获取用户所有分类汇总 |

自动生成的 DTO 类型：
- `AssetCategoryResponseDto` — `{ id, assetId, categoryName, confidence }`
- `CategorySummaryResponseDto` — `{ categoryName, count }`

---

### Phase 7: Web 前端 — 详情面板分类组件

#### 7a. 新建分类组件

**新文件**: `web/src/lib/components/asset-viewer/detail-panel-categories.svelte`

参照 `detail-panel-tags.svelte` 模式，实现资产详情侧边栏的分类标签展示。

##### 核心设计

| 方面 | 实现 | 说明 |
|------|------|------|
| 数据获取 | `$effect` + 取消模式 | 防止资产快速切换时的竞态条件 |
| 类型 | `AssetCategoryResponseDto[]` | 使用 SDK 自动生成的类型，而非内联类型 |
| 权限 | `!authManager.isSharedLink` 守卫 | 共享链接下不展示分类（与 tags 行为一致） |
| 暗黑模式 | `dark:bg-immich-dark-bg dark:text-immich-dark-fg` | 组件自管 section 包装器 |
| 底部间距 | `pb-12` | 作为面板最后一个区块，需要底部留白 |

##### 关键代码模式 — `$effect` 竞态取消

```svelte
$effect(() => {
  const assetId = asset.id;
  let cancelled = false;

  getAssetCategories({ id: assetId })
    .then((result) => { if (!cancelled) categories = result; })
    .catch(() => { if (!cancelled) categories = []; });

  return () => { cancelled = true; };
});
```

这比 `async` 函数直接在 `$effect` 中使用更安全——当 `asset.id` 变化时，上一次请求的回调会被 `cancelled` 标志丢弃。

##### 展示形式

每个分类以 `Badge` + `Link` 形式展示，点击跳转到智能搜索：
```
[landscape 85%] [nature 72%] [outdoor 45%]
```

#### 7b. 嵌入详情面板

**修改文件**: `web/src/lib/components/asset-viewer/detail-panel.svelte`

- 导入 `DetailPanelCategories` 组件
- 在 tags 区块之后直接渲染 `<DetailPanelCategories {asset} />`（无额外包装器，组件自管 `<section>`）

---

### Phase 8: Web 前端 — 探索页面分类板块

#### 8a. CategoryRepository 新增 `getTopCategoriesWithAsset`

**修改文件**: `server/src/repositories/category.repository.ts`

新增方法用于 Explore 页面获取代表性分类缩略图：

```typescript
@GenerateSql({ params: [DummyValue.UUID, { maxFields: 12, minAssetsPerField: 5 }] })
async getTopCategoriesWithAsset(userId, options)
```

##### 查询设计（CTE + DISTINCT ON）

```sql
WITH top_cats AS (
  -- 步骤1: 筛选有足够资产的分类（HAVING count >= minAssetsPerField）
  SELECT categoryName FROM asset_categories
  INNER JOIN asset ON ...
  WHERE ownerId = ? AND visibility = 'timeline' AND deletedAt IS NULL
  GROUP BY categoryName
  HAVING count(id) >= 5
)
-- 步骤2: 每个分类取置信度最高的图片资产作为缩略图
SELECT DISTINCT ON (categoryName) assetId AS data, categoryName AS value
FROM asset_categories
INNER JOIN asset ON ...
INNER JOIN top_cats ON ...
WHERE type = 'IMAGE'  -- 只取图片（不用视频做缩略图）
ORDER BY categoryName, confidence DESC
LIMIT 12
```

关键过滤条件（经架构审查优化）：
- `visibility = AssetVisibility.Timeline`（而非 `!= Hidden`，排除 `archive` 和 `locked`）
- `type = AssetType.Image`（确保缩略图是图片而非视频）

#### 8b. SearchService `getExploreData()` 重写

**修改文件**: `server/src/services/search.service.ts`

将原来的串行获取城市数据改为并行获取城市 + 分类：

```typescript
const [cities, categories] = await Promise.all([
  this.assetRepository.getAssetIdByCity(auth.user.id, options),
  this.categoryRepository.getTopCategoriesWithAsset(auth.user.id, options).catch((error) => {
    this.logger.warn(`Failed to get categories for explore page: ${error}`);
    return emptyResult;  // 优雅降级：分类查询失败不影响城市展示
  }),
]);
```

资产批量获取优化：
- 合并城市 + 分类的 assetId 列表
- `new Set()` 去重
- `new Map()` O(1) 查找
- 单次 `getByIdsWithAllRelationsButStacks()` 调用

#### 8c. Explore 页面 UI

**修改文件**: `web/src/routes/(user)/explore/+page.svelte`

1. 新增 `categories` 派生状态：`$derived(getFieldItems(data.items, 'category'))`
2. 在 Places 区块后添加 Categories 网格区块（复用 Places 完全相同的 HTML 结构）
3. 分类项链接到 `Route.search({ query: item.value })`（智能搜索）
4. 空状态判断更新：`!hasPeople && places.length === 0 && categories.length === 0`

#### 8d. 单元测试更新

**修改文件**: `server/src/services/search.service.spec.ts`

新增 3 个测试用例：

| 测试 | 说明 |
|------|------|
| `should get assets by city without categories` | 分类为空时只返回城市 |
| `should include categories when available` | 城市 + 分类同时存在的正常场景 |
| `should gracefully handle category query failure` | 分类查询抛异常时优雅降级，仍返回城市 |

---

### Phase 9: i18n 翻译键

**修改文件**: `i18n/en.json`

按字母序在 `"cast_description"` 和 `"change_date"` 之间插入：
```json
"categories": "Categories"
```

---

### Phase 10: ClassificationService 单元测试

**新建文件**: `server/src/services/classification.service.spec.ts`

完全对标 `ocr.service.spec.ts` 的测试模式，使用 `newTestService()` + `ServiceMocks` 框架。

#### 测试用例清单

##### `handleQueueClassification`

| 测试 | 预期结果 | 验证重点 |
|------|----------|----------|
| ML 全局禁用 | `JobStatus.Skipped` | `streamForClassificationJob` 未被调用 |
| classification 单独禁用 | `JobStatus.Skipped` | 同上 |
| 正常入队（非强制） | `JobStatus.Success` | `streamForClassificationJob(false)` + 正确的 job payload |
| 强制重跑 | `JobStatus.Success` | `deleteAll()` 被调用 + `streamForClassificationJob(true)` |

##### `handleClassification`

| 测试 | 预期结果 | 验证重点 |
|------|----------|----------|
| ML 禁用 | `JobStatus.Skipped` | `classifyImage` + `upsert` 均未调用 |
| 资产不存在 | `JobStatus.Failed` | 同上 |
| 资产无预览图 | `JobStatus.Failed` | 同上 |
| Hidden 资产 | `JobStatus.Skipped` | 同上 |
| 正常分类 | `JobStatus.Success` | ML 参数正确、upsert 数据正确、jobStatus 更新 |
| 自定义配置 | `JobStatus.Success` | 配置项（modelName/minScore/maxResults/categories）透传到 ML |
| 空分类结果 | `JobStatus.Success` | 空数组 upsert + jobStatus 更新（不报错） |

---

### 审查优化记录（Phase 6-10）

代码完成后进行了两轮架构级审查，共修复以下问题：

#### 第一轮审查

| # | 问题 | 严重度 | 修复 |
|---|------|--------|------|
| 1 | `$effect` 内使用 `async` 函数，资产快速切换时存在竞态条件 | P0/Bug | 改用 `cancelled` 标志 + cleanup 函数模式 |
| 2 | 内联类型 `Array<{id, categoryName, confidence}>` 而非使用 SDK 类型 | P0/Design | 改用 `AssetCategoryResponseDto[]` |
| 3 | `getTopCategoriesWithAsset` 使用 `visibility != Hidden` | P0/Bug | 改为 `= Timeline`（排除 archive/locked） |
| 4 | 缩略图可能是视频 | P0/UX | 添加 `type = AssetType.Image` 过滤 |
| 5 | 分类查询失败导致 500 | P1/Robustness | 添加 `.catch()` + `logger.warn` 优雅降级 |
| 6 | 共享链接下泄露分类信息 | P2/Security | 添加 `!authManager.isSharedLink` 守卫 |

#### 第二轮审查

| # | 问题 | 严重度 | 修复 |
|---|------|--------|------|
| 1 | detail-panel.svelte 有多余的 `<section>` 包装器 | P1/Pattern | 移除，让组件自管 section |
| 2 | 组件缺少暗黑模式样式和底部间距 | P1/UI | 添加 `dark:bg-immich-dark-bg dark:text-immich-dark-fg` + `pb-12` |
| 3 | 测试描述不准确、缺少正向测试 | P2/Testing | 更新描述 + 添加含分类的正向用例 + 降级测试 |

---

### 新建文件清单（Phase 6-10）

| 文件 | 说明 |
|------|------|
| `web/src/lib/components/asset-viewer/detail-panel-categories.svelte` | 分类标签前端组件 |
| `server/src/services/classification.service.spec.ts` | 分类服务单元测试 |

### 修改文件清单（Phase 6-10）

| 文件 | 修改内容 |
|------|----------|
| `open-api/typescript-sdk/src/fetch-client.ts` | 自动生成 `getAssetCategories()` + `getCategorySummaries()` + DTO 类型 |
| `web/src/lib/components/asset-viewer/detail-panel.svelte` | +导入 + 渲染 `DetailPanelCategories` |
| `server/src/repositories/category.repository.ts` | +`getTopCategoriesWithAsset()` 方法 |
| `server/src/services/search.service.ts` | 重写 `getExploreData()` 并行获取城市+分类 |
| `web/src/routes/(user)/explore/+page.svelte` | +categories 派生状态 + Categories 网格区块 |
| `server/src/services/search.service.spec.ts` | +3 个分类相关测试用例 |
| `i18n/en.json` | +`"categories": "Categories"` |

### 测试状态（Phase 6-10）

| 项目 | 结果 |
|------|------|
| OpenAPI 规范生成 | ✅ `make open-api` 成功 |
| SQL 查询生成 | ⚠️ worktree 环境中 `nest build` 不可用，需完整环境 |
| 单元测试运行 | ⚠️ `pnpm install` OOM（Node 24.4.0 已知问题），需在完整开发环境中运行 |
| 代码结构审查 | ✅ 两轮架构审查，共修复 9 项问题 |

---
# 测试记录

## Phase 1～5: 本地联动测试闭环验证记录（2026-03-13）

### 测试目标

验证“上传照片 → 缩略图生成 → 分类任务 → ML 推理 → 分类入库 → API 可读”的完整闭环在本地开发模式可稳定运行。

### 测试方式与环境

- 启动方式：`scripts/local-dev.sh up`（按要求本地启动，不使用 docker compose 编排服务）
- 核心服务：PostgreSQL + Redis + Machine Learning + API + Web
- 验证路径：
  - 上传：`POST /api/assets`
  - 分类读取：`GET /api/categories/asset/:id`、`GET /api/categories`
  - 状态校验：`asset_job_status.classifiedAt`、`asset_categories` 行数

### 测试过程中的关键问题与修复

| # | 现象 | 根因 | 修复 | 结果 |
|---|------|------|------|------|
| 1 | 初次启动时 ML 就绪检查超时 | 进程启动阶段受终端信号干扰，ML `/ping` 间歇异常 | 采用分离/稳定方式重启本地进程，恢复健康检查 | ✅ |
| 2 | API watch 编译失败（TypeScript） | 分类配置 DTO 接线不完整 + 分类汇总计数类型不匹配 | 补齐 `ClassificationConfig` 与 `system-config` 映射；`count` 强制为 `int` | ✅ |
| 3 | 上传后有分类结果但任务报错、`classifiedAt` 长期为空 | `asset.repository.ts` 的 `upsertJobStatus()` 在仅更新 `classifiedAt` 时冲突更新集合为空，触发 SQL 语法错误 | 在冲突更新集合中加入 `classifiedAt: eb.ref('excluded.classifiedAt')` | ✅ |
| 4 | 反复测试一直命中同一 `assetId`，导致误判修复无效 | 相同文件被去重复用历史资产记录（历史资产可能保留旧状态） | 改为“修改文件校验和后再上传”，强制生成新资产验证闭环 | ✅ |

### 最终联动验证结果

| 项目 | 结果 |
|------|------|
| 闭环结果 | ✅ PASS |
| 验证资产 ID | `9418141e-ce45-4e2f-8f88-a4034344c769` |
| 分类 API 返回数量 | `api_count=1` |
| 数据库分类记录数 | `db_count=1` |
| 分类完成时间戳 | `classified_at=2026-03-13 11:01:58.872+08` |
| 分类示例 | `portrait (0.7543183)` |

### 结论

本次本地联动测试已确认分类闭环正常：新上传资产可自动触发分类任务，结果可写入 `asset_categories`，并正确回填 `asset_job_status.classifiedAt`，同时可通过分类 API 正常读取。

## phase6~8 前端测试

### 修复项：`QueueName.Classification` 映射缺失
- **修改文件**: `web/src/lib/components/admin-settings/JobSettings.svelte`
- **问题现象**: `check:svelte` 报错，`queueTitles: Record<QueueName, string>` 缺少 `QueueName.Classification` 属性
- **修复内容**: 在 `queueTitles` 中新增：`[QueueName.Classification]: $t('categories')`

### 验证结果
- **命令**: `pnpm --filter immich-web run check:svelte`
- **结果**: ✅ `svelte-check found 0 errors and 0 warnings`