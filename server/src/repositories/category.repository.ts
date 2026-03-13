import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetVisibility } from 'src/enum';
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
      .select((eb) => eb.fn.count('asset_categories.id').as('count'))
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

  deleteAll() {
    return sql`TRUNCATE ${sql.table('asset_categories')}`.execute(this.db);
  }
}
