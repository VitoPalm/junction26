import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelRegistry } from '@junction26/model';
import { describeModel } from './web.ts';

test('model metadata exposes availability and capabilities without credentials or URLs', () => {
  const registry = createModelRegistry({ anthropic: { baseUrl: 'https://private', apiKey: 'SECRET' }, gemini: { baseUrl: 'https://private', apiKey: undefined }, compatible: [{ id: 'local', baseUrl: 'http://private', apiKey: undefined, auth: 'none', capabilities: { images: false, tools: false } }], fake: () => '{}' });
  assert.equal(describeModel('anthropic:claude', registry).provider, 'anthropic');
  assert.equal(describeModel('anthropic:claude', registry).available, true);
  assert.equal(describeModel('gemini:test', registry).available, false);
  assert.equal(describeModel('unknown:test', registry).available, false);
  assert.equal(describeModel('local:llama', registry).capabilities?.tools, false);
  assert.equal(describeModel('fake:demo', registry).free, true);
  assert.doesNotMatch(JSON.stringify(describeModel('anthropic:claude', registry)), /SECRET|private/);
});
