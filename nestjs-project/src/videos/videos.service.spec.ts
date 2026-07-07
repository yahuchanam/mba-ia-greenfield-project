import { QueryFailedError, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { PROCESS_VIDEO_JOB } from './videos.constants';
import {
  NotChannelOwnerException,
  UploadAlreadyFinalizedException,
} from './videos.exceptions';
import { VideosService } from './videos.service';

function makeUniqueError(): QueryFailedError {
  const err = new QueryFailedError(
    'INSERT',
    [],
    new Error(),
  ) as QueryFailedError & {
    code?: string;
    detail?: string;
  };
  err.code = '23505';
  err.detail = 'Key (public_id)=(abc) already exists.';
  return err;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  const v = new Video();
  v.id = 'vid-1';
  v.public_id = 'draftPub123';
  v.channel_id = 'channel-1';
  v.title = 'A video';
  v.status = VideoStatus.DRAFT;
  v.upload_id = 'upload-1';
  v.source_key = 'draftPub123/source.mp4';
  v.thumbnail_key = null;
  v.duration_seconds = null;
  v.metadata = null;
  v.error_reason = null;
  v.created_at = new Date();
  v.updated_at = new Date();
  return Object.assign(v, overrides);
}

type RepoMock = jest.Mocked<
  Pick<Repository<Video>, 'create' | 'save' | 'findOne'>
>;

function makeRepo(overrides: Partial<RepoMock> = {}): RepoMock {
  return {
    create: jest.fn((v) => v as Video),
    save: jest.fn(),
    findOne: jest.fn(),
    ...overrides,
  } as RepoMock;
}

function makeStorage(
  overrides: Partial<jest.Mocked<StorageService>> = {},
): jest.Mocked<StorageService> {
  return {
    buildSourceKey: jest.fn(
      (publicId: string, ext: string) => `${publicId}/source.${ext}`,
    ),
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    getUploadPartUrls: jest.fn(),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as jest.Mocked<StorageService>;
}

function makeQueue(): { add: jest.Mock } {
  return { add: jest.fn().mockResolvedValue(undefined) };
}

function makeService(
  repo: RepoMock,
  storage: jest.Mocked<StorageService>,
  queue: { add: jest.Mock },
): VideosService {
  return new VideosService(
    repo as unknown as Repository<Video>,
    storage,
    queue as never,
  );
}

describe('VideosService', () => {
  describe('createDraft', () => {
    it('persists a draft with an ~11-char public_id and returns publicId + uploadId', async () => {
      const repo = makeRepo({
        save: jest.fn().mockImplementation(async (v: Video) => v),
      });
      const storage = makeStorage();
      const queue = makeQueue();
      const service = makeService(repo, storage, queue);

      const result = await service.createDraft('channel-1', {
        title: 'My video',
        filename: 'clip.mp4',
        contentType: 'video/mp4',
      });

      expect(result.publicId).toHaveLength(11);
      expect(result.uploadId).toBe('upload-1');

      const created = repo.create.mock.calls[0][0] as Partial<Video>;
      expect(created.status).toBe(VideoStatus.DRAFT);
      expect(created.channel_id).toBe('channel-1');
      expect(storage.createMultipartUpload).toHaveBeenCalledTimes(1);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('regenerates the public_id on unique collision without erroring the caller', async () => {
      const repo = makeRepo({
        save: jest
          .fn()
          .mockRejectedValueOnce(makeUniqueError())
          .mockImplementation(async (v: Video) => v),
      });
      const storage = makeStorage();
      const service = makeService(repo, storage, makeQueue());

      const result = await service.createDraft('channel-1', {
        title: 'My video',
        filename: 'clip.mp4',
      });

      // attempt 0 insert (throws) + attempt 1 insert + upload_id update = 3 saves
      expect(repo.save).toHaveBeenCalledTimes(3);
      const firstId = (repo.create.mock.calls[0][0] as Partial<Video>)
        .public_id;
      const secondId = (repo.create.mock.calls[1][0] as Partial<Video>)
        .public_id;
      expect(firstId).not.toBe(secondId);
      expect(result.publicId).toBe(secondId);
    });

    it('rethrows non-unique persistence errors', async () => {
      const repo = makeRepo({
        save: jest.fn().mockRejectedValue(new Error('connection lost')),
      });
      const service = makeService(repo, makeStorage(), makeQueue());

      await expect(
        service.createDraft('channel-1', { title: 't', filename: 'a.mp4' }),
      ).rejects.toThrow('connection lost');
    });
  });

  describe('completeUpload', () => {
    it('transitions the video to processing and enqueues a process-video job', async () => {
      const video = makeVideo();
      const repo = makeRepo({
        findOne: jest.fn().mockResolvedValue(video),
        save: jest.fn().mockImplementation(async (v: Video) => v),
      });
      const storage = makeStorage();
      const queue = makeQueue();
      const service = makeService(repo, storage, queue);

      await service.completeUpload('channel-1', 'draftPub123', [
        { partNumber: 1, etag: 'etag-1' },
      ]);

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'draftPub123/source.mp4',
        'upload-1',
        [{ partNumber: 1, etag: 'etag-1' }],
      );
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.upload_id).toBeNull();
      expect(queue.add).toHaveBeenCalledWith(
        PROCESS_VIDEO_JOB,
        {
          videoId: 'vid-1',
          publicId: 'draftPub123',
          sourceKey: 'draftPub123/source.mp4',
        },
        expect.objectContaining({ attempts: 3 }),
      );
    });

    it('throws UploadAlreadyFinalized when the upload is no longer in draft', async () => {
      const video = makeVideo({
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      const repo = makeRepo({ findOne: jest.fn().mockResolvedValue(video) });
      const service = makeService(repo, makeStorage(), makeQueue());

      await expect(
        service.completeUpload('channel-1', 'draftPub123', [
          { partNumber: 1, etag: 'e' },
        ]),
      ).rejects.toBeInstanceOf(UploadAlreadyFinalizedException);
    });
  });

  describe('ownership', () => {
    it('throws NotChannelOwner when the video belongs to another channel', async () => {
      const video = makeVideo({ channel_id: 'other-channel' });
      const repo = makeRepo({ findOne: jest.fn().mockResolvedValue(video) });
      const service = makeService(repo, makeStorage(), makeQueue());

      await expect(
        service.getPartUrls('channel-1', 'draftPub123', [1]),
      ).rejects.toBeInstanceOf(NotChannelOwnerException);
    });
  });
});
