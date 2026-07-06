import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { nanoid } from 'nanoid';
import { QueryFailedError, Repository } from 'typeorm';
import {
  CompletedPart,
  StorageService,
  UploadPartUrl,
} from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  MAX_PUBLIC_ID_RETRIES,
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTS,
  PROCESS_VIDEO_QUEUE,
  PUBLIC_ID_LENGTH,
} from './videos.constants';
import {
  InvalidMultipartStateException,
  NotChannelOwnerException,
  UploadAlreadyFinalizedException,
  VideoNotFoundException,
} from './videos.exceptions';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & {
    code?: string;
    detail?: string;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}

function extractExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return 'bin';
  return (
    filename
      .slice(dot + 1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'bin'
  );
}

export interface CreateDraftInput {
  title: string;
  filename: string;
  contentType?: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    @InjectQueue(PROCESS_VIDEO_QUEUE)
    private readonly queue: Queue,
  ) {}

  /**
   * Pre-registers the video as a draft and starts a presigned multipart upload.
   * public_id is generated with nanoid and protected by the UNIQUE constraint +
   * regenerate-on-conflict retry (collisions are astronomically rare, but the
   * retry makes the guarantee hard).
   */
  async createDraft(
    channelId: string,
    input: CreateDraftInput,
  ): Promise<{ publicId: string; uploadId: string }> {
    const ext = extractExtension(input.filename);

    for (let attempt = 0; attempt <= MAX_PUBLIC_ID_RETRIES; attempt++) {
      const publicId = nanoid(PUBLIC_ID_LENGTH);
      const sourceKey = this.storage.buildSourceKey(publicId, ext);

      let video: Video;
      try {
        video = await this.videos.save(
          this.videos.create({
            public_id: publicId,
            title: input.title,
            channel_id: channelId,
            status: VideoStatus.DRAFT,
            source_key: sourceKey,
          }),
        );
      } catch (err) {
        if (isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN)) {
          continue; // regenerate a fresh id and retry
        }
        throw err;
      }

      const uploadId = await this.storage.createMultipartUpload(
        sourceKey,
        input.contentType,
      );
      video.upload_id = uploadId;
      await this.videos.save(video);

      return { publicId, uploadId };
    }

    throw new Error('Could not generate a unique public_id after max retries');
  }

  /** Presigned PUT URLs for the given part numbers of an in-progress upload. */
  async getPartUrls(
    channelId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<UploadPartUrl[]> {
    const video = await this.findOwnedInProgress(channelId, publicId);
    return this.storage.getUploadPartUrls(
      video.source_key as string,
      video.upload_id as string,
      partNumbers,
    );
  }

  /** Finalizes the multipart upload, transitions to processing, and enqueues the job. */
  async completeUpload(
    channelId: string,
    publicId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const video = await this.findOwnedInProgress(channelId, publicId);
    if (!parts || parts.length === 0) {
      throw new InvalidMultipartStateException();
    }

    await this.storage.completeMultipartUpload(
      video.source_key as string,
      video.upload_id as string,
      parts,
    );

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.videos.save(video);

    await this.queue.add(
      PROCESS_VIDEO_JOB,
      {
        videoId: video.id,
        publicId: video.public_id,
        sourceKey: video.source_key,
      },
      PROCESS_VIDEO_JOB_OPTS,
    );
  }

  /** Cancels the in-progress multipart upload; the video stays a draft with no upload. */
  async abortUpload(channelId: string, publicId: string): Promise<void> {
    const video = await this.findOwnedInProgress(channelId, publicId);

    await this.storage.abortMultipartUpload(
      video.source_key as string,
      video.upload_id as string,
    );

    video.upload_id = null;
    await this.videos.save(video);
  }

  /**
   * Loads a video that must exist, belong to the caller's channel, and still be
   * an in-progress upload (draft with an active upload_id). Throws the mapped
   * domain exceptions otherwise.
   */
  private async findOwnedInProgress(
    channelId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.videos.findOne({
      where: { public_id: publicId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel_id !== channelId) {
      throw new NotChannelOwnerException();
    }
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new UploadAlreadyFinalizedException();
    }
    return video;
  }
}
