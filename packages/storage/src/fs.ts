import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertValidKey, type ObjectInfo, type ObjectStore, type PutOptions, type StoredObject } from './types.ts';

/**
 * Local-disk store for development, shared by the API and worker processes on
 * one machine. Writes go to a temp file and are renamed into place, so readers
 * never see a partial object. Content type lives in a `.meta.json` sidecar.
 */
export class FsObjectStore implements ObjectStore {
  readonly driver = 'fs' as const;
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertValidKey(key);
    return join(this.root, 'objects', key);
  }

  async put(key: string, body: Readable | Buffer, options: PutOptions): Promise<void> {
    const target = this.path(key);
    const tmpDir = join(this.root, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(tmpDir, randomUUID());
    try {
      const source = Buffer.isBuffer(body) ? Readable.from([body]) : body;
      await pipeline(source, createWriteStream(tmp), { signal: options.signal });
      await writeFile(target + '.meta.json', JSON.stringify({ contentType: options.contentType }));
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const p = this.path(key);
    try {
      const [s, meta] = await Promise.all([stat(p), readFile(p + '.meta.json', 'utf8')]);
      return { contentLength: s.size, contentType: (JSON.parse(meta) as { contentType: string }).contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const info = await this.head(key);
    if (!info) return null;
    return { ...info, body: createReadStream(this.path(key)) };
  }

  async delete(key: string): Promise<void> {
    const p = this.path(key);
    await rm(p, { force: true });
    await rm(p + '.meta.json', { force: true });
  }

  async ping(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }
}
