import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import queueConfig from '../config/queue.config';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { PROCESS_VIDEO_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    ChannelsModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (qc: ConfigType<typeof queueConfig>) => ({
        connection: { host: qc.host, port: qc.port },
      }),
    }),
    BullModule.registerQueue({ name: PROCESS_VIDEO_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosModule {}
