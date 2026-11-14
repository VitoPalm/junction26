import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { Hono } from 'hono';
import { createUpload, enqueueJob, getProject, getUpload, markUploadStored, setUploadStatus, withTransaction } from '@junction26/db';
import { objectKeys } from '@junction26/storage';
import type { AppEnv, Deps } from '../context.ts';
import { authorId } from '../auth.ts';
import { ApiError, badRequest, notFound } from '../errors.ts';
import { jobView, param, uploadView, uuid } from '../http.ts';

/** Media types accepted for authoring material, with a content sniff for each. */
export const UPLOAD_TYPES: Record<string, (head: Buffer) => boolean> = {
  'application/pdf': (h) => h.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  'image/gif': (h) => /^GIF8[79]a$/.test(h.subarray(0, 6).toString('latin1')),
  'image/webp': (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP',
  'text/plain': (h) => !h.includes(0),
  'text/markdown': (h) => !h.includes(0),
  'text/csv': (h) => !h.includes(0),
  'application/json': (h) => !h.includes(0),
  'text/html': (h) => !h.includes(0),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (h) => h[0] === 0x50 && h[1] === 0x4b,
};

const SNIFF_BYTES = 16;

export class UploadRejected extends Error {
  readonly status: 413 | 415;
  readonly code: string;
  constructor(status: 413 | 415, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Counts, hashes and sniffs bytes on their way to storage; errors abort the write. */
export class Inspector extends Transform {
  bytes = 0;
  private readonly hash = createHash('sha256');
  private head: Buffer = Buffer.alloc(0);
  private sniffed = false;
  private readonly maxBytes: number;
  private readonly sniff: (head: Buffer) => boolean;

  constructor(maxBytes: number, sniff: (head: Buffer) => boolean) {
    super();
    this.maxBytes = maxBytes;
    this.sniff = sniff;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) return cb(new UploadRejected(413, 'payload_too_large', `Uploads are limited to ${this.maxBytes} bytes`));
    if (!this.sniffed) {
      this.head = Buffer.concat([this.head, chunk]);
      if (this.head.length >= SNIFF_BYTES) {
        const err = this.check();
        if (err) return cb(err);
      }
    }
    this.hash.update(chunk);
    cb(null, chunk);
  }

  override _flush(cb: TransformCallback) {
    if (this.bytes === 0) return cb(new UploadRejected(415, 'empty_upload', 'The upload is empty'));
    cb(this.sniffed ? null : this.check());
  }

  private check(): UploadRejected | null {
    this.sniffed = true;
    return this.sniff(this.head) ? null : new UploadRejected(415, 'content_mismatch', 'The file content does not match its Content-Type');
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}

export function uploadRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  /**
   * Streams one file (raw request body, not multipart) through the API into
   * object storage: `POST /v1/uploads?projectId=<id>&filename=<name>` with the
   * file's Content-Type. Size, type and content are checked while streaming.
   */
  app.post('/', async (c) => {
    const userId = authorId(c);
    const log = c.get('log');
    const max = deps.config.limits.maxUploadBytes;
    const mediaType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const sniff = UPLOAD_TYPES[mediaType];
    if (!sniff) {
      throw new ApiError(415, 'unsupported_media_type', `Supported types: ${Object.keys(UPLOAD_TYPES).join(', ')}`);
    }
    const declared = c.req.header('content-length');
    if (declared !== undefined && Number(declared) > max) {
      throw new ApiError(413, 'payload_too_large', `Uploads are limited to ${max} bytes`);
    }
    const projectId = c.req.query('projectId') ?? null;
    if (projectId !== null) {
      if (!uuid.safeParse(projectId).success || !(await getProject(deps.pool, userId, projectId))) throw notFound('Project');
    }
    const filename = c.req.query('filename')?.slice(0, 255) ?? null;
    const body = c.req.raw.body;
    if (!body) throw badRequest('The request body is empty');

    const id = randomUUID();
    const key = objectKeys.upload(userId, id);
    await createUpload(deps.pool, { id, ownerId: userId, projectId, objectKey: key, filename, mediaType });

    const inspector = new Inspector(max, sniff);
    const source = Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
    const controller = new AbortController();
    const piped = source.pipe(inspector);
    source.on('error', (err) => inspector.destroy(err));
    inspector.on('error', () => controller.abort());
    try {
      await deps.store.put(key, piped, { contentType: mediaType, signal: controller.signal });
      if (inspector.errored) throw inspector.errored;
    } catch (err) {
      const rejected = inspector.errored instanceof UploadRejected ? inspector.errored : err instanceof UploadRejected ? err : null;
      await deps.store.delete(key).catch((e: unknown) => log.warn('could not delete partial upload', { uploadId: id, err: e }));
      await setUploadStatus(deps.pool, id, rejected ? 'rejected' : 'failed', { code: rejected?.code ?? 'storage_error' });
      if (rejected) throw new ApiError(rejected.status, rejected.code, rejected.message);
      log.error('upload to storage failed', { uploadId: id, err });
      throw new ApiError(502, 'storage_unavailable', 'Could not store the file; try again');
    }

    const sha256 = inspector.digest();
    const { upload, job } = await withTransaction(deps.pool, async (tx) => {
      const upload = await markUploadStored(tx, id, inspector.bytes, sha256);
      const { job } = await enqueueJob(tx, { ownerId: userId, projectId, kind: 'prepare_upload', input: { uploadId: id } });
      return { upload, job };
    });
    log.info('upload stored', { uploadId: id, bytes: inspector.bytes, mediaType });
    return c.json({ upload: uploadView(upload), job: jobView(job) }, 201);
  });

  app.get('/:uploadId', async (c) => {
    const upload = await getUpload(deps.pool, authorId(c), param(c, 'uploadId'));
    if (!upload) throw notFound('Upload');
    return c.json({ upload: uploadView(upload) });
  });

  return app;
}
