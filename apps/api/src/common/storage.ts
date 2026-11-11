import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppEnv } from '../config/env';

/** S3-compatible object storage port (AWS S3, Cloudflare R2, MinIO, Supabase Storage S3). */
export interface ObjectStorage {
  presignPut(key: string, sizeBytes: number, expiresInSeconds: number): Promise<string>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  /** Size in bytes, or null when the object does not exist. */
  head(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
}

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    env: AppEnv,
  ) {
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
    });
  }
  presignPut(key: string, sizeBytes: number, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentLength: sizeBytes,
        ContentType: 'application/octet-stream',
      }),
      { expiresIn },
    );
  }
  presignGet(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn,
    });
  }
  async head(key: string): Promise<number | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return r.ContentLength ?? 0;
    } catch (e) {
      if (
        (e as { name?: string }).name === 'NotFound' ||
        (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      )
        return null;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Used when storage is not configured: backup endpoints answer 503 instead of failing obscurely. */
export class UnconfiguredStorage implements ObjectStorage {
  private fail(): never {
    throw new Error('Object storage is not configured');
  }
  presignPut(): Promise<string> {
    this.fail();
  }
  presignGet(): Promise<string> {
    this.fail();
  }
  head(): Promise<number | null> {
    this.fail();
  }
  delete(): Promise<void> {
    this.fail();
  }
}

export function storageFactory(env: AppEnv): ObjectStorage {
  return env.S3_BUCKET ? new S3ObjectStorage(env.S3_BUCKET, env) : new UnconfiguredStorage();
}
