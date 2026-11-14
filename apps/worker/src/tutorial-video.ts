/** Local video-import prototype. Not exposed as a server source tool yet. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';

const exec = promisify(execFile);
export const VIDEO_LIMITS = { bytes: 128 * 1024 * 1024, seconds: 720, clips: 8, gifBytes: 512 * 1024 };
const crop = z.object({ left: z.number().min(0).max(1), top: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict();
export const TutorialPlan = z.object({
  sourceUrl: z.string().url().optional(),
  clips: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    start: z.number().min(0),
    end: z.number().positive(),
    /** A complete movement, not a summary of guessed motion. */
    label: z.string().min(1).max(120),
    crop: crop.optional(),
    fps: z.number().int().min(4).max(12).default(10),
    width: z.number().int().min(120).max(360).default(320),
  }).strict()).min(1).max(VIDEO_LIMITS.clips),
}).strict();
export type TutorialPlan = z.infer<typeof TutorialPlan>;

export function youtubeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use a public HTTPS YouTube link.');
  let id: string | undefined | null;
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(shorts|embed)\/([^/]+)$/.exec(url.pathname)?.[2];
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Use a single YouTube video link, not a playlist or channel.');
  return `https://www.youtube.com/watch?v=${id}`;
}

export function validateTutorialPlan(value: unknown, duration: number): TutorialPlan {
  const plan = TutorialPlan.parse(value);
  const ids = new Set<string>();
  for (const clip of plan.clips) {
    if (ids.has(clip.id)) throw new Error(`Duplicate clip ID: ${clip.id}`);
    ids.add(clip.id);
    const seconds = clip.end - clip.start;
    if (seconds < 0.5 || seconds > 8 || clip.end > duration + 0.001 || Math.ceil(seconds * clip.fps) > 96)
      throw new Error(`${clip.id}: select 0.5–8 seconds within the source, at most 96 frames.`);
    if (clip.crop && (clip.crop.left + clip.crop.width > 1 || clip.crop.top + clip.crop.height > 1))
      throw new Error(`${clip.id}: crop must stay inside the source.`);
  }
  return plan;
}

const options = (signal?: AbortSignal) => ({ timeout: 60000, maxBuffer: 1024 * 1024, signal });
// No network or nested playlist input in the media decoder. The downloader is separate.
const inputArgs = (path: string) => ['-protocol_whitelist', 'file,pipe', '-i', resolve(path)];
export async function probeTutorial(path: string, signal?: AbortSignal) {
  if ((await stat(path)).size > VIDEO_LIMITS.bytes) throw new Error('Video exceeds 128 MiB. Use an excerpt.');
  const { stdout } = await exec('ffprobe', ['-v', 'error', ...inputArgs(path), '-show_format', '-show_streams', '-of', 'json'], options(signal));
  const meta = JSON.parse(stdout);
  const video = meta.streams?.find((s: any) => s.codec_type === 'video');
  const duration = Number(meta.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0 || duration > VIDEO_LIMITS.seconds)
    throw new Error('Use a finite video no longer than 12 minutes.');
  if (!video.width || !video.height || video.width * video.height > 3840 * 2160)
    throw new Error('Video dimensions exceed 4K.');
  const [numerator, denominator] = String(video.avg_frame_rate).split('/').map(Number);
  const fps = numerator! / denominator!;
  return { duration, width: Number(video.width), height: Number(video.height), fps: Number.isFinite(fps) && fps > 0 ? fps : 30 };
}

/** Inspectable, timestamped frames for a builder; no transcript or motion is inferred. */
export async function tutorialStoryboard(path: string, out: string, signal?: AbortSignal) {
  const meta = await probeTutorial(path, signal);
  const frames = [];
  for (let i = 0; i < 12; i++) {
    const seconds = Math.min(i * meta.duration / 12, Math.max(0, meta.duration - 1 / meta.fps));
    const file = `frame_${String(i).padStart(2, '0')}.png`;
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(seconds), ...inputArgs(path), '-frames:v', '1', '-vf', "scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease", '-threads', '1', '-y', join(out, file)], options(signal));
    if (!(await stat(join(out, file))).size) throw new Error('Could not decode storyboard frame.');
    frames.push({ seconds, file });
  }
  return { ...meta, frames, warning: 'Sparse frames are navigation hints. Inspect dense frames around each candidate before selecting a complete movement; audio/captions are not included.' };
}

