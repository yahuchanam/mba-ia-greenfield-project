import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PROCESS_VIDEO_QUEUE } from '../videos/videos.constants';
import {
  ProcessVideoJobData,
  VideoProcessingService,
} from './video-processing.service';

/**
 * BullMQ consumer of the `process-video` queue (TD-01/TD-04). Delegates the
 * FFmpeg pipeline to VideoProcessingService. On failure it relies on BullMQ's
 * `attempts` + `backoff` retry; only once retries are exhausted (the dead-letter
 * signal) does it write the terminal `failed` status.
 */
@Processor(PROCESS_VIDEO_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly processing: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    this.logger.log(`Processing video ${job.data.publicId} (job ${job.id})`);
    await this.processing.processVideo(job.data);
  }

  /**
   * Fires on every failed attempt. Retries still remaining are transient — the
   * video stays `processing`. Only when `attemptsMade` has reached the configured
   * `attempts` is the job truly dead-lettered, so the terminal `failed` +
   * `error_reason` is written exactly once (TD-08).
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, err: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      this.logger.warn(
        `Attempt ${job.attemptsMade}/${attempts} failed for ${job.data.publicId}: ${err.message}`,
      );
      return;
    }
    this.logger.error(
      `Video ${job.data.publicId} failed after ${attempts} attempts: ${err.message}`,
    );
    await this.processing.markFailed(job.data.videoId, err.message);
  }
}
