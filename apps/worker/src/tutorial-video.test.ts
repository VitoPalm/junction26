import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, truncate, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { downloadYoutube, probeTutorial, renderTutorialGifs, tutorialStoryboard, validateTutorialPlan, youtubeUrl } from './tutorial-video.ts';
import { prepareBytes, sourceParts, cropImage } from './sources.ts';
import { AuthoringSources } from './authoring-tools.ts';
import { validateDefinition } from '@junction26/applet-format';

test('YouTube links canonicalize one video and reject foreign URLs/playlists/credentials', () => {
  for (const url of ['https://youtu.be/abcdefghijk?t=10', 'https://www.youtube.com/watch?v=abcdefghijk&list=example', 'https://youtube.com/shorts/abcdefghijk'])
    assert.equal(youtubeUrl(url), 'https://www.youtube.com/watch?v=abcdefghijk');
  for (const url of ['https://youtube.com.evil.test/watch?v=abcdefghijk', 'https://user@youtube.com/watch?v=abcdefghijk', 'http://youtube.com/watch?v=abcdefghijk', 'https://youtube.com/playlist?list=example', 'file:///tmp/video', 'https://youtube.com:9000/watch?v=abcdefghijk'])
    assert.throws(() => youtubeUrl(url));
});

test('storyboard decodes every frame of a very short low-FPS source without upscaling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'j26-short-video-'));
  try {
    const path = join(dir, 'short.mp4');
    await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=2:duration=0.5', '-c:v', 'mpeg4', '-threads', '1', path]);
    const result = await tutorialStoryboard(path, dir);
    assert.equal(result.frames.length, 12);
    for (const frame of result.frames) {
      const meta = await sharp(await readFile(join(dir, frame.file))).metadata();
      assert.equal(meta.width, 64);
      assert.equal(meta.height, 48);
      assert.equal(frame.seconds, 0, 'one-frame source must not claim unseen timestamps');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('YouTube downloader requests video-only formats and ignores playlists/configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'j26-downloader-'));
  const previous = process.env.YT_DLP_PATH;
  try {
    const source = join(dir, 'fixture.mp4');
    await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=4:duration=1', '-c:v', 'mpeg4', '-threads', '1', source]);
    const downloader = join(dir, 'downloader.mjs');
    const captured = join(dir, 'arguments.json');
    await writeFile(downloader, `#!/usr/bin/env node
import {copyFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
writeFileSync(${JSON.stringify(captured)},JSON.stringify(args));
if(!args[args.indexOf('-f')+1].startsWith('bestvideo[')) process.exit(1);
copyFileSync(${JSON.stringify(source)},args[args.indexOf('-o')+1]);
`, { mode: 0o700 });
    process.env.YT_DLP_PATH = downloader;
    const result = await downloadYoutube('https://youtu.be/abcdefghijk?list=unwanted', dir);
    assert.equal((await probeTutorial(result)).duration, 1);
    const args = JSON.parse(await readFile(captured, 'utf8'));
    assert.ok(args.includes('--ignore-config'));
    assert.ok(args.includes('--no-playlist'));
    assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=abcdefghijk');
    assert.equal(args.at(-2), '--');
  } finally {
    if (previous === undefined) delete process.env.YT_DLP_PATH; else process.env.YT_DLP_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('probe refuses corrupt, audio-only, oversized and over-duration sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'j26-invalid-video-'));
  try {
    const path = join(dir, 'source');
    await writeFile(path, 'not a video');
    await assert.rejects(probeTutorial(path));
    await truncate(path, 128 * 1024 * 1024 + 1);
    await assert.rejects(probeTutorial(path), /128 MiB/);
    const audio = join(dir, 'audio.wav');
    await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', audio]);
    await assert.rejects(probeTutorial(audio), /finite video/);
    const long = join(dir, 'long.mp4');
    await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=16x16:rate=1:duration=721', '-c:v', 'mpeg4', '-threads', '1', long]);
    await assert.rejects(probeTutorial(long), /12 minutes/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('portrait crops preserve aspect ratio, loop duration and the 96-frame boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'j26-crop-video-'));
  try {
    const path = join(dir, 'source.mp4');
    await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=80x120:rate=12:duration=9', '-c:v', 'mpeg4', '-threads', '1', path]);
    for (const [id, start, end, fps] of [['short', 0, 0.5, 4], ['long', 1, 9, 12]] as const) {
      const result = await renderTutorialGifs(path, { clips: [{ id, start, end, fps, width: 120, label: 'Crop', crop: { left: 0.25, top: 0, width: 0.5, height: 1 } }] }, dir);
      const meta = await sharp(await readFile(join(dir, result.clips[0]!.file)), { animated: true }).metadata();
      assert.equal(meta.width, 40, 'do not upscale small crops');
      assert.equal(meta.pageHeight, 120);
      assert.equal(meta.pages, (end - start) * fps);
      assert.equal(meta.loop, 0);
      assert.ok(Math.abs((meta.delay ?? []).reduce((sum, ms) => sum + ms, 0) - (end - start) * 1000) <= 1000 / fps + 30);
    }
    const before = await readFile(join(dir, 'short.gif'));
    await assert.rejects(renderTutorialGifs(path, { clips: [{ id: 'short', start: 1, end: 2, label: 'Existing output' }] }, dir), /EEXIST/);
    assert.deepEqual(await readFile(join(dir, 'short.gif')), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('one video produces eight distinct independently looping demonstrations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'j26-multi-gif-'));
  try {
    const path = join(dir, 'source.mp4');
    await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x72:rate=8:duration=9', '-c:v', 'mpeg4', '-threads', '1', path]);
    const clips = Array.from({ length: 8 }, (_, i) => ({ id: `stage_${i}`, start: i, end: i + 1, label: `Stage ${i}`, width: 120, fps: 4 }));
    const result = await renderTutorialGifs(path, { sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', clips }, dir);
    assert.equal(result.clips.length, 8);
    assert.equal(new Set(result.clips.map(c => c.sha256)).size, 8);
    for (const clip of result.clips) {
      const meta = await sharp(await readFile(join(dir, clip.file)), { animated: true }).metadata();
      assert.equal(meta.loop, 0);
      assert.equal(meta.pages, 4);
      assert.match(clip.source!, new RegExp(`t=${clip.start}$`));
    }
    assert.throws(() => validateTutorialPlan({ clips: [...clips, { ...clips[0], id: 'ninth' }] }, 9));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI failures leave no activated output or staging directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'j26-video-cli-'));
  const script = new URL('../../../scripts/tutorial-video.ts', import.meta.url).pathname;
  try {
    const plan = join(dir, 'invalid.json');
    await writeFile(plan, '{invalid json');
    const output = join(dir, 'failed');
    await assert.rejects(promisify(execFile)(process.execPath, ['--conditions=junction26-source', script, '--input', join(dir, 'missing.mp4'), '--plan', plan, '--out', output]));
    assert.deepEqual(await readdir(dir), ['invalid.json']);
    await mkdir(output);
    await writeFile(join(output, 'keep.txt'), 'existing output');
    await assert.rejects(promisify(execFile)(process.execPath, ['--conditions=junction26-source', script, '--input', 'missing.mp4', '--out', output]), /already exists/);
    assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'existing output');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('untrusted clip plans cannot escape timestamps, crop bounds or IDs', () => {
  const clip = { id: 'stitch', start: 1, end: 3, label: 'Pull through' };
  for (const change of [{ start: -1 }, { end: 12 }, { end: 1 }, { id: '../file' }, { fps: 60 }, { width: 4000 }, { crop: { left: 0.8, top: 0, width: 0.5, height: 1 } }])
    assert.throws(() => validateTutorialPlan({ clips: [{ ...clip, ...change }] }, 10));
  assert.throws(() => validateTutorialPlan({ clips: [clip, clip] }, 10));
  assert.equal(validateTutorialPlan({ clips: [clip] }, 10).clips[0]!.fps, 10);
});

test('real video becomes a bounded looping GIF, survives authoring hydration and is not flattened', async () => {
  const exec = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'j26-video-test-'));
  try {
    const path = join(dir, 'source.mp4');
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=3', '-c:v', 'mpeg4', '-threads', '1', path]);
    const result = await renderTutorialGifs(path, { sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', clips: [{ id: 'stitch', start: 0.5, end: 2.5, label: 'One complete stitch' }] }, dir);
    assert.ok(result.totalBytes < 512 * 1024);
    const gif = await readFile(join(dir, 'stitch.gif'));
    const meta = await sharp(gif, { animated: true }).metadata();
    assert.equal(meta.loop, 0);
    assert.equal(meta.pages, 20);
    const firstFrame = await sharp(gif, { page: 0 }).raw().toBuffer();
    const laterFrame = await sharp(gif, { page: 10 }).raw().toBuffer();
    assert.notDeepEqual(firstFrame, laterFrame, 'encoded frames must contain actual changing motion');
    const prepared = await prepareBytes(gif, 'image/gif', 'stitch.gif', 'source_stitch');
    const image = prepared.images[0]!;
    assert.ok(image.animation);
    assert.ok((await sharp(Buffer.from(image.animation.data, 'base64'), { animated: true }).metadata()).pages! > 1);
    assert.equal((await sharp(Buffer.from(image.data, 'base64')).metadata()).format, 'png');
    assert.ok(!JSON.stringify(sourceParts(prepared, true)).includes(image.animation.data), 'GIF binary must not enter the model prompt');
    await assert.rejects(cropImage(image, { left: 0, top: 0, width: 0.5, height: 1 }), /remove its motion/);
    const def = { formatVersion: 1, minimumRuntimeVersion: '0.2.0', title: 'Stitch', toolPrefix: 'stitch', state: [], actions: [], views: [{ id: 'loop', kind: 'image', asset: 'stitch', alt: 'One stitch' }], assets: [{ id: 'stitch', mediaType: 'image/gif', uploadId: image.ref }] };
    const parsed = validateDefinition(def);
    assert.ok(parsed.ok);
    const sources = new AuthoringSources(true, new AbortController().signal);
    sources.add(prepared);
    assert.deepEqual(sources.resolve(parsed.definition, null), []);
    assert.equal(parsed.definition.assets[0]!.mediaType, 'image/gif');
    assert.equal(parsed.definition.assets[0]!.data, image.animation.data);
    const tooSlow = await sharp(gif, { animated: true }).gif({ delay: Array(20).fill(500) }).toBuffer();
    await assert.rejects(prepareBytes(tooSlow, 'image/gif', 'long.gif', 'long'), /at most 8 seconds/);
    assert.equal(validateDefinition({ ...def, minimumRuntimeVersion: '0.1.0' }).ok, false);
    await assert.rejects(renderTutorialGifs(path, { clips: [{ id: 'bad', start: 2, end: 4, label: 'Outside source' }] }, dir));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(renderTutorialGifs(path, { clips: [{ id: 'cancel', start: 0, end: 2, label: 'Cancelled' }] }, dir, controller.signal));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
