import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import mailConfig from '../config/mail.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import swaggerConfig from '../config/swagger.config';
import { envValidationSchema } from '../config/env.validation';
import { Channel } from '../channels/entities/channel.entity';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { PROCESS_VIDEO_QUEUE } from '../videos/videos.constants';

/**
 * Root module of the standalone video worker (TD-04). Boots via
 * `NestFactory.createApplicationContext` — no controllers, no HTTP server.
 * Wires only what the processing pipeline needs: config, the Postgres
 * connection + `Video` repository, object storage, and the BullMQ connection
 * to consume the `process-video` queue. Shares the API codebase (same
 * entities, StorageService, config factories, migrations) via DI.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        swaggerConfig,
        storageConfig,
        queueConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // `Video` is what the worker actually queries; `Channel` and `User` are
    // registered only to close `Video`'s relation-metadata graph
    // (Video → Channel ⟷ User). Without them, `autoLoadEntities` can't build
    // the `Video#channel` relation and the connection loops on retry.
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (qc: ConfigType<typeof queueConfig>) => ({
        connection: { host: qc.host, port: qc.port },
      }),
    }),
    BullModule.registerQueue({ name: PROCESS_VIDEO_QUEUE }),
  ],
})
export class WorkerModule {}
