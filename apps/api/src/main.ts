import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  configureApp(app);

  // Process-level, so deliberately not in configureApp: this is what lets PrismaService
  // disconnect cleanly on a signal.
  app.enableShutdownHooks();

  const port = app.get(ConfigService).get<number>('PORT', 3001);
  await app.listen(port, '0.0.0.0');

  Logger.log(`API listening on http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
