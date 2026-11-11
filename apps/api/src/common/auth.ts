import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';
import { APP_ENV, type AppEnv } from '../config/env';

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

export const IS_PUBLIC = 'pace:isPublic';
/** Marks a route as not requiring authentication (health/version only). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** The verified user. Identity is taken from the token only — never from request bodies. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw new UnauthorizedException();
  return req.user;
});

/** Key material for verifying Supabase access tokens; overridable in tests. */
export const JWT_KEY = Symbol('JWT_KEY');
export type JwtKey = Uint8Array | JWTVerifyGetKey;

export function jwtKeyFactory(env: AppEnv): JwtKey {
  if (env.SUPABASE_JWT_SECRET) return new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
  // Asymmetric signing keys (recommended by Supabase): verified against the published JWKS.
  return createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', env.SUPABASE_URL), {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(JWT_KEY) private readonly key: JwtKey,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      throw new UnauthorizedException({ code: 'unauthenticated', message: 'Missing bearer token' });
    const token = header.slice(7).trim();
    try {
      const options = {
        issuer: new URL('/auth/v1', this.env.SUPABASE_URL).toString(),
        audience: 'authenticated',
        algorithms: this.key instanceof Uint8Array ? ['HS256'] : ['ES256', 'RS256'],
        clockTolerance: 30,
      };
      const { payload } =
        this.key instanceof Uint8Array
          ? await jwtVerify(token, this.key, options)
          : await jwtVerify(token, this.key, options);
      if (typeof payload.sub !== 'string' || !UUID.test(payload.sub))
        throw new Error('Invalid subject');
      if (payload.role !== undefined && payload.role !== 'authenticated')
        throw new Error('Invalid role');
      req.user = {
        id: payload.sub.toLowerCase(),
        email: typeof payload.email === 'string' ? payload.email : null,
      };
      return true;
    } catch {
      throw new UnauthorizedException({
        code: 'invalid_token',
        message: 'Invalid or expired token',
      });
    }
  }
}
