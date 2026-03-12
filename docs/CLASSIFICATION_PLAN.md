# 照片自动分类功能实现方案

## Context

给 Immich 相册添加自动分类功能。上传照片后，服务端自动调用 ML 服务进行分类，结果存入数据库并在前端展示。分类算法最终由算法组提供，当前先用 CLIP 零样本分类作为临时方案。开发重点在服务端和 Web 前端。

**方案选择**：
- 算法：CLIP 零样本分类（复用已有 CLIP 模型，无需新增模型）
- 存储：新建独立表 `asset_categories`
- 展示：照片详情侧边栏 + Explore 探索页面
- 分类：场景 + 主题混合（landscape, food, animal, portrait 等 30 个类别）

**核心参考模板**：OCR 功能的完整实现链路（表、仓库、服务、控制器、前端），分类功能的结构与之几乎一一对应。

---

## 架构概览

```
上传照片 → MetadataExtraction → ThumbnailGeneration
  → SmartSearch
  → FaceDetection
  → OCR
  → Classification (新增)  ←── 本方案新增的任务链路
      ↓
  ML 服务 POST /classify
      ↓
  asset_categories 表
      ↓
  前端详情面板 + 探索页面
```

---

## 实现步骤

### Phase 1: ML 服务 — 新增 `/classify` 端点

在 Python FastAPI 服务中新增独立的分类端点，封装所有 ML 逻辑，便于后续算法替换。

**修改文件**: `machine-learning/immich_ml/main.py`

新增 `POST /classify` 端点：
- 接收参数：`image`(文件)、`model_name`(字符串)、`categories`(JSON 数组)、`min_score`(float)、`max_results`(int)
- 复用已有 CLIP visual encoder 计算图像 embedding
- 复用已有 CLIP textual encoder 计算类别文本 embedding（prompt: `"a photo of {category}"`）
- 计算余弦相似度 → softmax 归一化（temperature=100）→ 过滤阈值 → 按 confidence 降序返回
- 返回格式: `{"classification": [{"categoryName": "landscape", "confidence": 0.85}, ...]}`

参考已有端点 `POST /predict` 的模式（第 39-71 行），复用 `model_cache`、`load()`、`run()` 等工具函数。

默认类别列表（30 个）：
```python
DEFAULT_CATEGORIES = [
    "landscape", "portrait", "food", "animal", "architecture",
    "beach", "night", "city", "nature", "sport",
    "flower", "sunset", "mountain", "water", "forest",
    "indoor", "outdoor", "street", "garden", "snow",
    "car", "document", "selfie", "group photo", "pet",
    "wedding", "birthday", "travel", "art", "abstract",
]
```

---

### Phase 2: 数据库 — 新表 + 迁移

#### 2a. 新建表定义

**新建文件**: `server/src/schema/tables/asset-category.table.ts`

参照 `server/src/schema/tables/asset-ocr.table.ts` 的模式：

```typescript
import { Column, ForeignKeyColumn, Generated, PrimaryGeneratedColumn, Table } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table';

@Table('asset_categories')
export class AssetCategoryTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  @Column({ type: 'text' })
  categoryName!: string;

  @Column({ type: 'real' })
  confidence!: number;
}
```

#### 2b. 修改 job status 表

**修改文件**: `server/src/schema/tables/asset-job-status.table.ts`

在现有的 `ocrAt` 列之后新增：
```typescript
@Column({ type: 'timestamp with time zone', nullable: true })
classifiedAt!: Timestamp | null;
```

#### 2c. 注册表到 Schema

**修改文件**: `server/src/schema/index.ts`
- 导入 `AssetCategoryTable`
- 添加到 tables 数组
- 在 `DB` 接口中添加 `asset_categories: AssetCategoryTable`

#### 2d. 创建迁移文件

**新建文件**: `server/src/schema/migrations/<timestamp>-CreateAssetCategories.ts`

