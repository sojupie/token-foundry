import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreWorkspace, reviewDelta } from '../editor/lib/workspace-delta.ts';
import { openWorkspace, reviewEdit } from '../lib/workspace.ts';

await test('worker reviews send changed sources and preserve the identity of untouched files', () => {
  const before = openWorkspace('Example', [
    { path: 'a.tokens.json', text: '{"base":{"$type":"number","$value":1}}' },
    { path: 'b.tokens.json', text: '{"other":{"$type":"number","$value":2}}' },
  ]);
  const review = reviewEdit(before, 'a.tokens.json', {
    path: 'base', create: false, node: { $value: 3 },
  });
  const transmitted = structuredClone(reviewDelta(before, review));
  assert.equal(Object.hasOwn(transmitted, 'diff'), false);
  assert.equal(transmitted.next.files[1], 'b.tokens.json');
  const next = restoreWorkspace(before, transmitted.next);
  assert.strictEqual(next.files[1], before.files[1]);
  assert.strictEqual(next.baseline, before.baseline);
  assert.equal(next.graph.resolved.get('base'), 3);
  assert.match(review.diff, /"\$value":3/u);
});
