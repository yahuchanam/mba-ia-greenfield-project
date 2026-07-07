import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { Channel } from '../src/channels/entities/channel.entity';
import { User } from '../src/users/entities/user.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

// E2E of the delivery endpoints (metadata, streaming, download). All scenarios
// are anonymous, so videos are seeded directly via repositories.
describe('Videos delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let channelRepo: Repository<Channel>;
  let userRepo: Repository<User>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepo = dataSource.getRepository(Video);
    channelRepo = dataSource.getRepository(Channel);
    userRepo = dataSource.getRepository(User);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function seedChannel(): Promise<Channel> {
    const user = await userRepo.save(
      userRepo.create({
        email: `del_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepo.save(
      channelRepo.create({
        name: `Channel ${counter}`,
        nickname: `delchan${counter}`,
        user_id: user.id,
      }),
    );
  }

  async function seedVideo(
    channel: Channel,
    status: VideoStatus,
  ): Promise<Video> {
    const publicId = `del${++counter}yyyyy`.slice(0, 11);
    return videoRepo.save(
      videoRepo.create({
        public_id: publicId,
        title: `Video ${status}`,
        channel_id: channel.id,
        status,
        source_key: `${publicId}/source.mp4`,
        duration_seconds: status === VideoStatus.READY ? 30 : null,
      }),
    );
  }

  // 1. Streaming (GET /videos/:publicId/stream)

  it('returns a presigned URL streaming a ready video (200)', async () => {
    const channel = await seedChannel();
    const video = await seedVideo(channel, VideoStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/stream`)
      .expect(200);

    expect(typeof res.body.url).toBe('string');
    expect(res.body.url).toContain(video.public_id);
  });

  it('returns 409 VIDEO_NOT_READY streaming a processing video', async () => {
    const channel = await seedChannel();
    const video = await seedVideo(channel, VideoStatus.PROCESSING);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/stream`)
      .expect(409);

    expect(res.body.error).toBe('VIDEO_NOT_READY');
  });

  // 2. Download (GET /videos/:publicId/download)

  it('returns 401 downloading without a session', async () => {
    const channel = await seedChannel();
    const video = await seedVideo(channel, VideoStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/download`)
      .expect(401);

    expect(res.body.url).toBeUndefined();
  });

  // 3. Metadados e visibilidade (GET /videos/:publicId)

  it('returns 404 VIDEO_NOT_FOUND for a third-party draft', async () => {
    const channel = await seedChannel();
    const video = await seedVideo(channel, VideoStatus.DRAFT);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}`)
      .expect(404);

    expect(res.body.error).toBe('VIDEO_NOT_FOUND');
  });
});