```typescript
import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE "asset_categories" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "assetId" uuid NOT NULL,
      "categoryName" text NOT NULL,
      "confidence" real NOT NULL,
      CONSTRAINT "asset_categories_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "asset_categories_assetId_fkey"
        FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX "asset_categories_assetId_idx" ON "asset_categories" ("assetId")`.execute(db);
  await sql`CREATE INDEX "asset_categories_categoryName_idx" ON "asset_categories" ("categoryName")`.execute(db);
  await sql`ALTER TABLE "asset_job_status" ADD COLUMN "classifiedAt" timestamptz`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_job_status" DROP COLUMN "classifiedAt"`.execute(db);
  await sql`DROP TABLE "asset_categories"`.execute(db);
}
```

---

### Phase 3: 服务端核心 — 枚举 + 配置 + 类型

#### 3a. 枚举

**修改文件**: `server/src/enum.ts`

在 `QueueName` 中添加（第 571 行 `Ocr` 之后）：
```typescript
Classification = 'classification',
```

在 `JobName` 中添加（第 657 行 `Ocr` 之后）：
```typescript
// Classification
ClassificationQueueAll = 'ClassificationQueueAll',
Classification = 'Classification',
```

#### 3b. 类型定义

**修改文件**: `server/src/types.ts`

在 `JobItem` 联合类型的 OCR 部分之后（第 385 行附近）添加：
```typescript
// Classification
| { name: JobName.ClassificationQueueAll; data: IBaseJob }
| { name: JobName.Classification; data: IEntityJob }
```

#### 3c. 系统配置

**修改文件**: `server/src/config.ts`

在 `machineLearning` 配置块中添加 `classification` 子配置：
```typescript
classification: {
  enabled: true,
  minScore: 0.15,
  maxResults: 5,
  categories: [
    'landscape', 'portrait', 'food', 'animal', 'architecture',
    'beach', 'night', 'city', 'nature', 'sport',
    'flower', 'sunset', 'mountain', 'water', 'forest',
    'indoor', 'outdoor', 'street', 'garden', 'snow',
    'car', 'document', 'selfie', 'group photo', 'pet',
    'wedding', 'birthday', 'travel', 'art', 'abstract',
  ],
},
```

---

### Phase 4: 服务端 — Repository 层

#### 4a. 新建 CategoryRepository

**新建文件**: `server/src/repositories/category.repository.ts`

参照 `server/src/repositories/ocr.repository.ts` 的模式：

```typescript
@Injectable()
export class CategoryRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getByAssetId(assetId: string) {
    return this.db
      .selectFrom('asset_categories')
      .selectAll('asset_categories')
      .where('asset_categories.assetId', '=', assetId)
      .orderBy('asset_categories.confidence', 'desc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getDistinctCategories(userId: string) {
    return this.db
      .selectFrom('asset_categories')
      .innerJoin('asset', 'asset.id', 'asset_categories.assetId')
      .select('asset_categories.categoryName')
      .select((eb) => eb.fn.count('asset_categories.id').as('count'))
      .where('asset.ownerId', '=', userId)
      .where('asset.deletedAt', 'is', null)
      .groupBy('asset_categories.categoryName')
      .orderBy('count', 'desc')
      .execute();
  }

  upsert(assetId: string, categories: Insertable<AssetCategoryTable>[]) {
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('asset_categories').where('assetId', '=', assetId).execute();
      if (categories.length > 0) {
        await trx.insertInto('asset_categories').values(categories).execute();
      }
    });
  }

  deleteAll() {
    return this.db.deleteFrom('asset_categories').execute();
  }
}
```

#### 4b. ML Repository 新增分类方法

**修改文件**: `server/src/repositories/machine-learning.repository.ts`

新增类型：
```typescript
export type ClassificationResult = { categoryName: string; confidence: number };
export type ClassificationResponse = { classification: ClassificationResult[] };
export type ClassificationOptions = { minScore: number; maxResults: number; categories: string[] };
```

新增方法 `classifyImage`：
- 构建 FormData 发送到 ML 服务 `/classify` 端点
- 复用已有的 `this.config.urls`、`this.isHealthy()`、`this.setHealthy()` 健康检查逻辑
- 参考 `predict()` 方法（第 164-192 行）的 failover 模式，但使用独立的 `/classify` URL

#### 4c. AssetJobRepository 新增查询

**修改文件**: `server/src/repositories/asset-job.repository.ts`

新增两个方法（参照已有的 `streamForOcrJob` 和 `getForOcr` 模式）：
- `streamForClassificationJob(force?)` — 过滤 `classifiedAt IS NULL`
- `getForClassification(id)` — 获取资产 visibility 和 preview file path

#### 4d. 注册 Repository

**修改文件**: `server/src/repositories/index.ts`
- 导入并添加 `CategoryRepository` 到 repositories 数组

**修改文件**: `server/src/services/base.service.ts`
- 在 `BASE_SERVICE_DEPENDENCIES` 数组中添加 `CategoryRepository`（按字母序插入）
- 在 `BaseService` 构造函数参数中添加 `protected categoryRepository: CategoryRepository`（按字母序插入）

---

### Phase 5: 服务端 — Service + Controller + DTO

#### 5a. 分类 DTO

**新建文件**: `server/src/dtos/category.dto.ts`

```typescript
export class AssetCategoryResponseDto {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  assetId!: string;

