import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Entrypoint of the video worker container (TD-04). Boots a Nest standalone
 * application context — no HTTP listener. The BullMQ connection keeps the
 * process alive; `enableShutdownHooks` lets it drain and close cleanly on
 * SIGTERM/SIGINT.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log(
    'Video worker started — consuming the process-video queue',
    'Worker',
  );
}
void bootstrap();
