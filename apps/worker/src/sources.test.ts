import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import sharp from 'sharp';
import {
  boundedBody,
  cropImage,
  imageSource,
  prepareBytes,
  publicAddress,
  publicUrl,
  sourceMediaType,
} from './sources.ts';
import { AuthoringSources } from './authoring-tools.ts';

test('source fetch rejects private IPv4, IPv6 and mapped addresses', () => {
  for (const address of [
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('1.1.1.1'), true);
  for (const url of [
    'file:///etc/passwd',
    'http://user:password@example.com',
    'http://localhost/',
    'http://example.com:8080/',
  ])
    assert.throws(() => publicUrl(url));
});
test('bounded reads reject oversized content even without Content-Length', async () => {
  async function* chunks() {
    yield Buffer.alloc(10);
    yield Buffer.alloc(10);
  }
  await assert.rejects(boundedBody(chunks(), 15), /exceeds/);
});
test('HTML import removes executable and navigation content and exposes image candidates', async () => {
  const r = await prepareBytes(
    Buffer.from(
      '<html><body><nav>irrelevant</nav><main><h1>Pattern</h1><p>Cast on 24.</p><script>evil()</script><img src="/step.png" alt="Step 1"></main></body></html>',
    ),
    'text/html',
    'https://example.com/guide',
    'test',
  );
  assert.match(r.text, /Cast on 24/);
  assert.doesNotMatch(r.text, /evil|irrelevant/);
  assert.deepEqual(r.links, [{ url: 'https://example.com/step.png', label: 'Step 1' }]);
});
test('Word import extracts paragraphs and refuses malformed archives', async () => {
  const bytes = Buffer.from(
    zipSync({
      'word/document.xml': strToU8(
        '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Cast on 24.</w:t></w:r></w:p><w:p><w:r><w:t>Knit 4 rows.</w:t></w:r></w:p></w:body></w:document>',
      ),
    }),
  );
  const r = await prepareBytes(
    bytes,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'pattern.docx',
    'word',
  );
  assert.equal(r.text, 'Cast on 24.\nKnit 4 rows.');
  assert.equal(r.warnings.length, 1);
  await assert.rejects(
    prepareBytes(
      Buffer.from('bad'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'bad.docx',
      'word',
    ),
  );
});
test('image refs hydrate only trusted source bytes; crops preserve provenance', async () => {
  const bytes = await sharp({ create: { width: 100, height: 80, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  const source = await imageSource(bytes, 'manual page 1', 'source_1');
  const crop = await cropImage(source, { left: 0.1, top: 0.1, width: 0.5, height: 0.5 });
  assert.equal(crop.width, 50);
  assert.equal(crop.height, 40);
  assert.match(crop.source, /manual page 1 crop/);
  const ctx = new AuthoringSources(true, new AbortController().signal);
  ctx.add({ version: 1, source: 'manual', text: '', images: [source], warnings: [] });
  const def: any = { assets: [{ id: 'diagram', uploadId: 'source_1', mediaType: 'image/jpeg', data: 'untrusted' }] };
  assert.deepEqual(ctx.resolve(def, null), []);
  assert.equal(def.assets[0].data, source.data);
  assert.equal(def.assets[0].mediaType, 'image/png');
  assert.equal(ctx.resolve({ assets: [{ id: 'stolen', uploadId: 'another_owner' }] } as any, null).length, 1);
  await assert.rejects(cropImage(source, { left: 0.7, top: 0, width: 0.5, height: 1 }));
});

test('remote binary sources use known magic bytes when a server sends a generic MIME type', () => {
  assert.equal(sourceMediaType(Buffer.from('%PDF-1.7'), 'application/octet-stream'), 'application/pdf');
  assert.equal(sourceMediaType(Buffer.from('hello'), 'text/plain'), 'text/plain');
});
