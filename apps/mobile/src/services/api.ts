import { loadConfig } from '@/config/env';
import { currentAccessToken } from './auth';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** Parsed error body (e.g. the server copy returned with a version conflict). */
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function isApiConfigured(): boolean {
  const c = loadConfig();
  return c.ok && !!c.config.apiUrl;
}

/** Authenticated JSON client for the PACE API. Identity comes from the bearer token only. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const cfg = loadConfig();
  if (!cfg.ok || !cfg.config.apiUrl)
    throw new ApiError('Cloud services are not configured for this build.', 0, 'not_configured');
  const token = await currentAccessToken();
  if (!token) throw new ApiError('Sign in to use cloud services.', 401, 'unauthenticated');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  const res = await fetch(`${cfg.config.apiUrl.replace(/\/$/, '')}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = json as ({ message?: string; code?: string } & Record<string, unknown>) | null;
    throw new ApiError(
      err?.message ?? `Request failed (${res.status})`,
      res.status,
      err?.code,
      err ?? undefined,
    );
  }
  return json as T;
}