  @ApiProperty({ type: 'string' })
  categoryName!: string;

  @ApiProperty({ type: 'number', format: 'double' })
  confidence!: number;
}

export class CategorySummaryResponseDto {
  @ApiProperty({ type: 'string' })
  categoryName!: string;

  @ApiProperty({ type: 'string' })
  count!: string;
}
```

#### 5b. ClassificationService

**新建文件**: `server/src/services/classification.service.ts`

完全参照 `server/src/services/ocr.service.ts` 的结构：

```typescript
@Injectable()
export class ClassificationService extends BaseService {
  @OnJob({ name: JobName.ClassificationQueueAll, queue: QueueName.Classification })
  async handleQueueClassification({ force }: JobOf<JobName.ClassificationQueueAll>): Promise<JobStatus> {
    // 1. 检查 isClassificationEnabled(machineLearning)
    // 2. force 时 deleteAll
    // 3. 流式 streamForClassificationJob(force)
    // 4. 批量入队 Classification jobs
  }

  @OnJob({ name: JobName.Classification, queue: QueueName.Classification })
  async handleClassification({ id }: JobOf<JobName.Classification>): Promise<JobStatus> {
    // 1. 检查 isClassificationEnabled
    // 2. getForClassification(id) 获取预览文件
    // 3. 跳过 hidden 资产
    // 4. 调用 machineLearningRepository.classifyImage()
    // 5. categoryRepository.upsert(id, categories)
    // 6. assetRepository.upsertJobStatus({ assetId: id, classifiedAt: new Date() })
  }

  async getAssetCategories(auth: AuthDto, assetId: string) {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
    return this.categoryRepository.getByAssetId(assetId);
  }

  async getCategorySummaries(auth: AuthDto) {
    return this.categoryRepository.getDistinctCategories(auth.user.id);
  }
}
```

工具函数（添加到 `server/src/utils/misc.ts`）：
```typescript
export const isClassificationEnabled = (machineLearning: SystemConfig['machineLearning']) =>
  isMachineLearningEnabled(machineLearning) && machineLearning.classification.enabled;
```

#### 5c. CategoryController

**新建文件**: `server/src/controllers/category.controller.ts`

```typescript
@ApiTags(ApiTag.Search)
@Controller('categories')
export class CategoryController {
  constructor(private service: ClassificationService) {}

  @Get('asset/:id')
  @Authenticated({ permission: Permission.AssetRead })
  getAssetCategories(@Auth() auth: AuthDto, @Param('id') assetId: string) { ... }

