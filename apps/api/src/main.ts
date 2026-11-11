import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, type AppModuleOptions } from './app.module';
import { loadEnv } from './config/env';

/** Shared HTTP configuration for production and tests. */
export function configureApp(app: INestApplication, corsOrigins: string): void {
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  const origins = corsOrigins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // The mobile app does not need CORS; browsers are only allowed from explicit origins.
  app.enableCors({ origin: origins.length ? origins : false });
  const http = app.getHttpAdapter().getInstance() as {
    disable?: (s: string) => void;
    set?: (k: string, v: unknown) => void;
  };
  http.disable?.('x-powered-by');
  http.set?.('trust proxy', 1);
}

export async function createApp(options: AppModuleOptions): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.create(options), {
    bodyParser: true,
    logger: ['error', 'warn', 'log'],
  });
  configureApp(app, options.env.CORS_ORIGINS);
  return app;
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await createApp({ env });
  await app.listen(env.PORT);
}

if (require.main === module) {
  bootstrap().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