/** Deterministic encoder: a model supplies bounded timestamps/crops, never commands. */
export async function renderTutorialGifs(path: string, value: unknown, out: string, signal?: AbortSignal) {
  const meta = await probeTutorial(path, signal);
  const plan = validateTutorialPlan(value, meta.duration);
  const dir = await mkdtemp(join(tmpdir(), 'j26-video-'));
  try {
    const clips = [];
    let total = 0;
    for (const clip of plan.clips) {
      signal?.throwIfAborted();
      const box = clip.crop;
      const filters = [
        ...(box ? [`crop=iw*${box.width}:ih*${box.height}:iw*${box.left}:ih*${box.top}`] : []),
        `fps=${clip.fps}`,
        `scale='min(${clip.width},iw)':'min(360,ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
        'split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=sierra2_4a',
      ].join(',');
      const file = `${clip.id}.gif`;
      const target = join(dir, file);
      await exec('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '1', '-ss', String(clip.start), ...inputArgs(path), '-t', String(clip.end - clip.start), '-an', '-sn', '-dn', '-filter_complex_threads', '1', '-filter_complex', filters, '-loop', '0', '-fs', String(VIDEO_LIMITS.gifBytes + 65536), '-y', target], options(signal));
      const bytes = await readFile(target);
      const gif = await sharp(bytes, { animated: true }).metadata();
      const expected = (clip.end - clip.start) * 1000;
      const actual = (gif.delay ?? []).reduce((sum, ms) => sum + ms, 0);
      if (bytes.length > VIDEO_LIMITS.gifBytes || !gif.pages || gif.pages < 2 || Math.abs(actual - expected) > 1000 / clip.fps + 30)
        throw new Error(`${clip.id}: GIF is too large or incomplete. Shorten the excerpt, crop it, or reduce width/fps.`);
      total += bytes.length;
      if (total > 2 * 1024 * 1024) throw new Error('GIFs exceed the 2 MiB motion budget for a solution. Use fewer/shorter clips.');
      await writeFile(join(out, file), bytes, { flag: 'wx' });
      await sharp(bytes).png().toFile(join(out, `${clip.id}.png`));
      clips.push({ ...clip, file, poster: `${clip.id}.png`, mediaType: 'image/gif', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), source: plan.sourceUrl ? `${plan.sourceUrl}${plan.sourceUrl.includes('?') ? '&' : '?'}t=${clip.start}` : undefined });
    }
    return { version: 1, sourceUrl: plan.sourceUrl, source: meta, clips, totalBytes: total, estimatedTransferSeconds: total * 8 / 500000, note: 'Transfer estimate is GIF bytes only; current base64 JSON packaging adds about one third. Local conversion evidence, not glasses verification.' };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Developer CLI only: yt-dlp is NOT an SSRF-isolated hosted importer. */
export async function downloadYoutube(value: string, directory: string, signal?: AbortSignal) {
  const url = youtubeUrl(value);
  const path = join(directory, 'source.mp4');
  await exec(process.env.YT_DLP_PATH ?? 'yt-dlp', ['--ignore-config', '--no-playlist', '--no-progress', '--no-warnings', '--socket-timeout', '15', '--retries', '1', '--max-filesize', '128M', '--match-filters', 'duration <= 720 & !is_live', '-f', 'bestvideo[ext=mp4][height<=720]/bestvideo[height<=720]/best[height<=720]', '-o', path, '--', url], { ...options(signal), timeout: 180000 });
  await probeTutorial(path, signal);
  return path;
}
