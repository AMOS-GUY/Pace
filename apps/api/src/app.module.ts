import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type Provider,
  type Type,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard, JWT_KEY, jwtKeyFactory } from './common/auth';
import { ErrorFilter, RequestLogger } from './common/http';
import { OBJECT_STORAGE, storageFactory } from './common/storage';
import { APP_ENV, type AppEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { ActivitiesModule } from './modules/activities.module';
import { BackupsModule } from './modules/backups.module';
import { MiscModule } from './modules/misc.module';
import { ProfilesModule } from './modules/profiles.module';

@Module({})
class ConfigModule {
  static forRoot(env: AppEnv): DynamicModule {
    const providers: Provider[] = [
      { provide: APP_ENV, useValue: env },
      { provide: JWT_KEY, useFactory: () => jwtKeyFactory(env) },
      { provide: OBJECT_STORAGE, useFactory: () => storageFactory(env) },
    ];
    return { module: ConfigModule, global: true, providers, exports: providers };
  }
}

export interface AppModuleOptions {
  env: AppEnv;
  /** Test seam: replace the database module (e.g. PGlite). */
  database?: DynamicModule | Type<unknown>;
}

@Module({})
export class AppModule implements NestModule {
  static create({ env, database = DatabaseModule }: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: env.RATE_LIMIT_PER_MINUTE }]),
        database,
        ProfilesModule,
        ActivitiesModule,
        BackupsModule,
        MiscModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLogger).forRoutes('*path');
  }
}
