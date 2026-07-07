import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_QUEUE,
} from '../videos/videos.constants';
import { WorkerModule } from './worker.module';

/**
 * FFmpeg lives only in the worker image (TD-05), so this suite is a no-op in the
 * lean API container and runs for real inside the video-worker container. The
 * gate keys on both binaries being invokable.
 */
const hasFfmpeg =
  spawnSync('ffprobe', ['-version']).status === 0 &&
  spawnSync('ffmpeg', ['-version']).status === 0;
const describeWithFfmpeg = hasFfmpeg ? describe : describe.skip;

const VIDEOS_BUCKET = process.env.STORAGE_BUCKET_VIDEOS || 'videos';
const THUMBNAILS_BUCKET = process.env.STORAGE_BUCKET_THUMBNAILS || 'thumbnails';

function makeS3(): S3Client {
  return new S3Client({
    endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
    region: process.env.STORAGE_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY || 'streamtube',
      secretAccessKey: process.env.STORAGE_SECRET_KEY || 'streamtube123',
    },
  });
}

describeWithFfmpeg('VideoProcessingService (integration)', () => {
  let moduleRef: TestingModule;
  let videos: Repository<Video>;
  let channels: Repository<Channel>;
  let users: Repository<User>;
  let queue: Queue;
  let s3: S3Client;
  let workDir: string;
  let counter = 0;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    // init() runs onApplicationBootstrap → starts the BullMQ worker consumer.
    await moduleRef.init();

    videos = moduleRef.get(getRepositoryToken(Video));
    channels = moduleRef.get(getRepositoryToken(Channel));
    users = moduleRef.get(getRepositoryToken(User));
    queue = moduleRef.get<Queue>(getQueueToken(PROCESS_VIDEO_QUEUE));
    s3 = makeS3();
    workDir = await mkdtemp(join(tmpdir(), 'video-proc-it-'));

    await videos.query('DELETE FROM "videos"');
    await videos.query('DELETE FROM "channels"');
    await videos.query('DELETE FROM "users"');
  }, 60000);

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await videos?.query('DELETE FROM "videos"');
    await videos?.query('DELETE FROM "channels"');
    await videos?.query('DELETE FROM "users"');
    await moduleRef?.close();
    s3?.destroy();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }, 30000);

  async function seedProcessingVideo(sourceExt: string): Promise<Video> {
    const n = ++counter;
    const user = await users.save(
      users.create({ email: `proc_${n}@example.com`, password: 'hashed' }),
    );
    const channel = await channels.save(
      channels.create({
        name: `Proc Channel ${n}`,
        nickname: `procchan${n}`,
        user_id: user.id,
      }),
    );
    const publicId = `procvid${n}xxxx`.slice(0, 11);
    return videos.save(
      videos.create({
        public_id: publicId,
        title: `Processing ${n}`,
        channel_id: channel.id,
        status: VideoStatus.PROCESSING,
        source_key: `${publicId}/source.${sourceExt}`,
      }),
    );
  }

  async function putSourceObject(key: string, body: Buffer): Promise<void> {
    await s3.send(
      new PutObjectCommand({ Bucket: VIDEOS_BUCKET, Key: key, Body: body }),
    );
  }

  async function waitForStatus(
    publicId: string,
    target: VideoStatus,
    timeoutMs = 30000,
  ): Promise<Video> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await videos.findOne({ where: { public_id: publicId } });
      if (found && found.status === target) return found;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${publicId} to reach ${target}`);
  }

  it('processes a valid source to ready with duration, metadata and thumbnail', async () => {
    const video = await seedProcessingVideo('mp4');

    // Generate a real 2s test video and upload it as the source object.
    const samplePath = join(workDir, `src-${video.public_id}.mp4`);
    const gen = spawnSync('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=15',
      '-pix_fmt',
      'yuv420p',
      '-y',
      samplePath,
    ]);
    expect(gen.status).toBe(0);
    await putSourceObject(
      video.source_key as string,
      await readFile(samplePath),
    );

    await queue.add(PROCESS_VIDEO_JOB, {
      videoId: video.id,
      publicId: video.public_id,
      sourceKey: video.source_key,
    });

    const ready = await waitForStatus(video.public_id, VideoStatus.READY);

    expect(ready.duration_seconds).toBeGreaterThan(0);
    expect(ready.error_reason).toBeNull();
    expect(ready.thumbnail_key).toBe(`${video.public_id}/thumb.jpg`);
    expect(ready.metadata).toMatchObject({
      video: { codec: expect.any(String), width: 320, height: 240 },
    });

    // The thumbnail object is really in the thumbnails bucket.
    const head = await s3.send(
      new GetObjectCommand({
        Bucket: THUMBNAILS_BUCKET,
        Key: ready.thumbnail_key as string,
      }),
    );
    const bytes = await head.Body?.transformToByteArray();
    expect(bytes?.length ?? 0).toBeGreaterThan(0);
  }, 60000);

  it('marks the video failed with an error_reason when the source is invalid', async () => {
    const video = await seedProcessingVideo('mp4');

    // Upload garbage bytes: ffprobe will exit nonzero → processing throws.
    await putSourceObject(
      video.source_key as string,
      Buffer.from('this is definitely not a video'),
    );

    await queue.add(
      PROCESS_VIDEO_JOB,
      {
        videoId: video.id,
        publicId: video.public_id,
        sourceKey: video.source_key,
      },
      { attempts: 2, backoff: { type: 'fixed', delay: 100 } },
    );

    const failed = await waitForStatus(video.public_id, VideoStatus.FAILED);

    expect(failed.error_reason).not.toBeNull();
    expect(failed.thumbnail_key).toBeNull();
  }, 60000);
});
