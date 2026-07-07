import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `vidchan${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should default status to draft when not set', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        public_id: 'abc123def456',
        title: 'My draft',
        channel_id: channel.id,
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce unique public_id constraint', async () => {
    const channel = await createChannel();

    await videoRepository.save(
      videoRepository.create({
        public_id: 'dupPublicId',
        title: 'First',
        channel_id: channel.id,
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          public_id: 'dupPublicId',
          title: 'Second',
          channel_id: channel.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should persist all enum status values', async () => {
    const channel = await createChannel();

    for (const status of Object.values(VideoStatus)) {
      const video = await videoRepository.save(
        videoRepository.create({
          public_id: `pid_${status}`,
          title: `Video ${status}`,
          channel_id: channel.id,
          status,
        }),
      );
      expect(video.status).toBe(status);
    }
  });

  it('should cascade-delete videos when the owning channel is removed', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        public_id: 'cascadePid',
        title: 'Cascade me',
        channel_id: channel.id,
      }),
    );

    await channelRepository.delete({ id: channel.id });

    const remaining = await videoRepository.count({
      where: { channel_id: channel.id },
    });
    expect(remaining).toBe(0);
  });
});
