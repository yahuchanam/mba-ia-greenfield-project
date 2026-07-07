import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';

export interface ProcessVideoJobData {
  videoId: string;
  publicId: string;
  sourceKey: string;
}

export interface ProbeResult {
  durationSeconds: number | null;
  metadata: Record<string, unknown>;
}

/** Seek offset (seconds) of the frame grabbed as the thumbnail. */
const THUMBNAIL_TIMESTAMP_SECONDS = 1;

interface FfprobeOutput {
  format?: { duration?: string; bit_rate?: string; format_name?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
  }>;
}

/**
 * Drives FFmpeg via direct `child_process` spawn (TD-05, Option B — zero extra
 * deps, deterministic ffprobe JSON, clean mock boundary). One job: download the
 * source, probe duration/metadata, extract a thumbnail frame, persist the
 * results, and advance the status to `ready` — only after everything is durable,
 * so a partial result never surfaces as `ready`.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
  ) {}

  /** ffprobe arg vector: quiet JSON with container + per-stream details. */
  buildFfprobeArgs(inputPath: string): string[] {
    return [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ];
  }

  /** ffmpeg arg vector: input-seek to `atSeconds`, grab a single frame, overwrite. */
  buildThumbnailArgs(
    inputPath: string,
    outputPath: string,
    atSeconds: number = THUMBNAIL_TIMESTAMP_SECONDS,
  ): string[] {
    return [
      '-ss',
      String(atSeconds),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-y',
      outputPath,
    ];
  }

  /** Parses ffprobe JSON into rounded duration + a compact technical-metadata object. */
  parseProbe(json: string): ProbeResult {
    const probe = JSON.parse(json) as FfprobeOutput;

    const rawDuration = probe.format?.duration;
    const durationSeconds =
      rawDuration != null && !Number.isNaN(Number(rawDuration))
        ? Math.round(Number(rawDuration))
        : null;

    const video = probe.streams?.find((s) => s.codec_type === 'video');
    const audio = probe.streams?.find((s) => s.codec_type === 'audio');

    const metadata: Record<string, unknown> = {
      formatName: probe.format?.format_name ?? null,
      bitRate: probe.format?.bit_rate ? Number(probe.format.bit_rate) : null,
      video: video
        ? {
            codec: video.codec_name ?? null,
            width: video.width ?? null,
            height: video.height ?? null,
            frameRate: video.avg_frame_rate ?? null,
          }
        : null,
      audio: audio ? { codec: audio.codec_name ?? null } : null,
    };

    return { durationSeconds, metadata };
  }

  /** ffprobe → parsed metadata. */
  async probe(inputPath: string): Promise<ProbeResult> {
    const stdout = await this.run('ffprobe', this.buildFfprobeArgs(inputPath));
    return this.parseProbe(stdout);
  }

  /** ffmpeg single-frame extraction to `outputPath`. */
  async extractThumbnail(inputPath: string, outputPath: string): Promise<void> {
    await this.run('ffmpeg', this.buildThumbnailArgs(inputPath, outputPath));
  }

  /**
   * Full pipeline for one job. `ready` is written only after the thumbnail is
   * uploaded and the metadata is persisted, so partial results never surface.
   * A working directory holds the source + thumbnail and is always cleaned up.
   */
  async processVideo(data: ProcessVideoJobData): Promise<void> {
    const workDir = await mkdtemp(join(tmpdir(), `video-${data.publicId}-`));
    const sourcePath = join(workDir, 'source');
    const thumbPath = join(workDir, 'thumb.jpg');
    try {
      await this.storage.downloadToFile(data.sourceKey, sourcePath);

      const { durationSeconds, metadata } = await this.probe(sourcePath);
      await this.extractThumbnail(sourcePath, thumbPath);

      const thumbnailKey = this.storage.buildThumbnailKey(data.publicId);
      await this.storage.putThumbnail(thumbnailKey, await readFile(thumbPath));

      const video = await this.videos.findOne({ where: { id: data.videoId } });
      if (!video) {
        throw new Error(`Video ${data.videoId} not found for ready transition`);
      }
      video.duration_seconds = durationSeconds;
      video.metadata = metadata;
      video.thumbnail_key = thumbnailKey;
      video.status = VideoStatus.READY;
      video.error_reason = null;
      await this.videos.save(video);
      this.logger.log(`Video ${data.publicId} processed and marked ready`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Terminal failure transition (dead-letter handler): `failed` + reason. */
  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videos.update(
      { id: videoId },
      { status: VideoStatus.FAILED, error_reason: reason },
    );
  }

  /**
   * Spawn boundary — the seam unit tests mock. Resolves the child's stdout on a
   * zero exit; rejects with stderr on a nonzero exit or a spawn error (e.g. the
   * binary missing).
   */
  private run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(`${command} exited with code ${code}: ${stderr.trim()}`),
          );
        }
      });
    });
  }
}
