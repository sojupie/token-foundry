import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { diffFile, openWorkspace, reviewAgainstLatest, reviewEdit, reviewMove, reviewProposal, workspaceChanges } from '../lib/workspace.ts';

await test('reviews an in-browser edit, preserves other files and exports a Git patch', async () => {
  const paths = ['reference.tokens.json', 'system.tokens.json'];
  const sources = await Promise.all(paths.map(async (path) => ({ path, text: await readFile(new URL('../examples/' + path, import.meta.url), 'utf8') })));
  const original = openWorkspace('Example', sources);
  const edit = reviewEdit(original, 'system.tokens.json', {
    path: 'system.color.accent', create: false, node: { $value: '{reference.color.ink}' },
  });
  assert.deepEqual(original.graph.resolved.get('system.color.accent'), { colorSpace: 'srgb', components: [0.07, 0.37, 0.58] });
  assert.deepEqual(edit.next.graph.resolved.get('system.color.accent'), { colorSpace: 'srgb', components: [0.15, 0.18, 0.27] });
  assert.deepEqual(edit.next.files[0], original.files[0]);
  const changes = workspaceChanges(edit.next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.path, 'system.tokens.json');
  assert.match(changes.map(diffFile).join(''), /^--- a\/system\.tokens\.json$/mu);
  assert.throws(() => reviewEdit(original, 'system.tokens.json', {
    path: 'system.color.accent', create: false, node: { $value: '{reference.color.missing}' },
  }), /Reference target is missing/u);

  const proposal = JSON.stringify({ schemaVersion: 1, changes: [
    { path: 'reference.space.small', before: { unit: 'px', value: 8 }, after: { value: 12, unit: 'px' } },
    { path: 'system.color.accent', before: '{reference.color.ocean}', after: '{reference.color.ink}' },
  ] });
  const proposed = reviewProposal(original, proposal);
  assert.equal(workspaceChanges(proposed.next).length, 2);
  assert.deepEqual(proposed.next.graph.resolved.get('system.space.control-gap'), { value: 12, unit: 'px' });
  assert(proposed.impact.some(({ path }) => path === 'system.space.control-gap'));
  assert.throws(() => reviewProposal(edit.next, proposal), /changed since the proposal was created/u);
  assert.deepEqual(original.graph.resolved.get('system.space.control-gap'), { value: 8, unit: 'px' });
});

await test('moves a group across files and rebases inbound aliases and outbound JSON pointers', () => {
  const sources = [
    { path: 'base/reference.tokens.json', text: JSON.stringify({ reference: {
      other: { $type: 'dimension', $value: { value: 6, unit: 'px' } },
      space: { $type: 'dimension', $extensions: { note: '{reference.space.base}' },
        base: { $value: { value: 8, unit: 'px' } }, extra: { $ref: '#/reference/other/$value' } },
    } }, null, 2) + '\n' },
    { path: 'theme/system.tokens.json', text: JSON.stringify({ system: {
      alias: { $type: 'dimension', $value: '{reference.space.base}' },
      pointer: { $type: 'dimension', $ref: '../base/reference.tokens.json#/reference/space/extra/$value' },
    } }, null, 2) + '\n' },
  ];
  const workspace = openWorkspace('Move test', sources);
  const moved = reviewMove(workspace, { path: 'reference.space', to: 'system.spacing', file: 'theme/system.tokens.json' });
  const graph = moved.next.graph;
  assert.equal(graph.issues.size, 0);
  assert.equal(graph.tokens.has('reference.space.base'), false);
  assert.equal(graph.tokens.get('system.alias')?.value, '{system.spacing.base}');
  assert.deepEqual(graph.resolved.get('system.alias'), { value: 8, unit: 'px' });
  assert.deepEqual(graph.resolved.get('system.pointer'), { value: 6, unit: 'px' });
  assert.match(moved.diff, /\.\.\/base\/reference\.tokens\.json#\/reference\/other\//u);
  assert.match(moved.diff, /"note": "\{reference\.space\.base\}"/u);
  assert.equal(workspaceChanges(moved.next).length, 2);
});

await test('refreshing a review preserves unchanged inputs and rejects edits to the same file', () => {
  const path = 'reference.tokens.json';
  const before = '{"reference":{"gap":{"$type":"number","$value":1}}}';
  const original = openWorkspace('Fixture', [{ path, text: before }]);
  const draft = reviewEdit(original, path, { path: 'reference.gap', create: false, node: { $value: 2 } }).next;
  const consumer = { path: 'consumer.tokens.json', text: '{"consumer":{"gap":{"$type":"number","$value":"{reference.gap}"}}}' };
  const latest = openWorkspace('Fixture', [{ path, text: before }, consumer]);
  const updated = reviewAgainstLatest(draft, latest);
  assert(updated);
  assert.deepEqual(updated.impact.find((entry) => entry.path === 'consumer.gap'), { path: 'consumer.gap', before: 1, after: 2 });
  assert.deepEqual(updated.next.baseline, latest.baseline);
  assert.equal(reviewAgainstLatest(draft, openWorkspace('Fixture', updated.next.files)), null);

  const conflicting = openWorkspace('Fixture', [{ path, text: before.replace(':1', ':3') }, consumer]);
  assert.throws(() => reviewAgainstLatest(draft, conflicting), /reference\.tokens\.json changed in the repository/u);
  assert.equal(draft.graph.resolved.get('reference.gap'), 2);
  assert.equal(conflicting.graph.resolved.get('reference.gap'), 3);
});
