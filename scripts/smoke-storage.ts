// Round-trips one small object through the configured S3 store (Verda) using
// the same adapter as the services: put (streamed), head, get, delete, ping.
// Usage: npm run smoke:storage   (reads .env.verda.local)
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { S3ObjectStore, readAll } from '@junction26/storage';

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`${k} is not set`); })();
const store = new S3ObjectStore({
  endpoint: env('AWS_ENDPOINT_URL'),
  region: env('AWS_REGION'),
  bucket: env('VERDA_S3_BUCKET'),
  accessKeyId: env('AWS_ACCESS_KEY_ID'),
  secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
});
const key = `healthcheck/${randomUUID()}.txt`;
await store.ping();
await store.put(key, Readable.from([Buffer.from('junction26 '), Buffer.from('smoke')]), { contentType: 'text/plain' });
const head = await store.head(key);
const body = (await readAll((await store.get(key))!.body)).toString();
await store.delete(key);
const gone = (await store.head(key)) === null;
console.log(JSON.stringify({ ok: body === 'junction26 smoke' && gone, head, gone }));
