import { AssetFileType, AssetVisibility, ImmichWorker, JobName, JobStatus } from 'src/enum';
import { ClassificationService } from 'src/services/classification.service';
import { AssetFactory } from 'test/factories/asset.factory';
import { systemConfigStub } from 'test/fixtures/system-config.stub';
import { makeStream, newTestService, ServiceMocks } from 'test/utils';

describe(ClassificationService.name, () => {
  let sut: ClassificationService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ClassificationService));

    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
    mocks.assetJob.getForClassification.mockResolvedValue({
      visibility: AssetVisibility.Timeline,
      previewFile: '/uploads/user-id/thumbs/path.jpg',
    });
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleQueueClassification', () => {
    it('should do nothing if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      const result = await sut.handleQueueClassification({ force: false });

      expect(result).toEqual(JobStatus.Skipped);
      expect(mocks.assetJob.streamForClassificationJob).not.toHaveBeenCalled();
    });

    it('should do nothing if classification is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { classification: { enabled: false } },
      });

      const result = await sut.handleQueueClassification({ force: false });

      expect(result).toEqual(JobStatus.Skipped);
      expect(mocks.assetJob.streamForClassificationJob).not.toHaveBeenCalled();
    });

    it('should queue assets without classification', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.streamForClassificationJob.mockReturnValue(makeStream([asset]));

      await sut.handleQueueClassification({ force: false });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.Classification, data: { id: asset.id } },
      ]);
      expect(mocks.assetJob.streamForClassificationJob).toHaveBeenCalledWith(false);
    });

    it('should queue all assets and delete existing categories when forced', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.streamForClassificationJob.mockReturnValue(makeStream([asset]));

      await sut.handleQueueClassification({ force: true });

      expect(mocks.category.deleteAll).toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.Classification, data: { id: asset.id } },
      ]);
      expect(mocks.assetJob.streamForClassificationJob).toHaveBeenCalledWith(true);
    });
  });

  describe('handleClassification', () => {
    it('should do nothing if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);

      expect(await sut.handleClassification({ id: '123' })).toEqual(JobStatus.Skipped);

      expect(mocks.machineLearning.classifyImage).not.toHaveBeenCalled();
      expect(mocks.category.upsert).not.toHaveBeenCalled();
    });

    it('should fail if asset could not be found', async () => {
      mocks.assetJob.getForClassification.mockResolvedValue(void 0);

      expect(await sut.handleClassification({ id: 'non-existent' })).toEqual(JobStatus.Failed);

      expect(mocks.machineLearning.classifyImage).not.toHaveBeenCalled();
      expect(mocks.category.upsert).not.toHaveBeenCalled();
    });

    it('should fail if asset has no preview file', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForClassification.mockResolvedValue({
        visibility: AssetVisibility.Timeline,
        previewFile: null,
      });

      expect(await sut.handleClassification({ id: asset.id })).toEqual(JobStatus.Failed);

      expect(mocks.machineLearning.classifyImage).not.toHaveBeenCalled();
      expect(mocks.category.upsert).not.toHaveBeenCalled();
    });

    it('should skip hidden assets', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).build();
      mocks.assetJob.getForClassification.mockResolvedValue({
        visibility: AssetVisibility.Hidden,
        previewFile: asset.files[0].path,
      });

      expect(await sut.handleClassification({ id: asset.id })).toEqual(JobStatus.Skipped);

      expect(mocks.machineLearning.classifyImage).not.toHaveBeenCalled();
      expect(mocks.category.upsert).not.toHaveBeenCalled();
    });

    it('should classify an asset and store results', async () => {
      const asset = AssetFactory.create();
      mocks.machineLearning.classifyImage.mockResolvedValue([
        { categoryName: 'landscape', confidence: 0.85 },
        { categoryName: 'nature', confidence: 0.72 },
      ]);

      expect(await sut.handleClassification({ id: asset.id })).toEqual(JobStatus.Success);

      expect(mocks.machineLearning.classifyImage).toHaveBeenCalledWith(
        '/uploads/user-id/thumbs/path.jpg',
        expect.objectContaining({
          modelName: 'YOLO26l-cls',
          minScore: 0.15,
          maxResults: 5,
        }),
      );
      expect(mocks.category.upsert).toHaveBeenCalledWith(asset.id, [
        { assetId: asset.id, categoryName: 'landscape', confidence: 0.85 },
        { assetId: asset.id, categoryName: 'nature', confidence: 0.72 },
      ]);
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: asset.id,
        classifiedAt: expect.any(Date),
      });
    });

    it('should apply config settings', async () => {
      const asset = AssetFactory.create();
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          classification: {
            enabled: true,
            modelName: 'YOLO26l-cls-custom',
            minScore: 0.3,
            maxResults: 3,
            categories: ['portrait', 'landscape', 'food'],
          },
        },
      });
      mocks.machineLearning.classifyImage.mockResolvedValue([]);

      expect(await sut.handleClassification({ id: asset.id })).toEqual(JobStatus.Success);

      expect(mocks.machineLearning.classifyImage).toHaveBeenCalledWith(
        '/uploads/user-id/thumbs/path.jpg',
        expect.objectContaining({
          modelName: 'YOLO26l-cls-custom',
          minScore: 0.3,
          maxResults: 3,
          categories: ['portrait', 'landscape', 'food'],
        }),
      );
      expect(mocks.category.upsert).toHaveBeenCalledWith(asset.id, []);
    });

    it('should handle empty classification results', async () => {
      const asset = AssetFactory.create();
      mocks.machineLearning.classifyImage.mockResolvedValue([]);

      expect(await sut.handleClassification({ id: asset.id })).toEqual(JobStatus.Success);

      expect(mocks.category.upsert).toHaveBeenCalledWith(asset.id, []);
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: asset.id,
        classifiedAt: expect.any(Date),
      });
    });
  });
});
