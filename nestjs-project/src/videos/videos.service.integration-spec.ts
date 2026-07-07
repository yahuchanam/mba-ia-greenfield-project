import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { PROCESS_VIDEO_QUEUE } from './videos.constants';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from './videos.exceptions';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// Full stack: real Postgres + real MinIO (multipart + presign) + real
// Redis/BullMQ. No worker runs, so enqueued jobs stay "waiting".
describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let storage: StorageService;
  let queue: Queue;
  let service: VideosService;
  let rawS3: S3Client;
  let videosBucket: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepo = dataSource.getRepository(Video);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);

    const sc = storageConfig();
    videosBucket = sc.bucketVideos;
    rawS3 = new S3Client({
      endpoint: sc.endpoint,
      region: sc.region,
      forcePathStyle: sc.forcePathStyle,
      credentials: { accessKeyId: sc.accessKey, secretAccessKey: sc.secretKey },
    });

    storage = new StorageService(sc);
    const qc = queueConfig();
    queue = new Queue(PROCESS_VIDEO_QUEUE, {
      connection: { host: qc.host, port: qc.port },
    });
    service = new VideosService(videoRepo, storage, queue);
  });

  afterAll(async () => {
    rawS3.destroy();
    await queue.obliterate({ force: true });
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepo.save(
      userRepo.create({
        email: `vsvc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepo.save(
      channelRepo.create({
        name: `Channel ${counter}`,
        nickname: `vsvc${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('createDraft persists a draft with a unique ~11-char public_id and an uploadId', async () => {
    const channel = await createChannel();

    const { publicId, uploadId } = await service.createDraft(channel.id, {
      title: 'Integration video',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
    });

    expect(publicId).toHaveLength(11);
    expect(uploadId).toBeTruthy();

    const persisted = await videoRepo.findOne({
      where: { public_id: publicId },
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe(VideoStatus.DRAFT);
    expect(persisted?.channel_id).toBe(channel.id);
    expect(persisted?.upload_id).toBe(uploadId);
  });

  it('completeUpload transitions to processing and enqueues a process-video job', async () => {
    const channel = await createChannel();
    const { publicId } = await service.createDraft(channel.id, {
      title: 'To complete',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
    });
    const draft = await videoRepo.findOneOrFail({
      where: { public_id: publicId },
    });

    // Upload one real part directly to MinIO via the presigned URL.
    const [{ url }] = await service.getPartUrls(channel.id, publicId, [1]);
    const put = await fetch(url, { method: 'PUT', body: 'integration-bytes' });
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag') as string;

    await service.completeUpload(channel.id, publicId, [
      { partNumber: 1, etag },
    ]);

    const processed = await videoRepo.findOneOrFail({
      where: { public_id: publicId },
    });
    expect(processed.status).toBe(VideoStatus.PROCESSING);
    expect(processed.upload_id).toBeNull();

    const waiting = await queue.getJobs(['waiting', 'delayed', 'active']);
    const job = waiting.find((j) => j.data.videoId === draft.id);
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({
      videoId: draft.id,
      publicId,
      sourceKey: processed.source_key,
    });
  });

  describe('delivery', () => {
    // Seeds a READY video with its source object actually present in MinIO.
    async function seedReadyVideo(channel: Channel): Promise<Video> {
      const publicId = `rdy${++counter}xxxxx`.slice(0, 11);
      const sourceKey = storage.buildSourceKey(publicId, 'mp4');
      await rawS3.send(
        new PutObjectCommand({
          Bucket: videosBucket,
          Key: sourceKey,
          Body: 'ready-video-bytes',
        }),
      );
      return videoRepo.save(
        videoRepo.create({
          public_id: publicId,
          title: 'Ready video',
          channel_id: channel.id,
          status: VideoStatus.READY,
          source_key: sourceKey,
          duration_seconds: 42,
        }),
      );
    }

    it('getPublicMetadata returns metadata for a ready video', async () => {
      const channel = await createChannel();
      const video = await seedReadyVideo(channel);

      const meta = await service.getPublicMetadata(video.public_id);

      expect(meta).toMatchObject({
        publicId: video.public_id,
        status: VideoStatus.READY,
        durationSeconds: 42,
        channel: { nickname: channel.nickname, name: channel.name },
      });
    });

    it('getPublicMetadata hides a non-owner draft (404)', async () => {
      const channel = await createChannel();
      const draft = await videoRepo.save(
        videoRepo.create({
          public_id: 'draftHidden',
          title: 'Hidden',
          channel_id: channel.id,
          status: VideoStatus.DRAFT,
          source_key: 'draftHidden/source.mp4',
        }),
      );

      await expect(
        service.getPublicMetadata(draft.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('getPublicMetadata lets the owner see their own draft', async () => {
      const channel = await createChannel();
      const draft = await videoRepo.save(
        videoRepo.create({
          public_id: 'draftOwned0',
          title: 'Owned draft',
          channel_id: channel.id,
          status: VideoStatus.DRAFT,
          source_key: 'draftOwned0/source.mp4',
        }),
      );

      const meta = await service.getPublicMetadata(draft.public_id, channel.id);
      expect(meta.status).toBe(VideoStatus.DRAFT);
    });

    it('getStreamUrl returns a working presigned URL for a ready video', async () => {
      const channel = await createChannel();
      const video = await seedReadyVideo(channel);

      const url = await service.getStreamUrl(video.public_id);
      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ready-video-bytes');
    });

    it('getStreamUrl throws VideoNotReady for a processing video', async () => {
      const channel = await createChannel();
      const video = await videoRepo.save(
        videoRepo.create({
          public_id: 'processing0',
          title: 'Processing',
          channel_id: channel.id,
          status: VideoStatus.PROCESSING,
          source_key: 'processing0/source.mp4',
        }),
      );

      await expect(
        service.getStreamUrl(video.public_id),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
    });

    it('getDownloadUrl returns an attachment URL for a ready video', async () => {
      const channel = await createChannel();
      const video = await seedReadyVideo(channel);

      const url = await service.getDownloadUrl(video.public_id);
      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('attachment');
    });
  });
});
