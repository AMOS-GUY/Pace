import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from '@pace/validation';
import { and, eq } from 'drizzle-orm';
import { type AuthUser, CurrentUser, Public } from '../common/auth';
import { ZodPipe } from '../common/http';
import { APP_ENV, type AppEnv } from '../config/env';
import { type AppDatabase, DB, DB_PING, type DbPing } from '../database/database.module';
import { activities, devices, idempotencyKeys, profiles } from '../database/schema';
import { BackupsModule, BackupsService } from './backups.module';

// ============================================================================ health / version

@Controller()
export class HealthController {
  constructor(@Inject(DB_PING) private readonly ping: DbPing) {}

  @Public()
  @Get('health')
  async health() {
    try {
      await this.ping();
      return { status: 'ok', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ code: 'unhealthy', message: 'Database unavailable' });
    }
  }

  @Public()
  @Get('version')
  version() {
    return { api: 'v1', version: process.env.npm_package_version ?? '0.1.0' };
  }
}

// ============================================================================ devices

const deviceSchema = z.object({
  deviceType: z.enum(['heart_rate_monitor', 'cadence_sensor', 'power_meter', 'watch', 'phone']),
  manufacturer: z.string().max(80).nullable().optional(),
  model: z.string().max(80).nullable().optional(),
  externalIdentifier: z.string().min(1).max(200),
});
type DeviceBody = z.infer<typeof deviceSchema>;

@Controller('devices')
export class DevicesController {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return { items: await this.db.select().from(devices).where(eq(devices.userId, user.id)) };
  }

  @Post()
  async register(@CurrentUser() user: AuthUser, @Body(new ZodPipe(deviceSchema)) body: DeviceBody) {
    const [d] = await this.db
      .insert(devices)
      .values({
        userId: user.id,
        deviceType: body.deviceType,
        manufacturer: body.manufacturer ?? null,
        model: body.model ?? null,
        externalIdentifier: body.externalIdentifier,
        lastConnectedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [devices.userId, devices.externalIdentifier],
        set: { lastConnectedAt: new Date(), model: body.model ?? null },
      })
      .returning();
    return d;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.delete(devices).where(and(eq(devices.id, id), eq(devices.userId, user.id)));
  }
}

// ============================================================================ entitlements

const planSchema = z.object({
  plans: z.record(z.string(), z.object({ features: z.array(z.string()) })),
  defaultPlan: z.string(),
});

/**
 * Configurable entitlements. No prices or purchase logic live here; a store-receipt integration
 * will map purchases to plans in M8. Recording, history and export are never gated.
 */
export const DEFAULT_ENTITLEMENTS = {
  defaultPlan: 'free',
  plans: {
    free: {
      features: [
        'recording',
        'history',
        'basic_analytics',
        'gpx_import_export',
        'manual_backup',
        'cloud_backup',
      ],
    },
  },
};

@Controller('entitlements')
export class EntitlementsController {
  private readonly config: z.infer<typeof planSchema>;
  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.config = env.ENTITLEMENTS_JSON
      ? planSchema.parse(JSON.parse(env.ENTITLEMENTS_JSON))
      : DEFAULT_ENTITLEMENTS;
  }

  @Get()
  get() {
    const plan = this.config.defaultPlan;
    return { plan, features: this.config.plans[plan]?.features ?? [] };
  }
}

// ============================================================================ account

@Injectable()
export class AccountService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly backups: BackupsService,
  ) {}

  /**
   * Permanently deletes all of a user's cloud data, then the Supabase auth user. Data is removed
   * first so a failure never leaves an orphaned account with data still attached.
   */
  async delete(userId: string): Promise<void> {
    if (!this.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new ServiceUnavailableException({
        code: 'account_deletion_unavailable',
        message: 'Account deletion is not configured on this server',
      });
    }
    await this.backups.removeAll(userId);
    await this.db.transaction(async (tx) => {
      await tx.delete(activities).where(eq(activities.userId, userId)); // cascades route points
      await tx.delete(devices).where(eq(devices.userId, userId));
      await tx.delete(profiles).where(eq(profiles.userId, userId));
      await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
    });
    const res = await fetch(new URL(`/auth/v1/admin/users/${userId}`, this.env.SUPABASE_URL), {
      method: 'DELETE',
      headers: {
        apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!res.ok && res.status !== 404) {
      throw new ServiceUnavailableException({
        code: 'auth_delete_failed',
        message: 'Your data was deleted, but removing the login failed. Please retry.',
      });
    }
  }
}

@Controller('account')
export class AccountController {
  constructor(private readonly svc: AccountService) {}

  @Delete()
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser) {
    await this.svc.delete(user.id);
  }
}

@Module({
  imports: [BackupsModule],
  controllers: [HealthController, DevicesController, EntitlementsController, AccountController],
  providers: [AccountService],
})
export class MiscModule {}
