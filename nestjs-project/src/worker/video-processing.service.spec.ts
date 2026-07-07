import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingService } from './video-processing.service';

jest.mock('node:child_process');

/**
 * Fake ChildProcess emitting a scripted stdout/stderr/close (or error) on the
 * next tick — the spawn boundary the service is unit-tested against.
 */
function fakeChild(opts: {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: Error;
}): childProcess.ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    if (opts.error) {
      child.emit('error', opts.error);
      return;
    }
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.code ?? 0);
  });
  return child as unknown as childProcess.ChildProcess;
}

const spawnMock = childProcess.spawn as jest.Mock;

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: {} },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(VideoProcessingService);
    jest.clearAllMocks();
  });

  describe('buildFfprobeArgs', () => {
    it('requests quiet JSON with format + streams for the input path', () => {
      expect(service.buildFfprobeArgs('/tmp/in.mp4')).toEqual([
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '/tmp/in.mp4',
      ]);
    });
  });

  describe('buildThumbnailArgs', () => {
    it('input-seeks and extracts a single frame, overwriting the output', () => {
      expect(
        service.buildThumbnailArgs('/tmp/in.mp4', '/tmp/t.jpg', 2),
      ).toEqual([
        '-ss',
        '2',
        '-i',
        '/tmp/in.mp4',
        '-frames:v',
        '1',
        '-y',
        '/tmp/t.jpg',
      ]);
    });

    it('defaults the seek offset when none is given', () => {
      const args = service.buildThumbnailArgs('/tmp/in.mp4', '/tmp/t.jpg');
      expect(args.slice(0, 2)).toEqual(['-ss', '1']);
    });
  });

  describe('parseProbe', () => {
    it('extracts rounded duration and technical metadata from ffprobe JSON', () => {
      const json = JSON.stringify({
        format: {
          duration: '12.84',
          bit_rate: '800000',
          format_name: 'mov,mp4,m4a',
        },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            avg_frame_rate: '30/1',
          },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
      });

      const result = service.parseProbe(json);

      expect(result.durationSeconds).toBe(13);
      expect(result.metadata).toEqual({
        formatName: 'mov,mp4,m4a',
        bitRate: 800000,
        video: {
          codec: 'h264',
          width: 1920,
          height: 1080,
          frameRate: '30/1',
        },
        audio: { codec: 'aac' },
      });
    });

    it('yields null duration and null streams when ffprobe omits them', () => {
      const result = service.parseProbe(
        JSON.stringify({ format: {}, streams: [] }),
      );
      expect(result.durationSeconds).toBeNull();
      expect(result.metadata.video).toBeNull();
      expect(result.metadata.audio).toBeNull();
    });
  });

  describe('probe (spawn boundary)', () => {
    it('spawns ffprobe with the built args and parses its stdout', async () => {
      spawnMock.mockReturnValue(
        fakeChild({
          stdout: JSON.stringify({ format: { duration: '5' }, streams: [] }),
        }),
      );

      const result = await service.probe('/tmp/in.mp4');

      expect(spawnMock).toHaveBeenCalledWith(
        'ffprobe',
        service.buildFfprobeArgs('/tmp/in.mp4'),
      );
      expect(result.durationSeconds).toBe(5);
    });

    it('rejects with stderr context when ffprobe exits nonzero', async () => {
      spawnMock.mockReturnValue(fakeChild({ stderr: 'boom', code: 1 }));

      await expect(service.probe('/tmp/in.mp4')).rejects.toThrow(
        /ffprobe exited with code 1: boom/,
      );
    });

    it('rejects when the binary cannot be spawned', async () => {
      spawnMock.mockReturnValue(
        fakeChild({ error: new Error('spawn ffprobe ENOENT') }),
      );

      await expect(service.probe('/tmp/in.mp4')).rejects.toThrow(/ENOENT/);
    });
  });

  describe('extractThumbnail (spawn boundary)', () => {
    it('spawns ffmpeg with the thumbnail args', async () => {
      spawnMock.mockReturnValue(fakeChild({ code: 0 }));

      await service.extractThumbnail('/tmp/in.mp4', '/tmp/t.jpg');

      expect(spawnMock).toHaveBeenCalledWith(
        'ffmpeg',
        service.buildThumbnailArgs('/tmp/in.mp4', '/tmp/t.jpg'),
      );
    });
  });
});
