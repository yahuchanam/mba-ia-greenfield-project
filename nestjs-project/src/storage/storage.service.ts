import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { STORAGE_URL_TTL } from './storage.constants';

export interface UploadPartUrl {
  partNumber: number;
  url: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

/**
 * Encapsulates all object-storage access (MinIO in dev, S3 in prod — same
 * client, only env differs). Exposes the multipart-upload primitives (bytes
 * never touch the API) and presigned GET URLs for streaming/download.
 * The source video lives in the `videos` bucket; thumbnails in `thumbnails`.
 */
@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly videosBucket: string;
  private readonly thumbnailsBucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
    this.videosBucket = config.bucketVideos;
    this.thumbnailsBucket = config.bucketThumbnails;
  }

  /** Object key of a video source inside the `videos` bucket. */
  buildSourceKey(publicId: string, ext: string): string {
    return `${publicId}/source.${ext}`;
  }

  /** Object key of a thumbnail inside the `thumbnails` bucket. */
  buildThumbnailKey(publicId: string): string {
    return `${publicId}/thumb.jpg`;
  }

  /** Starts a multipart upload and returns the S3 UploadId. */
  async createMultipartUpload(key: string, contentType?: string): Promise<string> {
    const { UploadId } = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error('S3 did not return an UploadId for the multipart upload');
    }
    return UploadId;
  }

  /** Presigned PUT URLs the client uploads each part to, directly to storage. */
  async getUploadPartUrls(
    key: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<UploadPartUrl[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.s3,
          new UploadPartCommand({
            Bucket: this.videosBucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: STORAGE_URL_TTL.UPLOAD_PART_SECONDS },
        ),
      })),
    );
  }

  /** Assembles the final object from the client-reported parts (PartNumber + ETag). */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  /** Cancels an in-progress multipart upload and discards its parts. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.s3.send(
      new AbortMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /**
   * Presigned GET URL for streaming (inline) or download (attachment).
   * The URL alone bypasses per-request checks while valid, so callers must
   * only issue it after their own auth/visibility check; the short TTL caps
   * the exposure window.
   */
  async getPresignedGetUrl(
    key: string,
    options: {
      attachment?: boolean;
      filename?: string;
      bucket?: string;
    } = {},
  ): Promise<string> {
    const bucket = options.bucket ?? this.videosBucket;
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(options.attachment && {
        ResponseContentDisposition: `attachment; filename="${
          options.filename ?? key.split('/').pop()
        }"`,
      }),
    });
    return getSignedUrl(this.s3, command, {
      expiresIn: STORAGE_URL_TTL.GET_SECONDS,
    });
  }

  /** Bucket that holds thumbnail objects (for callers building GET URLs). */
  get thumbnailsBucketName(): string {
    return this.thumbnailsBucket;
  }
}
