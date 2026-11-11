import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type NestMiddleware,
  type PipeTransform,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

/** Validates a request part against a Zod schema at the controller boundary. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({
        code: 'validation_error',
        message: 'Request validation failed',
        issues: r.error.issues
          .slice(0, 20)
          .map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return r.data;
  }
}

/** Structured errors: `{ code, message, issues? }`. Internal details never leak to clients. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const obj =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : { message: String(body) };
      res.status(status).json({
        code: typeof obj.code === 'string' ? obj.code : defaultCode(status),
        message: typeof obj.message === 'string' ? obj.message : HttpStatus[status],
        ...(obj.issues ? { issues: obj.issues } : {}),
        // Version conflicts return the caller's own server copy so the client can merge.
        ...(obj.server ? { server: obj.server } : {}),
      });
      return;
    }
    if (exception instanceof ZodError) {
      res.status(400).json({ code: 'validation_error', message: 'Invalid data' });
      return;
    }
    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    );
    res.status(500).json({ code: 'internal_error', message: 'Something went wrong' });
  }
}

function defaultCode(status: number): string {
  return (
    {
      400: 'bad_request',
      401: 'unauthenticated',
      403: 'forbidden',
      404: 'not_found',
      409: 'conflict',
      413: 'too_large',
      429: 'rate_limited',
      503: 'unavailable',
    }[status] ?? 'error'
  );
}

/** Access log without query strings, bodies, tokens or coordinates. */
@Injectable()
export class RequestLogger implements NestMiddleware {
  private readonly logger = new Logger('HTTP');
  use(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    res.on('finish', () => {
      const path = (req.originalUrl ?? req.url).split('?')[0];
      this.logger.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
