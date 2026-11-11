import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Patch,
  Post,
} from '@nestjs/common';
import { profileUpdateSchema, type ProfileUpdate } from '@pace/validation';
import { eq } from 'drizzle-orm';
import { type AuthUser, CurrentUser } from '../common/auth';
import { ZodPipe } from '../common/http';
import { type AppDatabase, DB } from '../database/database.module';
import { profiles } from '../database/schema';

type ProfileRow = typeof profiles.$inferSelect;

function toDto(p: ProfileRow) {
  return {
    id: p.id,
    displayName: p.displayName,
    avatarUrl: p.avatarUrl,
    measurementSystem: p.measurementSystem,
    language: p.language,
    timezone: p.timezone,
    preferredSports: p.preferredSports,
    heightCm: p.heightCm,
    weightKg: p.weightKg,
    weeklyTargetDistanceMeters: p.weeklyTargetDistanceMeters,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const createSchema = profileUpdateSchema.required({ displayName: true });

@Injectable()
export class ProfilesService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async get(userId: string) {
    const [p] = await this.db.select().from(profiles).where(eq(profiles.userId, userId));
    if (!p)
      throw new NotFoundException({
        code: 'profile_not_found',
        message: 'Profile has not been created',
      });
    return toDto(p);
  }

  /** Idempotent: creating an existing profile returns it unchanged. */
  async create(userId: string, input: ProfileUpdate & { displayName: string }) {
    const [p] = await this.db
      .insert(profiles)
      .values({ ...stripUndefined(input), userId, displayName: input.displayName })
      .onConflictDoNothing({ target: profiles.userId })
      .returning();
    return p ? toDto(p) : this.get(userId);
  }

  async update(userId: string, patch: ProfileUpdate) {
    const [p] = await this.db
      .update(profiles)
      .set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(eq(profiles.userId, userId))
      .returning();
    if (!p)
      throw new NotFoundException({
        code: 'profile_not_found',
        message: 'Profile has not been created',
      });
    return toDto(p);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

@Controller()
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Post('auth/profile')
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(createSchema)) body: ProfileUpdate & { displayName: string },
  ) {
    return this.profiles.create(user.id, body);
  }

  @Get('profiles/me')
  me(@CurrentUser() user: AuthUser) {
    return this.profiles.get(user.id);
  }

  @Patch('profiles/me')
  update(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(profileUpdateSchema)) body: ProfileUpdate,
  ) {
    return this.profiles.update(user.id, body);
  }
}

@Module({ controllers: [ProfilesController], providers: [ProfilesService] })
export class ProfilesModule {}
