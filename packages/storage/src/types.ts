import type { Readable } from 'node:stream';

/**
 * Object storage adapter. Verda S3 in deployments; filesystem or memory for
 * local development and tests. Keys are flat strings using the prefixes in
 * docs/backend-architecture.md ("Object keys").
 *
 * Browsers never reach the store: the API streams every upload and download.
 */
export interface ObjectStore {
  readonly driver: 's3' | 'fs' | 'memory';
  /** Writes the whole body; resolves only after the object is durable. Overwrites. */
  put(key: string, body: Readable | Buffer, options: PutOptions): Promise<void>;
  /** Returns null when the object doesn't exist. */
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<ObjectInfo | null>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** Cheap reachability probe for readiness checks. */
  ping(): Promise<void>;
}

export interface PutOptions {
  contentType: string;
  /** Known length, if any. Streams of unknown length are supported. */
  contentLength?: number;
  /** Aborting cancels an in-flight write; no object is left behind under `key`. */
  signal?: AbortSignal;
}

export interface ObjectInfo {
  contentType: string;
  contentLength: number;
}

export interface StoredObject extends ObjectInfo {
  body: Readable;
}

export function assertValidKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\') || key.length > 1024) {
    throw new Error(`Invalid object key: ${JSON.stringify(key)}`);
  }
}
