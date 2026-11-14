import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { assertValidKey, type ObjectInfo, type ObjectStore, type PutOptions, type StoredObject } from './types.ts';

export interface S3StoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof NoSuchKey ||
    err instanceof NotFound ||
    (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404)
  );
}

/**
 * S3-compatible store (Verda Object Storage, FIN-03). Verda is path-style,
 * has no CORS/ACLs/public buckets and can't create buckets over the S3 API,
 * so the bucket must already exist (see docs/verda.md).
 */
export class S3ObjectStore implements ObjectStore {
  readonly driver = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StoreOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // Verda doesn't document support for the newer default CRC32 checksums.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, body: Readable | Buffer, options: PutOptions): Promise<void> {
    assertValidKey(key);
    // lib-storage switches to multipart for large or unknown-length streams and
    // aborts the multipart upload on failure, so no partial object is published.
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
      },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    const onAbort = () => void upload.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await upload.done();
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    assertValidKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) return null;
      return {
        body: out.Body as Readable,
        contentType: out.ContentType ?? 'application/octet-stream',
        contentLength: out.ContentLength ?? 0,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertValidKey(key);
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { contentType: out.ContentType ?? 'application/octet-stream', contentLength: out.ContentLength ?? 0 };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}
