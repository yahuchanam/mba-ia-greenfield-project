import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

// Exercises the StorageService against the real MinIO from the Compose stack:
// multipart init -> presigned PUT of a part -> complete -> presigned GET.
describe('StorageService (integration, MinIO)', () => {
  let service: StorageService;
  let rawClient: S3Client;
  let bucket: string;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    service = moduleRef.get(StorageService);

    const config = storageConfig();
    bucket = config.bucketVideos;
    rawClient = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  });

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((key) =>
        rawClient
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
          .catch(() => undefined),
      ),
    );
    rawClient.destroy();
  });

  async function uploadSinglePartVideo(
    publicId: string,
    body: string,
  ): Promise<string> {
    const key = service.buildSourceKey(publicId, 'mp4');
    createdKeys.push(key);

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const [{ url }] = await service.getUploadPartUrls(key, uploadId, [1]);

    // The bytes go straight to MinIO via the presigned URL — never through the API.
    const putResponse = await fetch(url, { method: 'PUT', body });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag as string },
    ]);

    return key;
  }

  it('uploads a part via a presigned URL and assembles it on complete', async () => {
    const body = 'fake-video-bytes-for-integration';
    const key = await uploadSinglePartVideo(`stkey${Date.now()}`, body);

    const getUrl = await service.getPresignedGetUrl(key);
    const getResponse = await fetch(getUrl);

    expect(getResponse.status).toBe(200);
    expect(await getResponse.text()).toBe(body);
  });

  it('returns a presigned GET URL that forces attachment disposition', async () => {
    const key = await uploadSinglePartVideo(`stdl${Date.now()}`, 'download-me');

    const downloadUrl = await service.getPresignedGetUrl(key, {
      attachment: true,
      filename: 'my-video.mp4',
    });
    const response = await fetch(downloadUrl);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain(
      'my-video.mp4',
    );
  });

  it('aborts an in-progress multipart upload', async () => {
    const key = service.buildSourceKey(`stab${Date.now()}`, 'mp4');
    const uploadId = await service.createMultipartUpload(key);

    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
  });
});
