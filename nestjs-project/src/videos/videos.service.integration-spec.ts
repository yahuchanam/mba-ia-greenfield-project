import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { PROCESS_VIDEO_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// Full stack: real Postgres (draft persistence) + real MinIO (multipart) +
// real Redis/BullMQ (job actually enqueued). No worker runs, so completed
// jobs stay in the "waiting" state and are asserted directly on the queue.
describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let storage: StorageService;
  let queue: Queue;
  let service: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepo = dataSource.getRepository(Video);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);

    storage = new StorageService(storageConfig());
    const qc = queueConfig();
    queue = new Queue(PROCESS_VIDEO_QUEUE, {
      connection: { host: qc.host, port: qc.port },
    });
    service = new VideosService(videoRepo, storage, queue);
  });

  afterAll(async () => {
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
});
