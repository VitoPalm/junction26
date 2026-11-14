import test from 'node:test';
import assert from 'node:assert/strict';
import { readPositions, resumeIndex, moveIndex } from '../src/progress.ts';

test('recovers safely from missing, malformed and wrong-version browser storage', () => {
  for (const raw of [null, '{', 'null', '{"version":2,"positions":{}}', '{"version":1,"positions":null}']) {
    assert.deepEqual(readPositions(raw), { version: 1, positions: {} });
  }
});
test('resumes by stable ID after inserting a new screen and keeps variant positions separate', () => {
  const state = readPositions('{"version":1,"positions":{"140":"attach-top","160":"prepare","bad":17}}');
  assert.equal(resumeIndex(['prepare', 'inserted', 'attach-top'], state.positions['140']), 2);
  assert.equal(resumeIndex(['prepare', 'attach-top'], state.positions['160']), 0);
  assert.equal(resumeIndex(['prepare'], 'removed'), 0);
  assert.equal(state.positions.bad, undefined);
});
test('Previous and Next stop at the first and last screen', () => {
  assert.equal(moveIndex(0, -1, 4), 0);
  assert.equal(moveIndex(2, 1, 4), 3);
  assert.equal(moveIndex(3, 1, 4), 3);
});
