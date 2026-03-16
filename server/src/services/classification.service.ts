import { Injectable } from '@nestjs/common';
import { JOBS_ASSET_PAGINATION_SIZE } from 'src/constants';
import { OnJob } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetVisibility, JobName, JobStatus, Permission, QueueName } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { JobItem, JobOf } from 'src/types';
import { isClassificationEnabled } from 'src/utils/misc';

@Injectable()
export class ClassificationService extends BaseService {
  @OnJob({ name: JobName.ClassificationQueueAll, queue: QueueName.Classification })
  async handleQueueClassification({ force }: JobOf<JobName.ClassificationQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isClassificationEnabled(machineLearning)) {
      this.logger.debug('Skipping ClassificationQueueAll: classification is disabled');
      return JobStatus.Skipped;
    }

    if (force) {
      await this.categoryRepository.deleteAll();
    }

    let queued = 0;
    let jobs: JobItem[] = [];
    const assets = this.assetJobRepository.streamForClassificationJob(force);

    for await (const asset of assets) {
      jobs.push({ name: JobName.Classification, data: { id: asset.id } });
      queued++;

      if (jobs.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(jobs);
        jobs = [];
      }
    }

    await this.jobRepository.queueAll(jobs);
    this.logger.debug(`Queued ${queued} assets for classification`);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.Classification, queue: QueueName.Classification })
  async handleClassification({ id }: JobOf<JobName.Classification>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isClassificationEnabled(machineLearning)) {
      this.logger.debug(`Skipping classification for asset ${id}: classification is disabled`);
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForClassification(id);
    if (!asset) {
      this.logger.debug(`Failed classification for asset ${id}: asset not found`);
      return JobStatus.Failed;
    }

    if (!asset.previewFile) {
      this.logger.debug(`Failed classification for asset ${id}: preview file not found`);
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      this.logger.debug(`Skipping classification for asset ${id}: asset is hidden`);
      return JobStatus.Skipped;
    }

    const { classification } = machineLearning;
    const results = await this.machineLearningRepository.classifyImage(asset.previewFile, {
      modelName: classification.modelName,
      minScore: classification.minScore,
      maxResults: classification.maxResults,
      categories: classification.categories,
    });

    const categories = results.map((r) => ({
      assetId: id,
      categoryName: r.categoryName,
      confidence: r.confidence,
    }));

    await this.categoryRepository.upsert(id, categories);
    await this.assetRepository.upsertJobStatus({ assetId: id, classifiedAt: new Date() });

    this.logger.debug(`Classified asset ${id} with ${results.length} categories`);
    return JobStatus.Success;
  }

  async getAssetCategories(auth: AuthDto, assetId: string) {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
    return this.categoryRepository.getByAssetId(assetId);
  }

  async getCategorySummaries(auth: AuthDto) {
    return this.categoryRepository.getDistinctCategories(auth.user.id);
  }
}