  @Get()
  @Authenticated({ permission: Permission.AssetRead })
  getCategorySummaries(@Auth() auth: AuthDto) { ... }
}
```

#### 5d. 接入任务链

**修改文件**: `server/src/services/job.service.ts`

在 `case JobName.AssetGenerateThumbnails:` 的 jobs 数组中添加（第 144-148 行附近）：

```typescript
const jobs: JobItem[] = [
  { name: JobName.SmartSearch, data: item.data },
  { name: JobName.AssetDetectFaces, data: item.data },
  { name: JobName.Ocr, data: item.data },
  { name: JobName.Classification, data: item.data },  // ← 新增
];
```

#### 5e. 注册 Service

**修改文件**: `server/src/services/index.ts`
- 导入并添加 `ClassificationService`

#### 5f. Explore 数据扩展

**修改文件**: `server/src/services/search.service.ts`

在 `getExploreData()` 方法返回结果中新增 `{ fieldName: 'category', items: [...] }`，获取用户的分类汇总，并取每个分类下的代表性资产作为缩略图。

---

### Phase 6: OpenAPI + SQL 重新生成

```bash
make open-api       # 重新生成 OpenAPI spec + TypeScript/Dart SDK
make sql            # 重新生成 SQL 查询参考文件
```

这将自动在 `@immich/sdk` 中生成 `getAssetCategories()` 和 `getCategorySummaries()` 等函数。

---

### Phase 7: Web 前端 — 详情面板

#### 7a. 新建分类组件

**新建文件**: `web/src/lib/components/asset-viewer/detail-panel-categories.svelte`

参照 `web/src/lib/components/asset-viewer/detail-panel-tags.svelte` 的模式：

```svelte
<script lang="ts">
  import { Route } from '$lib/route';
  import { getAssetCategories, type AssetResponseDto } from '@immich/sdk';
  import { Badge, Link, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props { asset: AssetResponseDto; }
  let { asset }: Props = $props();

  let categories = $state<Array<{ id: string; categoryName: string; confidence: number }>>([]);

  $effect(() => { loadCategories(asset.id); });

  const loadCategories = async (assetId: string) => {
    try { categories = await getAssetCategories({ id: assetId }); }
    catch { categories = []; }
  };
</script>

{#if categories.length > 0}
  <section class="px-4 mt-4">
    <div class="flex h-10 w-full items-center justify-between text-sm">
      <Text color="muted">{$t('categories')}</Text>
    </div>
    <section class="flex flex-wrap pt-2 gap-1">
      {#each categories as cat (cat.id)}
        <Badge size="small" shape="round">
          <Link href={Route.search({ query: cat.categoryName })} class="text-light no-underline rounded-full hover:bg-primary-400 px-2">
            {cat.categoryName}
            <span class="text-xs opacity-60">{Math.round(cat.confidence * 100)}%</span>
          </Link>
        </Badge>
      {/each}
    </section>
  </section>
{/if}
```

#### 7b. 嵌入详情面板

**修改文件**: `web/src/lib/components/asset-viewer/detail-panel.svelte`

在 `DetailPanelTags` 组件之后添加 `<DetailPanelCategories {asset} />` 组件。

---

### Phase 8: Web 前端 — 探索页面

**修改文件**: `web/src/routes/(user)/explore/+page.svelte`

1. 新增派生状态：
```typescript
let categories = $derived(getFieldItems(data.items, 'category'));
```

2. 在 Places 区块（第 107 行 `{/if}` ）之后添加 Categories 区块，完全参照 Places 区块的 HTML 结构（缩略图 + 分类名覆盖文字），但链接到搜索页。

3. 修改空状态判断（第 110 行）：
```svelte
{#if !hasPeople && places.length === 0 && categories.length === 0}
```

---

### Phase 9: i18n

**修改文件**: `i18n/en.json`
- 添加 `"categories": "Categories"` 翻译键

---

### Phase 10: 单元测试

**新建文件**: `server/src/services/classification.service.spec.ts`

参照 `server/src/services/ocr.service.spec.ts` 的模式，关键测试用例：
- ML 禁用时 `handleQueueClassification` 返回 `JobStatus.Skipped`
- 正常流程队列资产
- `handleClassification` 调用 ML 并存储结果
- 跳过 hidden 资产
- 资产不存在时返回 `JobStatus.Failed`

**修改文件**: `server/test/utils.ts`
- 为 `CategoryRepository` 添加 mock factory（参照 `OcrRepository` 的 mock 模式）

---

## 关键文件速查表

### 核心参考文件（实现时对照阅读）

| 文件 | 作用 |
|------|------|
| `server/src/services/ocr.service.ts` | **主要模板** — ClassificationService 的完整结构参照 |
| `server/src/repositories/ocr.repository.ts` | CategoryRepository 的模式参照 |
| `server/src/repositories/machine-learning.repository.ts` | 新增 classifyImage 方法 |
| `server/src/schema/tables/asset-ocr.table.ts` | AssetCategoryTable 的模式参照 |
| `server/src/schema/tables/asset-job-status.table.ts` | 添加 classifiedAt 列 |
| `server/src/services/job.service.ts` (第 133-148 行) | 任务链接入点 |
| `server/src/services/base.service.ts` | 注册新 Repository |
| `server/src/enum.ts` (QueueName 第 553 行, JobName 第 583 行) | 枚举添加 |
| `server/src/types.ts` (JobItem 第 288 行) | 类型添加 |
| `web/src/lib/components/asset-viewer/detail-panel-tags.svelte` | 前端分类组件参照 |
| `web/src/routes/(user)/explore/+page.svelte` | 探索页面修改 |
| `machine-learning/immich_ml/main.py` | ML 端点添加 |

### 新建文件清单

| 文件 | 说明 |
|------|------|
| `server/src/schema/tables/asset-category.table.ts` | 表定义 |
| `server/src/schema/migrations/<ts>-CreateAssetCategories.ts` | 迁移 |
| `server/src/repositories/category.repository.ts` | 数据访问 |
| `server/src/dtos/category.dto.ts` | DTO |
| `server/src/services/classification.service.ts` | 业务逻辑 |
| `server/src/controllers/category.controller.ts` | API 端点 |
| `server/src/services/classification.service.spec.ts` | 单元测试 |
| `web/src/lib/components/asset-viewer/detail-panel-categories.svelte` | 前端组件 |

### 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `server/src/enum.ts` | 新增 QueueName + JobName |
| `server/src/types.ts` | 新增 JobItem 类型 |
| `server/src/config.ts` | 新增 classification 配置 |
| `server/src/utils/misc.ts` | 新增 isClassificationEnabled |
| `server/src/repositories/machine-learning.repository.ts` | 新增 classifyImage 方法 |
| `server/src/repositories/asset-job.repository.ts` | 新增 stream/get 方法 |
| `server/src/repositories/index.ts` | 注册 CategoryRepository |
| `server/src/services/base.service.ts` | 注册 CategoryRepository |
| `server/src/services/index.ts` | 注册 ClassificationService |
| `server/src/services/job.service.ts` | 任务链新增 Classification |
| `server/src/services/search.service.ts` | Explore 数据扩展 |
| `server/src/schema/index.ts` | 注册表 |
| `server/src/schema/tables/asset-job-status.table.ts` | 新增 classifiedAt |
| `server/test/utils.ts` | 新增 mock |
| `web/src/lib/components/asset-viewer/detail-panel.svelte` | 嵌入分类组件 |
| `web/src/routes/(user)/explore/+page.svelte` | Categories 区块 |
| `i18n/en.json` | 翻译键 |
| `machine-learning/immich_ml/main.py` | /classify 端点 |

---

## 关键设计决策（便于后续替换算法）

1. **ML 端点隔离**：`/classify` 端点封装所有 ML 逻辑，替换算法只需改 Python 实现
2. **独立配置块**：`machineLearning.classification` 与 CLIP search 配置分离
3. **通用返回格式**：`[{categoryName, confidence}]` — 任何分类算法都能输出
4. **独立表存储**：`asset_categories` 与 Tag 系统解耦，算法替换不影响用户标签
5. **独立队列**：`QueueName.Classification` 可单独暂停/恢复

---

## 验证方法

1. 启动开发环境：`make dev`
2. 运行服务端测试：`pnpm --filter immich run test -- --run src/services/classification.service.spec.ts`
3. 上传照片后检查：
   - 数据库 `asset_categories` 表中有分类结果
   - `asset_job_status.classifiedAt` 被更新
4. 前端验证：
   - 照片详情侧边栏显示分类标签
   - Explore 页面出现 Categories 板块
5. 类型检查：`pnpm --filter immich run check && pnpm --filter immich-web run check:svelte`
6. 代码质量：`pnpm --filter immich run lint:fix && pnpm --filter immich-web run lint:fix`
