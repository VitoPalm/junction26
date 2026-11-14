/** Bounded source preparation. Source bytes never become instructions or executable code. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { Agent, request } from 'undici';
import ipaddr from 'ipaddr.js';
import sharp from 'sharp';
import { load } from 'cheerio';
import { unzipSync, strFromU8 } from 'fflate';
import type { ObjectStore } from '@junction26/storage';
import type { Upload } from '@junction26/db';
import type { Part } from '@junction26/model';
import { JobError } from './types.ts';

const exec = promisify(execFile);
export const SOURCE_LIMITS = { bytes: 12 * 1024 * 1024, text: 120000, pages: 24, images: 32, pixels: 40_000_000 };
export interface SourceImage {
  ref: string;
  mediaType: 'image/png';
  data: string;
  source: string;
  width: number;
  height: number;
  attribution?: string;
}
export interface PreparedSource {
  version: 1;
  source: string;
  text: string;
  images: SourceImage[];
  links?: { url: string; label: string }[];
  warnings: string[];
}
export const preparedKey = (u: Upload) => `${u.objectKey}.prepared-v1.json`;

export async function boundedBody(body: AsyncIterable<Uint8Array>, limit = SOURCE_LIMITS.bytes): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit)
      throw new JobError('source_too_large', `Source exceeds ${limit} bytes; upload a smaller excerpt.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function boundedText(text: string): string {
  if (text.length > SOURCE_LIMITS.text)
    throw new JobError('source_too_long', 'Source text is too long. Upload a focused excerpt.');
  return text;
}
export async function imageSource(bytes: Buffer, source: string, ref?: string): Promise<SourceImage> {
  const image = sharp(bytes, { limitInputPixels: SOURCE_LIMITS.pixels, animated: false }).rotate();
  const { data, info } = await image
    .flatten({ background: '#ffffff' })
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    ref: ref ?? `img_${createHash('sha256').update(data).digest('hex').slice(0, 20)}`,
    mediaType: 'image/png',
    data: data.toString('base64'),
    source,
    width: info.width,
    height: info.height,
  };
}
export async function prepareBytes(
  bytes: Buffer,
  mediaType: string,
  source: string,
  ref: string,
  signal?: AbortSignal,
): Promise<PreparedSource> {
  signal?.throwIfAborted();
  const result: PreparedSource = { version: 1, source, text: '', images: [], warnings: [] };
  if (bytes.length > SOURCE_LIMITS.bytes)
    throw new JobError('source_too_large', 'Source is too large; upload a smaller excerpt.');
  if (mediaType.startsWith('image/')) result.images = [await imageSource(bytes, source, ref)];
  else if (mediaType === 'application/pdf') {
    const dir = await mkdtemp(join(tmpdir(), 'j26-source-'));
    try {
      const path = join(dir, 'input.pdf');
      await writeFile(path, bytes);
      const options = { timeout: 30000, maxBuffer: 2 * 1024 * 1024, signal };
      const info = await exec('pdfinfo', [path], options);
      const pages = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]);
      if (!pages || pages > SOURCE_LIMITS.pages)
        throw new JobError(
          'source_page_limit',
          `PDFs support up to ${SOURCE_LIMITS.pages} pages. Upload a focused excerpt.`,
        );
      const text = await exec('pdftotext', ['-layout', path, '-'], options);
      result.text = boundedText(text.stdout);
      await exec('pdftoppm', ['-scale-to', '1200', '-png', '-r', '90', path, join(dir, 'page')], options);
      for (const f of (await readdir(dir))
        .filter((f) => /^page-.*\.png$/.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
        signal?.throwIfAborted();
        const page = Number(/-(\d+)\.png$/.exec(f)?.[1]);
        result.images.push(
          await imageSource(await readFile(join(dir, f)), `${source} page ${page}`, `${ref}_p${page}`),
        );
        if (result.images.reduce((total, image) => total + image.data.length, 0) > 20 * 1024 * 1024)
          throw new JobError(
            'source_context_limit',
            'Rendered PDF pages exceed the source image budget. Upload a smaller excerpt.',
          );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    let entries = 0;
    const files = unzipSync(bytes, {
      filter: (f) => {
        if (++entries > 2000) throw new Error('Word archive has too many entries');
        if (f.name === 'word/document.xml' && f.originalSize > 2 * 1024 * 1024)
          throw new Error('Word document text exceeds expansion limit');
        return f.name === 'word/document.xml';
      },
    });
    if (!files['word/document.xml']) throw new Error('Invalid Word document');
    const $ = load(strFromU8(files['word/document.xml']), { xmlMode: true });
    result.text = boundedText(
      $('*')
        .filter((_, el) => 'tagName' in el && el.tagName === 'w:p')
        .map((_, el) => $(el).text())
        .get()
        .join('\n'),
    );
    result.warnings.push(
      'Word text extracted; embedded drawings and layout are not imported. Upload a PDF to preserve diagrams.',
    );
  } else if (mediaType === 'text/html') {
    const $ = load(bytes.toString('utf8'));
    $('script,style,noscript,nav,footer,header,form,iframe,svg').remove();
    $('br').replaceWith('\n');
    $('p,li,h1,h2,h3,h4,tr,section').append('\n');
    const main = $('main,article').first();
    const region = main.length ? main : $('body');
    result.text = boundedText(
      region
        .text()
        .replace(/[\t ]+/g, ' ')
        .replace(/\n\s*\n/g, '\n')
        .trim(),
    );
    result.links = [];
    region.find('img').each((_, el) => {
      const raw = $(el).attr('src') ?? $(el).attr('data-src');
      if (raw) {
        try {
          result.links!.push({ url: new URL(raw, source).href, label: $(el).attr('alt') ?? 'Source illustration' });
        } catch {}
      }
    });
  } else if (mediaType === 'application/json') {
    const text = boundedText(bytes.toString('utf8'));
    JSON.parse(text);
    result.text = text;
  } else if (mediaType.startsWith('text/')) result.text = boundedText(bytes.toString('utf8'));
  else
    throw new JobError(
      'unsupported_source',
      `Cannot read ${mediaType}; use PDF, image, text, Markdown, CSV, JSON or Word.`,
    );
  return result;
}
export async function prepareUploadSource(
  u: Upload,
  store: ObjectStore,
  signal?: AbortSignal,
): Promise<PreparedSource> {
  const cached = await store.get(preparedKey(u));
  if (cached) return JSON.parse((await boundedBody(cached.body, 32 * 1024 * 1024)).toString());
  const obj = await store.get(u.objectKey);
  if (!obj) throw new JobError('object_missing', 'Source file is missing', { retryable: true });
  let prepared: PreparedSource;
  try {
    prepared = await prepareBytes(await boundedBody(obj.body), u.mediaType, u.filename ?? u.id, u.id, signal);
  } catch (e) {
    if (e instanceof JobError) throw e;
    signal?.throwIfAborted();
    throw new JobError(
      'source_unreadable',
      'Could not read this source. Check that the file is valid and unencrypted.',
    );
  }
  const body = Buffer.from(JSON.stringify(prepared));
  if (body.length > 32 * 1024 * 1024)
    throw new JobError('source_context_limit', 'Prepared source exceeds the cache budget. Upload a smaller excerpt.');
  await store.put(preparedKey(u), body, { contentType: 'application/json', contentLength: body.length, signal });
  return prepared;
}

export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}
export function publicUrl(value: string): URL {
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || !['', '443', '80'].includes(u.port))
    throw new Error('Use a public HTTP(S) URL without credentials or custom ports.');
  if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local'))
    throw new Error('Private source addresses are blocked.');
  return u;
}
// Validate every DNS resolution and pin it to the connection: no DNS-rebinding gap.
const dispatcher = new Agent({
  allowH2: false,
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true })
        .then((records) => {
          if (!records.length || records.some((r) => !publicAddress(r.address)))
            return callback(new Error('Private source addresses are blocked.'), [], undefined as never);
          if (options.all) callback(null, records, undefined as never);
          else callback(null, records[0]!.address, records[0]!.family);
        })
        .catch((e) => callback(e, [], undefined as never));
    },
  },
});
export async function fetchPublic(
  value: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mediaType: string; url: string }> {
  let url = publicUrl(value);
  const timeout = AbortSignal.timeout(20000);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let n = 0; n < 4; n++) {
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (ipaddr.isValid(literal) && !publicAddress(literal)) throw new Error('Private source addresses are blocked.');
    const res = await request(url, {
      dispatcher,
      signal: active,
      headers: {
        'user-agent': 'Junction26/0.1 (personal offline guide source import)',
        accept: 'text/html,application/pdf,image/*,text/plain;q=0.9',
      },
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      res.body.destroy();
      const location = res.headers.location;
      if (typeof location !== 'string') throw new Error('Redirect without location');
      url = publicUrl(new URL(location, url).href);
      continue;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.body.destroy();
      throw new Error(`Source returned HTTP ${res.statusCode}`);
    }
    if (Number(res.headers['content-length']) > SOURCE_LIMITS.bytes) {
      res.body.destroy();
      throw new Error('Source exceeds download limit');
    }
    try {
      return {
        bytes: await boundedBody(res.body),
        mediaType: String(res.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim(),
        url: url.href,
      };
    } finally {
      res.body.destroy();
    }
  }
  throw new Error('Too many source redirects');
}
export function sourceMediaType(bytes: Buffer, declared: string): string {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return declared;
}

export async function readUrl(value: string, signal?: AbortSignal): Promise<PreparedSource> {
  const r = await fetchPublic(value, signal);
  return prepareBytes(
    r.bytes,
    sourceMediaType(r.bytes, r.mediaType),
    r.url,
    `url_${createHash('sha256').update(r.url).digest('hex').slice(0, 16)}`,
    signal,
  );
}
export async function cropImage(
  image: SourceImage,
  box: { left: number; top: number; width: number; height: number },
): Promise<SourceImage> {
  for (const v of Object.values(box))
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error('Crop coordinates must be fractions from 0 to 1');
  if (box.width === 0 || box.height === 0 || box.left + box.width > 1.001 || box.top + box.height > 1.001)
    throw new Error('Crop must be inside the image');
  const bytes = await sharp(Buffer.from(image.data, 'base64'))
    .extract({
      left: Math.floor(box.left * image.width),
      top: Math.floor(box.top * image.height),
      width: Math.max(1, Math.floor(box.width * image.width)),
      height: Math.max(1, Math.floor(box.height * image.height)),
    })
    .png()
    .toBuffer();
  const cropped = await imageSource(bytes, `${image.source} crop ${JSON.stringify(box)}`);
  cropped.attribution = image.attribution;
  return cropped;
}
export function sourceParts(source: PreparedSource, vision: boolean): Part[] {
  return [
    {
      type: 'text',
      text: JSON.stringify({
        source: source.source,
        text: source.text,
        warnings: source.warnings,
        imageCandidates: source.links ?? [],
        images: source.images.map(({ data, ...rest }) => rest),
      }),
    },
    ...source.images.flatMap((i): Part[] =>
      vision
        ? [
            { type: 'text', text: `Source image ref: ${i.ref} (${i.source})` },
            { type: 'image', mediaType: i.mediaType, data: i.data },
          ]
        : [],
    ),
  ];
}
