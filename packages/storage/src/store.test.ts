import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FsObjectStore, MemoryObjectStore, readAll, type ObjectStore } from './index.ts';

async function exercise(store: ObjectStore) {
  const key = 'uploads/u1/x/original';
  assert.equal(await store.get(key), null);
  assert.equal(await store.head(key), null);
  await store.put(key, Readable.from([Buffer.from('hel'), Buffer.from('lo')]), { contentType: 'text/plain' });
  assert.deepEqual(await store.head(key), { contentType: 'text/plain', contentLength: 5 });
  const obj = await store.get(key);
  assert.equal((await readAll(obj!.body)).toString(), 'hello');
  await store.put(key, Buffer.from('bye'), { contentType: 'text/markdown' });
  assert.deepEqual(await store.head(key), { contentType: 'text/markdown', contentLength: 3 });
  await store.delete(key);
  await store.delete(key);
  assert.equal(await store.head(key), null);
  await assert.rejects(store.put('../escape', Buffer.from(''), { contentType: 'x' }), /Invalid object key/);
}

test('memory store round trip', async () => {
  await exercise(new MemoryObjectStore());
});

test('fs store round trip leaves no temp files, aborted writes leave nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'j26-store-'));
  try {
    const store = new FsObjectStore(root);
    await exercise(store);
    const controller = new AbortController();
    const slow = new Readable({ read() {} });
    const pending = store.put('a/b', slow, { contentType: 'x', signal: controller.signal });
    slow.push('partial');
    controller.abort();
    await assert.rejects(pending);
    assert.equal(await store.head('a/b'), null);
    assert.deepEqual(await readdir(join(root, 'tmp')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
