import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetType, AssetVisibility } from 'src/enum';
import { DB } from 'src/schema';
import { AssetCategoryTable } from 'src/schema/tables/asset-category.table';

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
      .select((eb) => sql<number>`${eb.fn.count('asset_categories.id')}::int`.as('count'))
      .where('asset.ownerId', '=', userId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .groupBy('asset_categories.categoryName')
      .orderBy('count', 'desc')
      .execute();
  }

  @GenerateSql({
    params: [
      DummyValue.UUID,
      [{ assetId: DummyValue.UUID, categoryName: DummyValue.STRING, confidence: DummyValue.NUMBER }],
    ],
  })
  upsert(assetId: string, categories: Insertable<AssetCategoryTable>[]) {
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('asset_categories').where('assetId', '=', assetId).execute();
      if (categories.length > 0) {
        await trx.insertInto('asset_categories').values(categories).execute();
      }
    });
  }

  @GenerateSql({ params: [DummyValue.UUID, { minAssetsPerField: 5 }] })
  async getTopCategoriesWithAsset(userId: string, options: { minAssetsPerField: number }) {
    const items = await this.db
      .with('top_cats', (qb) =>
        qb
          .selectFrom('asset_categories')
          .innerJoin('asset', 'asset.id', 'asset_categories.assetId')
          .select('asset_categories.categoryName')
          .where('asset.ownerId', '=', userId)
          .where('asset.deletedAt', 'is', null)
          .where('asset.visibility', '=', AssetVisibility.Timeline)
          .groupBy('asset_categories.categoryName')
          .having((eb) => eb.fn('count', [eb.ref('asset_categories.id')]), '>=', options.minAssetsPerField),
      )
      .selectFrom('asset_categories')
      .innerJoin('asset', 'asset.id', 'asset_categories.assetId')
      .innerJoin('top_cats', 'top_cats.categoryName', 'asset_categories.categoryName')
      .distinctOn('asset_categories.categoryName')
      .select(['asset_categories.assetId as data', 'asset_categories.categoryName as value'])
      .where('asset.ownerId', '=', userId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('asset.type', '=', AssetType.Image)
      .orderBy('asset_categories.categoryName')
      .orderBy('asset_categories.confidence', 'desc')
      .execute();

    return { fieldName: 'category', items };
  }

  deleteAll() {
    return sql`TRUNCATE ${sql.table('asset_categories')}`.execute(this.db);
  }
}
