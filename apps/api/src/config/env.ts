import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    /** Supabase project URL, e.g. https://xyz.supabase.co */
    SUPABASE_URL: z.url(),
    /** Optional legacy HS256 secret. When absent, tokens are verified against the project JWKS. */
    SUPABASE_JWT_SECRET: z.string().min(32).optional(),
    /** Server-only. Used exclusively to delete auth users on account deletion. Never shipped to clients. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().min(3).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
    CORS_ORIGINS: z.string().default(''),
    /** JSON entitlement plans; prices are intentionally not part of the API. */
    ENTITLEMENTS_JSON: z.string().optional(),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  })
  .superRefine((v, ctx) => {
    const s3 = [v.S3_BUCKET, v.S3_ACCESS_KEY_ID, v.S3_SECRET_ACCESS_KEY];
    if (s3.some(Boolean) && !s3.every(Boolean)) {
      ctx.addIssue({
        code: 'custom',
        message: 'S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together',
      });
    }
  });

export type AppEnv = z.infer<typeof schema>;

/** Validates configuration at startup and fails fast with a precise list of problems. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const r = schema.safeParse(source);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.join('.') || '(config)'}: ${i.message}`);
    throw new Error(`Invalid PACE API configuration:\n${lines.join('\n')}\nSee .env.example.`);
  }
  return r.data;
}

export const APP_ENV = Symbol('APP_ENV');
