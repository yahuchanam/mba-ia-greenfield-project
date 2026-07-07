import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { Channel } from '../src/channels/entities/channel.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

// E2E of the upload handshake (POST /videos, /parts, /complete, /abort).
// The bytes never touch the API; these tests exercise the HTTP contract,
// auth/ownership and domain error codes — not the real part upload.
describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let channelRepo: Repository<Channel>;
  let throttlerStorage: ThrottlerStorageService;

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
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  // Registration creates the user + channel; confirm + login yields a session
  // for a channel owner.
  async function registerConfirmAndLogin(email: string): Promise<string> {
    const password = 'password123';
    const authService = app.get(AuthService);

    const mailService = (authService as any).mailService;

    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return login.body.access_token as string;
  }

  function auth(token: string) {
    return `Bearer ${token}`;
  }

  const validBody = {
    title: 'Holiday clip',
    filename: 'holiday.mp4',
    contentType: 'video/mp4',
  };

  // 1. Criação de rascunho (POST /videos)

  it('creates a draft and starts a multipart upload (201)', async () => {
    const token = await registerConfirmAndLogin('owner@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', auth(token))
      .send(validBody)
      .expect(201);

    expect(res.body.publicId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(res.body.status).toBe('draft');
    expect(res.body.uploadId).toBeTruthy();

    const persisted = await videoRepo.findOne({
      where: { public_id: res.body.publicId },
    });
    const channel = await channelRepo.findOneOrFail({
      where: {},
      order: { created_at: 'ASC' },
    });
    expect(persisted?.status).toBe(VideoStatus.DRAFT);
    expect(persisted?.channel_id).toBe(channel.id);
  });

  it('rejects POST /videos without a session (401)', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(validBody)
      .expect(401);

    const count = await videoRepo.count();
    expect(count).toBe(0);
  });

  it('rejects an invalid body with the error envelope (400)', async () => {
    const token = await registerConfirmAndLogin('owner@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', auth(token))
      .send({ filename: 'x.mp4', contentType: 'video/mp4' })
      .expect(400);

    expect(res.body).toMatchObject({
      statusCode: 400,
      error: expect.any(String),
      message: expect.anything(),
    });
  });

  // 2. Progresso e conclusão do upload

  it('returns 409 UPLOAD_ALREADY_FINALIZED on complete of a finalized upload', async () => {
    const token = await registerConfirmAndLogin('owner@example.com');
    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', auth(token))
      .send(validBody)
      .expect(201);
    const { publicId } = created.body;

    // Abort finalizes the upload without needing real parts.
    await request(app.getHttpServer())
      .post(`/videos/${publicId}/abort`)
      .set('Authorization', auth(token))
      .expect(204);

    const res = await request(app.getHttpServer())
      .post(`/videos/${publicId}/complete`)
      .set('Authorization', auth(token))
      .send({ parts: [{ partNumber: 1, etag: 'etag-1' }] })
      .expect(409);

    expect(res.body.error).toBe('UPLOAD_ALREADY_FINALIZED');
  });

  it('returns 403 FORBIDDEN_NOT_CHANNEL_OWNER on parts for another channel video', async () => {
    const ownerToken = await registerConfirmAndLogin('owner@example.com');
    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', auth(ownerToken))
      .send(validBody)
      .expect(201);
    const { publicId } = created.body;

    const otherToken = await registerConfirmAndLogin('intruder@example.com');
    const res = await request(app.getHttpServer())
      .post(`/videos/${publicId}/parts`)
      .set('Authorization', auth(otherToken))
      .send({ partNumbers: [1] })
      .expect(403);

    expect(res.body.error).toBe('FORBIDDEN_NOT_CHANNEL_OWNER');
  });
});
