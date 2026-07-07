import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { PROCESS_VIDEO_QUEUE } from '../videos/videos.constants';
import { WorkerModule } from './worker.module';

// Standalone worker context (TD-04): boots the same providers
// `NestFactory.createApplicationContext(WorkerModule)` gives the worker —
// real Postgres + real Redis, no HTTP layer. Proves the DI graph resolves
// storage, the Video repository, and the process-video queue connection.
describe('WorkerModule', () => {
  it('compiles and resolves storage, the Video repository and the queue (no HTTP)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const storage = moduleRef.get(StorageService);
    const videoRepo = moduleRef.get<Repository<Video>>(
      getRepositoryToken(Video),
    );
    const queue = moduleRef.get<Queue>(getQueueToken(PROCESS_VIDEO_QUEUE));

    expect(storage).toBeInstanceOf(StorageService);
    expect(videoRepo).toBeInstanceOf(Repository);
    expect(queue.name).toBe(PROCESS_VIDEO_QUEUE);

    await moduleRef.close();
  }, 30000);
});
