import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { diffFile, openWorkspace, reviewAgainstLatest, reviewDelete, reviewEdit, reviewMove, reviewMoves, reviewProposal, workspaceChanges } from '../lib/workspace.ts';

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
  assert.throws(() => reviewProposal(edit.next, proposal), /Value mismatch for system\.color\.accent/u);
  const imported = reviewProposal(edit.next, JSON.stringify({ schemaVersion: 1, changes: [
    { path: 'reference.space.small', before: { value: 8, unit: 'px' }, after: { value: 12, unit: 'px' } },
  ] }));
  assert.equal(imported.next.graph.tokens.get('system.color.accent')?.value, '{reference.color.ink}');
  assert.deepEqual(edit.next.graph.resolved.get('system.space.control-gap'), { value: 8, unit: 'px' });
  assert.throws(() => reviewProposal(edit.next, JSON.stringify({ schemaVersion: 1, changes: [
    { path: 'missing.one', before: 0, after: 1 }, { path: 'missing.two', before: 0, after: 2 },
  ] })), /missing\.one\nmissing\.two/u);
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


await test('renames a group split across files and preserves refs before a reviewed delete', () => {
  const workspace = openWorkspace('Split group', [
    { path: 'reference.tokens.json', text: '{"shared":{"$type":"number","a":{"$value":1}},"dest":{}}' },
    { path: 'system.tokens.json', text: '{"shared":{"$type":"number","b":{"$value":"{shared.a}"}},"system":{"c":{"$ref":"reference.tokens.json#/shared/a/$value"}}}' },
  ]);
  const renamed = reviewMove(workspace, { path: 'shared', to: 'primitives', file: 'reference.tokens.json' }).next;
  assert.equal(renamed.graph.resolved.get('primitives.b'), 1);
  assert.equal(renamed.graph.resolved.get('system.c'), 1);
  assert.equal(renamed.graph.tokens.get('primitives.b')?.file, 'system.tokens.json');
  assert.throws(() => reviewDelete(renamed, ['primitives']), /missing/u);
  const moved = reviewMoves(renamed, [
    { path: 'primitives.a', to: 'dest.a', file: 'reference.tokens.json' },
    { path: 'primitives.b', to: 'dest.b', file: 'reference.tokens.json' },
  ]).next;
  assert.equal(moved.graph.resolved.get('dest.b'), 1);
  assert.equal(moved.graph.resolved.get('system.c'), 1);
  assert.equal(reviewDelete(moved, ['dest', 'system.c']).next.graph.tokens.size, 0);
});

await test('uses reference type before group type and preserves inference when moving an alias', () => {
  const original = openWorkspace('Type inference', [{ path: 'tokens.json', text: JSON.stringify({
    palette: { $type: 'color', ink: { $value: { colorSpace: 'srgb', components: [0, 0, 0] } } },
    source: {
      $type: 'number',
      link: { $value: '{palette.ink}' },
      pointer: { $ref: '#/palette/ink/$value' },
      mismatch: { $type: 'number', $value: '{palette.ink}' },
      length: { $value: 1 },
    },
    destination: { $type: 'dimension' },
  }) }]);
  assert.equal(original.graph.tokens.get('source.link')?.type, 'color');
  assert.equal(original.graph.tokens.get('source.pointer')?.type, 'color');
  assert.equal(original.graph.tokens.get('source.length')?.type, 'number');
  assert.match(original.graph.issues.get('source.mismatch') ?? '', /Expected a number reference, found color/u);
  const { next } = reviewMove(original, { file: 'tokens.json', path: 'source.link', to: 'destination.link' });
  assert.equal(next.graph.tokens.get('destination.link')?.type, 'color');
  assert.equal(next.graph.tokens.get('destination.link')?.node.$type, undefined);
});
