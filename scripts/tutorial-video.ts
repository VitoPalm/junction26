// Local prototype: node --conditions=junction26-source scripts/tutorial-video.ts --input video.mp4 --plan plan.json --out .data/clips
import { parseArgs } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadYoutube, renderTutorialGifs, tutorialStoryboard, youtubeUrl } from '../apps/worker/src/tutorial-video.ts';

const { values } = parseArgs({ options: { input: { type: 'string' }, youtube: { type: 'string' }, plan: { type: 'string' }, out: { type: 'string' } } });
if ((!values.input === !values.youtube) || !values.out) throw new Error('Supply exactly one of --input FILE or --youtube URL, and --out NEW_DIRECTORY. Without --plan, produces a timestamped storyboard.');
const target = resolve(values.out);
try {
  await lstat(target);
  throw new Error('Output directory already exists. Choose a new directory.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
await mkdir(dirname(target), { recursive: true });
const staged = await mkdtemp(join(dirname(target), '.j26-clips-'));
const scratch = await mkdtemp(join(tmpdir(), 'j26-import-'));
try {
  const input = values.input ?? await downloadYoutube(values.youtube!, scratch);
  const plan = values.plan ? JSON.parse(await readFile(values.plan, 'utf8')) : null;
  if (plan && values.youtube) plan.sourceUrl = youtubeUrl(values.youtube);
  const result = plan ? await renderTutorialGifs(input, plan, staged) : await tutorialStoryboard(input, staged);
  await writeFile(join(staged, 'manifest.json'), JSON.stringify(result, null, 2));
  // A fresh output directory keeps failed imports and watched modules out of sight.
  await rename(staged, target);
  console.log(`Prepared ${target}/manifest.json`);
} finally {
  await rm(scratch, { recursive: true, force: true });
  await rm(staged, { recursive: true, force: true });
}
