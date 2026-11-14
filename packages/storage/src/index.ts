import { FsObjectStore } from './fs.ts';
import { MemoryObjectStore } from './memory.ts';
import { S3ObjectStore, type S3StoreOptions } from './s3.ts';
import type { ObjectStore } from './types.ts';

export type { ObjectStore, ObjectInfo, PutOptions, StoredObject } from './types.ts';
export { assertValidKey } from './types.ts';
export { FsObjectStore, MemoryObjectStore, S3ObjectStore, type S3StoreOptions };
export { readAll } from './memory.ts';
export { objectKeys } from './keys.ts';

export type StoreConfig = { driver: 'memory' } | { driver: 'fs'; root: string } | ({ driver: 's3' } & S3StoreOptions);

export function createObjectStore(config: StoreConfig): ObjectStore {
  switch (config.driver) {
    case 'memory':
      return new MemoryObjectStore();
    case 'fs':
      return new FsObjectStore(config.root);
    case 's3':
      return new S3ObjectStore(config);
  }
}
