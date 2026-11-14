import { Readable } from 'node:stream';
import { assertValidKey, type ObjectInfo, type ObjectStore, type PutOptions, type StoredObject } from './types.ts';

async function collect(body: Readable | Buffer, signal?: AbortSignal): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    signal?.throwIfAborted();
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** In-process store for tests. Not shared between processes. */
export class MemoryObjectStore implements ObjectStore {
  readonly driver = 'memory' as const;
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();

  async put(key: string, body: Readable | Buffer, options: PutOptions): Promise<void> {
    assertValidKey(key);
    const data = await collect(body, options.signal);
    options.signal?.throwIfAborted();
    this.objects.set(key, { data, contentType: options.contentType });
  }

  async get(key: string): Promise<StoredObject | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: Readable.from([o.data]), contentType: o.contentType, contentLength: o.data.length };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const o = this.objects.get(key);
    return o ? { contentType: o.contentType, contentLength: o.data.length } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async ping(): Promise<void> {}
}

export { collect as readAll };
