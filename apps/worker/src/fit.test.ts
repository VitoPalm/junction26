import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { FIXTURES, validateDefinition } from '@junction26/applet-format';
import { checkRenderedFit } from './fit.ts';
const available =
  existsSync(new URL('../fit/check.js', import.meta.url)) &&
  ['/usr/bin/google-chrome-stable', '/usr/bin/chromium', process.env.CHROME_PATH ?? ''].some(existsSync);
test(
  'canonical rendering accepts fixtures and rejects an oversized readout',
  { skip: available ? false : 'Build fit bundle and install Chromium to measure layout' },
  async () => {
    const parsed = validateDefinition(FIXTURES.rowCounter);
    assert.ok(parsed.ok);
    assert.deepEqual(await checkRenderedFit(parsed.definition), []);
    parsed.definition.state[0]!.default = 123456789012345;
    const issues = await checkRenderedFit(parsed.definition);
    assert.ok(issues.some((i) => i.code === 'measured_fit'));
  },
);
