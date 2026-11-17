import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { copyEntries, decodeClipboard, encodeClipboard } from '../lib/structure.ts';
import { fieldDependsOn, referenceConsumers, referenceProblems } from '../lib/document.ts';
import { diffFile, openWorkspace, reviewAgainstLatest, reviewBulkEdit, reviewDelete, reviewDuplicate, reviewEdit, reviewMove, reviewMoves, reviewMetadata, reviewPaste, reviewProposal, reviewRepositorySources, reviewRemoveOverride, reviewSource, reviewSourcePath, reviewWorkspace, workspaceChanges } from '../lib/workspace.ts';

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
  assert.match(reviewDelete(renamed, ['primitives']).validationErrors?.join('\n') ?? '', /missing/u);
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

await test('diagnoses invalid DTCG values without hiding the rest of the workspace', () => {
  const workspace = openWorkspace('example', [{ path: 'tokens.json', text: JSON.stringify({
    time: { $type: 'duration', $value: { value: 5, unit: 'px' } },
    untyped: { $value: 3 },
    transition: { $type: 'transition', $value: {
      duration: '{time}', delay: { value: 0, unit: 'ms' }, timingFunction: [0, 0, 1, 1],
    } },
    wide: { $type: 'color', $value: { colorSpace: 'oklch', components: [0.68, 0.31, 'none'], alpha: 0.5 } },
  }) }]);
  assert.match(workspace.graph.validation.get('time')?.join('\n') ?? '', /\$value\/unit/u);
  assert.match(workspace.graph.validation.get('untyped')?.join('\n') ?? '', /Declare a type/u);
  assert.match(workspace.graph.validation.get('transition')?.join('\n') ?? '', /\$value\/duration\/unit/u);
  assert.equal(workspace.graph.validation.has('wide'), false);
  const repaired = reviewEdit(workspace, 'tokens.json', {
    path: 'time', node: { $value: { value: 50, unit: 'ms' } }, create: false,
  }).next;
  assert.equal(repaired.graph.validation.has('time'), false);
  assert.equal(repaired.graph.validation.has('transition'), false);
  assert.equal(repaired.graph.validation.has('untyped'), true);
  assert.throws(() => reviewEdit(repaired, 'tokens.json', {
    path: 'time', node: { $value: { value: 5, unit: 'px' } }, create: false,
  }), /time · \$value\/unit/u);
});

await test('resolves scoped pointers without treating independent fields as a token-wide cycle', () => {
  const workspace = openWorkspace('example', [{ path: 'tokens.json', text: JSON.stringify({
    step: { $type: 'dimension', $value: { value: 8, unit: 'px' } },
    local: { $type: 'dimension', $value: { value: 12, unit: { $ref: '#/step/$value/unit' } } },
    metadata: { $type: 'fontFamily', $value: { $ref: '#/step/$type' } },
    color: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.5, { $ref: '#/color/$value/components/0' }, 0] } },
    cycle: { $type: 'color', $value: { colorSpace: 'srgb', components: [
      { $ref: '#/cycle/$value/components/1' }, { $ref: '#/cycle/$value/components/0' }, 0,
    ] } },
  }) }]);
  assert.deepEqual(workspace.graph.resolved.get('local'), { value: 12, unit: 'px' });
  assert.equal(workspace.graph.resolved.get('metadata'), 'dimension');
  assert.deepEqual(workspace.graph.resolved.get('color'), { colorSpace: 'srgb', components: [0.5, 0.5, 0] });
  assert.match(workspace.graph.issues.get('cycle') ?? '', /Circular reference: #\/cycle\/\$value\/components\//u);
});

await test('reports malformed grammar and metadata without rewriting opaque authored data', () => {
  const text = JSON.stringify({
    group: {
      $description: 7, $deprecated: { reason: 'old' }, $extensions: ['invalid'],
      $root: { branch: { $value: 1 } }, 'bad.name': { $value: 2 },
      invalidNode: false, mixed: { $type: 'number', $value: 1, child: { $value: 9 } },
      valid: {
        $type: 'number', $value: 4, $deprecated: false,
        $extensions: { 'example.tool': { nested: [1, false, null], untouched: { arbitrary: 'text' } } },
        $future: 'opaque',
      },
    },
  }, null, 2);
  const original = openWorkspace('fixture', [{ path: 'tokens.json', text }]);
  const fields = original.graph.documentDiagnostics.map(({ path, field, severity }) => [path, field, severity]);
  assert.deepEqual(fields, [
    ['group', '$description', 'error'], ['group', '$deprecated', 'error'], ['group', '$extensions', 'error'],
    ['group.$root', '', 'error'], ['group', 'bad.name', 'error'], ['group.invalidNode', '', 'error'],
    ['group.mixed', 'child', 'error'], ['group.valid', '$future', 'warning'],
  ]);
  assert.equal(original.graph.resolved.get('group.valid'), 4);
  const changed = reviewEdit(original, 'tokens.json', {
    create: false, path: 'group.valid', node: { $value: 5 },
  }).next;
  const expected = text.replace('"$value": 4', '"$value": 5');
  assert.equal(changed.files[0]?.text, expected);
  assert.deepEqual(changed.graph.documentDiagnostics, original.graph.documentDiagnostics);
  assert.throws(() => reviewEdit(original, 'tokens.json', {
    create: false, path: 'group.valid', node: { $deprecated: [] },
  }), /tokens\.json · group\.valid · \$deprecated/u);
});

await test('reports nested reference type mismatches even when the resolved shapes coincide', () => {
  const workspace = openWorkspace('fixture', [{ path: 'tokens.json', text: JSON.stringify({
    number: { $type: 'number', $value: 400 },
    duration: { $type: 'duration', $value: { value: 4, unit: 'ms' } },
    timing: { $type: 'cubicBezier', $value: [0, 0, 1, 1] },
    transition: { $type: 'transition', $value: { duration: '{duration}', delay: '{duration}', timingFunction: '{timing}' } },
    type: { $type: 'typography', $value: {
      fontFamily: 'Inter', fontSize: { value: 16, unit: 'px' }, fontWeight: { $ref: '#/number/$value' },
      letterSpacing: { value: 0, unit: 'px' }, lineHeight: 1.2,
    } },
  }) }]);
  assert.equal(workspace.graph.validation.has('transition'), false);
  assert.match(workspace.graph.validation.get('type')?.join('\n') ?? '', /\$value\/fontWeight · Expected a fontWeight reference, found number/u);
});

await test('keeps unrelated tokens editable when source paths conflict and supports repairing the conflicting file', () => {
  const original = openWorkspace('fixture', [
    { path: 'base.tokens.json', text: '{"gap":{"$type":"number","$value":1},"valid":{"$type":"number","$value":3}}' },
    { path: 'duplicate.tokens.json', text: '{"gap":{"$type":"number","$value":2}}' },
  ]);
  assert.match(original.graph.issues.get('gap') ?? '', /Conflicting source definitions/u);
  assert.equal(original.graph.documentDiagnostics[0]?.file, 'duplicate.tokens.json');
  const edited = reviewEdit(original, 'base.tokens.json', { path: 'valid', create: false, node: { $value: 4 } }).next;
  const repaired = reviewSource(edited, 'duplicate.tokens.json', '{"alternate":{"$type":"number","$value":2}}').next;
  assert.equal(repaired.graph.documentDiagnostics.length, 0);
  assert.equal(repaired.graph.resolved.get('gap'), 1);
  assert.equal(repaired.graph.resolved.get('valid'), 4);
  assert.equal(repaired.graph.resolved.get('alternate'), 2);
});

await test('a rename preserves existing metadata diagnostics at the new location', () => {
  const original = openWorkspace('fixture', [
    { path: 'tokens.json', text: '{"bad":{"$type":"number","$value":1,"$deprecated":123}}' },
  ]);
  const renamed = reviewMove(original, { path: 'bad', to: 'better', file: 'tokens.json' }, true).next;
  assert.equal(renamed.graph.documentDiagnostics[0]?.path, 'better');
  assert.equal(renamed.graph.documentDiagnostics[0]?.field, '$deprecated');
  assert.deepEqual(renamed.files[0]?.tree['better'], { $type: 'number', $value: 1, $deprecated: 123 });
});

await test('renaming a token with an existing unresolved reference retains its diagnostic', () => {
  const original = openWorkspace('fixture', [
    { path: 'tokens.json', text: '{"bad":{"$type":"number","$value":"{missing}"}}' },
  ]);
  const renamed = reviewMove(original, { path: 'bad', to: 'better', file: 'tokens.json' }, true).next;
  assert.equal(renamed.graph.issues.get('better'), original.graph.issues.get('bad'));
});

await test('keeps malformed source text through healthy edits, structural review and repair', () => {
  const broken = '{"broken": }';
  const duplicate = '{"gap":{},"gap":{}}';
  const original = openWorkspace('Mixed', [
    { path: 'good.tokens.json', text: '{"size":{"$type":"number","$value":1}}' },
    { path: 'broken.tokens.json', text: broken },
    { path: 'duplicate.tokens.json', text: duplicate },
    { path: 'bad-root.tokens.json', text: '{"$type":"number","$value":1}' },
  ]);
  assert.deepEqual([...original.graph.groups.get('')?.files.keys() ?? []], ['good.tokens.json']);
  assert.equal(original.graph.documentDiagnostics.length, 3);
  assert.equal(original.graph.documentDiagnostics.find(issue => issue.file === 'broken.tokens.json')?.offset, 11);
  assert.equal(original.graph.documentDiagnostics.find(issue => issue.file === 'duplicate.tokens.json')?.offset, 10);
  const moved = reviewMove(original, { path: 'size', to: 'length', file: 'good.tokens.json' }, true).next;
  assert.equal(moved.files.find(file => file.path === 'broken.tokens.json')?.text, broken);
  assert.equal(moved.files.find(file => file.path === 'duplicate.tokens.json')?.text, duplicate);
  assert.deepEqual(reviewWorkspace(moved).uninspectedSources, ['broken.tokens.json', 'duplicate.tokens.json']);
  const repaired = reviewSource(moved, 'broken.tokens.json', '{"fixed":{"$type":"number","$value":2}}').next;
  assert.equal(repaired.graph.documentDiagnostics.length, 2);
  assert.equal(repaired.graph.resolved.get('length'), 1);
  assert.equal(repaired.graph.resolved.get('fixed'), 2);
  assert.equal(openWorkspace('Only malformed', [{ path: 'broken.tokens.json', text: broken }]).graph.groups.get('')?.files.size, 0);
});

await test('reports every invalid composite field and allows repairing one field at a time in source', () => {
  const token = { $type: 'border', $value: {
    color: { colorSpace: 'srgb', components: [2, 0, 1], alpha: -1 },
    width: { value: 'x', unit: 'pt' }, style: 'bad',
  } };
  const original = openWorkspace('Composite', [{ path: 'tokens.json', text: JSON.stringify({ token }) }]);
  const fields = original.graph.validation.get('token')?.map(message => message.split(' · ')[0]);
  assert.deepEqual(fields, ['$value/color/components/0', '$value/color/alpha', '$value/width/value', '$value/width/unit', '$value/style']);
  token.$value.width.unit = 'px';
  const repaired = reviewSource(original, 'tokens.json', JSON.stringify({ token })).next;
  assert.deepEqual(repaired.graph.validation.get('token')?.map(message => message.split(' · ')[0]),
    ['$value/color/components/0', '$value/color/alpha', '$value/width/value', '$value/style']);
  token.$value.width.unit = 'em';
  assert.throws(() => reviewSource(repaired, 'tokens.json', JSON.stringify({ token })), /\$value\/width\/unit/u);
});

await test('review and refreshed review carry an applied rename with existing diagnostics', () => {
  const sources = [{ path: 'tokens.json', text: '{"bad":{"$type":"number","$value":"{missing}","$deprecated":3}}' }];
  const original = openWorkspace('Fixture', sources);
  const renamed = reviewMove(original, { path: 'bad', to: 'better', file: 'tokens.json' }, true).next;
  assert.match(reviewWorkspace(renamed).diff, /better/u);
  const latest = openWorkspace('Fixture', [
    ...sources, { path: 'unrelated.tokens.json', text: '{"newer":{"$type":"number","$value":2}}' },
  ]);
  const refreshed = reviewAgainstLatest(renamed, latest)?.next;
  assert.equal(refreshed?.graph.issues.get('better'), 'Reference target is missing: missing');
  assert.equal(refreshed?.graph.documentDiagnostics[0]?.path, 'better');
  assert.equal(refreshed?.graph.resolved.get('newer'), 2);
});

await test('composes group inheritance, atomic token overrides and file-relative pointers without touching source', () => {
  const payload = {
    base: {
      $type: 'number', $deprecated: 'Retired palette',
      $extensions: { 'vendor.keep': { untouched: true }, 'vendor.replace': { old: true } },
      $root: { $value: 1 },
      nested: {
        count: { $value: 2, $description: 'Base count' },
        linked: { $value: { $ref: '#/base/nested/count/$value' } },
      },
    },
  };
  const original = openWorkspace('Fixture', [
    { path: 'base.tokens.json', text: JSON.stringify(payload) },
    { path: 'theme/dark.tokens.json', text: JSON.stringify({
      dark: {
        $ref: '../base.tokens.json#/base', $deprecated: false,
        $extensions: { 'vendor.replace': { new: true } },
        nested: { count: { $value: 3 } },
      },
      contrast: { $extends: '{dark}' },
      consumer: { $value: '{contrast.nested.linked}' },
    }) },
  ]);
  assert.equal(original.graph.resolved.get('dark.$root'), 1);
  assert.equal(original.graph.resolved.get('contrast.nested.count'), 3);
  assert.equal(original.graph.resolved.get('consumer'), 2);
  assert.equal(original.graph.tokens.get('dark.nested.count')?.node.$description, undefined);
  assert.deepEqual(original.graph.tokens.get('dark.nested.count')?.overrides, { file: 'base.tokens.json', path: 'base.nested.count' });
  assert.equal(original.graph.tokens.get('dark.nested.linked')?.deprecated, false);
  assert.deepEqual(original.graph.groups.get('dark')?.definitions.get('theme/dark.tokens.json')?.node['$extensions'],
    { 'vendor.keep': { untouched: true }, 'vendor.replace': { new: true } });
  const override = reviewEdit(original, 'theme/dark.tokens.json', {
    path: 'dark.nested.linked', create: false, node: { $description: 'Local metadata' },
  }).next;
  assert.equal(override.graph.resolved.get('dark.nested.linked'), 2);
  assert.equal(override.graph.tokens.get('dark.nested.linked')?.inheritedFrom, undefined);
  assert.deepEqual(override.graph.tokens.get('dark.nested.linked')?.value, { $ref: '../base.tokens.json#/base/nested/count/%24value' });
  assert.equal(override.files[0]?.text, JSON.stringify(payload));
  const reverted = reviewRemoveOverride(override, 'dark.nested.linked').next;
  assert.equal(reverted.graph.tokens.get('dark.nested.linked')?.inheritedFrom?.path, 'base.nested.linked');
  assert.equal(reverted.graph.resolved.get('consumer'), 2);
});

await test('reports invalid extensions at their authored group while unrelated groups still resolve', () => {
  const graph = openWorkspace('Fixture', [{ path: 'tokens.json', text: JSON.stringify({
    numeric: { $type: 'number', $value: 8 },
    invalid: { $extends: '{numeric}' },
    absent: { $extends: '{does.not.exist}' },
    first: { $extends: '{second}' },
    second: { $extends: '{first}' },
    parent: { child: { $extends: '{parent}' }, other: { $type: 'number', $value: 9 } },
  }) }]).graph;
  assert.equal(graph.resolved.get('parent.other'), 9);
  const errors = new Map(graph.documentDiagnostics.map(issue => [issue.path, issue.message]));
  assert.match(errors.get('invalid') ?? '', /must be a group/u);
  assert.match(errors.get('absent') ?? '', /could not be found/u);
  assert.match(errors.get('first') ?? '', /circular/iu);
  assert.match(errors.get('second') ?? '', /circular/iu);
  assert.match(errors.get('parent.child') ?? '', /circular/iu);
});

await test('reviews metadata changes and reports changed effective types separately from values', () => {
  const file = 'tokens.json';
  const original = openWorkspace('Fixture', [{ path: file, text: JSON.stringify({
    base: { $type: 'number', $deprecated: true, $extensions: { 'vendor.keep': { value: 5 } }, size: { $value: 400 } },
  }) }]);
  const metadata = reviewMetadata(original, file, 'base', { $description: 'A description', $type: 'fontWeight', $deprecated: false });
  assert.deepEqual(metadata.typeImpact, [{ path: 'base.size', before: 'number', after: 'fontWeight' }]);
  assert.equal(metadata.next.graph.tokens.get('base.size')?.deprecated, false);
  assert.deepEqual(metadata.next.graph.groups.get('base')?.definitions.get(file)?.node['$extensions'], { 'vendor.keep': { value: 5 } });
});

await test('extends effective nested groups by alias and pointer, including local sibling extensions', () => {
  const graph = openWorkspace('Fixture', [{ path: 'tokens.json', text: JSON.stringify({
    byAlias: { $extends: '{derived.nested}' },
    byPointer: { $ref: '#/derived/nested' },
    derived: { $extends: '{base}', sibling: { $extends: '{derived.nested}' }, nested: { y: { $value: 4 } } },
    base: { nested: { $type: 'number', x: { $value: 2 } } },
  }) }]).graph;
  assert.deepEqual(graph.documentDiagnostics, []);
  for (const path of ['byAlias', 'byPointer', 'derived.sibling']) {
    assert.equal(graph.resolved.get(path + '.x'), 2);
    assert.equal(graph.resolved.get(path + '.y'), 4);
  }
});

await test('reports malformed inherited metadata when it would be authored by an override', () => {
  const original = openWorkspace('Fixture', [{ path: 'tokens.json', text: JSON.stringify({
    base: { $type: 'number', x: { $value: 2, $description: 34 } },
    derived: { $extends: '{base}' },
  }) }]);
  assert.throws(() => reviewEdit(original, 'tokens.json', {
    path: 'derived.x', create: false, node: { $value: 3 },
  }), /derived\.x.*\$description/u);
});

await test('previews invalid group type changes and lists inherited paths removed by a source edit', () => {
  const file = 'tokens.json';
  const original = openWorkspace('Fixture', [{ path: file, text: JSON.stringify({
    base: { $type: 'number', x: { $value: 2 } },
    derived: { $extends: '{base}' },
  }) }]);
  const metadata = reviewMetadata(original, file, 'base', { $type: 'color' });
  assert.deepEqual(metadata.typeImpact.map(impact => impact.path), ['base.x', 'derived.x']);
  assert.equal(metadata.validationErrors?.length, 2);
  assert.match(metadata.validationErrors?.[1] ?? '', /derived\.x .*Expected a color object/u);
  assert.deepEqual(reviewDelete(original, ['base.x']).inheritanceImpact,
    [{ path: 'derived.x', change: 'Removed' }]);
});

await test('creates and re-edits authored tokens inside a group with a pointer extension', () => {
  const file = 'tokens.json';
  const original = openWorkspace('Fixture', [{ path: file, text: JSON.stringify({
    base: { $type: 'number', x: { $value: 1 } },
    derived: { $ref: '#/base' },
  }) }]);
  const created = reviewEdit(original, file, { path: 'derived.y', create: true, node: { $value: 2 } }).next;
  const overridden = reviewEdit(created, file, { path: 'derived.x', create: false, node: { $value: 3 } }).next;
  const updated = reviewEdit(overridden, file, { path: 'derived.x', create: false, node: { $value: 4 } }).next;
  assert.equal(updated.graph.resolved.get('derived.x'), 4);
  assert.equal(updated.graph.resolved.get('derived.y'), 2);
  assert.equal(updated.graph.resolved.get('base.x'), 1);
});

await test('validates overridden values against their applicable inherited type constraints', () => {
  const graph = openWorkspace('Fixture', [{ path: 'tokens.json', text: JSON.stringify({
    base: { $type: 'number', gap: { $value: 1 } },
    derived: {
      $extends: '{base}',
      $type: 'dimension',
      gap: { $value: { value: 2, unit: 'px' } },
      other: { $value: { value: 3, unit: 'px' } },
    },
  }) }]).graph;
  assert.match(graph.validation.get('derived.gap')?.[0] ?? '', /inherited number constraint from base\.gap/u);
  assert.equal(graph.validation.has('derived.other'), false);
});

await test('reads metadata and root token values from effective group paths', () => {
  const graph = openWorkspace('Fixture', [{ path: 'tokens.json', text: JSON.stringify({
    base: { $type: 'number', $description: 'Inter', $root: { $value: 6, $description: 'Roboto' } },
    derived: { $extends: '{base}' },
    root: { $ref: '#/derived/$root/$value' },
    description: { $type: 'fontFamily', $ref: '#/derived/$description' },
    rootDescription: { $type: 'fontFamily', $ref: '#/derived/$root/$description' },
    invalid: { $type: 'number', $value: { $ref: '#/derived' } },
  }) }]).graph;
  assert.equal(graph.resolved.get('root'), 6);
  assert.equal(graph.resolved.get('description'), 'Inter');
  assert.equal(graph.resolved.get('rootDescription'), 'Roboto');
  assert.match(graph.issues.get('invalid') ?? '', /target is a group/u);
});

await test('resolves independent fields through aliases and records escaped document locations', () => {
  const graph = openWorkspace('Fixture', [{ path: 'tokens.json', text: JSON.stringify({
    'palette/~': {
      $type: 'color',
      $value: { colorSpace: 'srgb', components: [0.25, { $ref: '#/alias/$value/components/1' }, 0] },
      $extensions: { 'vendor.data': { 'a~/b': 42 } },
    },
    alias: { $value: '{palette/~}' },
    good: { $ref: '#/alias/$value/components/0', $type: 'number' },
    metadataValue: { $type: 'number', $ref: '#/palette~1~0/$extensions/vendor.data/a~0~1b' },
  }) }]).graph;
  assert.equal(graph.resolved.get('good'), 0.25);
  assert.equal(graph.resolved.get('metadataValue'), 42);
  assert.match(graph.issues.get('palette/~') ?? '', /\$value\/components\/1.*Circular reference/u);
  assert.deepEqual([...graph.links.get('metadataValue')?.values() ?? []][0], {
    field: ['$ref'], text: '#/palette~1~0/$extensions/vendor.data/a~0~1b', file: 'tokens.json',
    parts: ['palette/~', '$extensions', 'vendor.data', 'a~/b'], target: 'palette/~', value: 42,
  });
});

await test('follows only the downstream fields affected by a reference', () => {
  const graph = openWorkspace('Fixture', [{ path: 'tokens.json', text: JSON.stringify({
    size: { $type: 'number', $value: 8 },
    dimension: { $type: 'dimension', $value: { value: '{size}', unit: 'px' } },
    projected: { $ref: '#/dimension/$value/value' },
    unrelated: { $type: 'fontFamily', $ref: '#/dimension/$value/unit' },
  }) }]).graph;
  assert.deepEqual(referenceConsumers(graph, 'size'), { direct: new Set(['dimension']), downstream: new Set(['projected']) });
  assert.equal(graph.tokens.get('projected')?.type, 'number');
});

await test('rewrites references to inherited paths when renaming their original definition', () => {
  const workspace = openWorkspace('Fixture', [
    { path: 'base.tokens.json', text: JSON.stringify({ original: { $type: 'dimension', x: { $value: { value: 6, unit: 'px' } } } }) },
    { path: 'theme/derived.tokens.json', text: JSON.stringify({
      derived: { $ref: '../base.tokens.json#/original' },
      other: { $extends: '{derived}' },
      alias: { $value: '{other.x}' },
      field: { $type: 'number', $ref: '#/other/x/$value/value' },
    }) },
  ]);
  const review = reviewMove(workspace, { path: 'original.x', to: 'original.y', file: 'base.tokens.json' }, true);
  assert.equal(review.structure?.referencesUpdated, 2);
  assert.equal(review.next.graph.tokens.get('alias')?.value, '{other.y}');
  assert.deepEqual(review.next.graph.tokens.get('field')?.value, { $ref: '#/other/y/%24value/value' });
  assert.equal(review.next.graph.resolved.get('field'), 6);
  const deletion = reviewDelete(review.next, ['original.y']);
  assert.match(deletion.validationErrors?.join('\n') ?? '', /alias.*missing/u);
  assert.match(deletion.validationErrors?.join('\n') ?? '', /field.*missing/u);
});

await test('lists every broken field and keeps usable fields selectable', () => {
  const graph = openWorkspace('Fixture', [{ path: 'tokens.json', text: JSON.stringify({
    source: { $type: 'number', $value: 0.4 },
    partial: { $type: 'color', $value: { colorSpace: 'srgb', components: [
      0.25, { $ref: '#/source/$value' }, { $ref: '#/missing/value' },
    ], alpha: { $ref: '#/other/$value' } } },
  }) }]).graph;
  assert.deepEqual(referenceProblems(graph, 'partial', graph.issues.get('partial') ?? ''), [
    '$value/components/2 · Pointer target is missing: #/missing/value',
    '$value/alpha · Pointer target is missing: #/other/$value',
  ]);
  assert.deepEqual(graph.partialFields.get('partial')?.filter(({ field }) => field[0] === 'components'),
    [{ field: ['components', '0'], value: 0.25 }, { field: ['components', '1'], value: 0.4 }]);
  assert.equal(fieldDependsOn(graph, 'partial', ['components', '0'], 'source'), false);
  assert.equal(fieldDependsOn(graph, 'partial', ['components', '1'], 'source'), true);
});

await test('preserves a complete alias edge when reading one of its fields', () => {
  const { graph } = openWorkspace('Fixture', [{ path: 'tokens.json', text: JSON.stringify({
    base: { $type: 'dimension', $value: { value: 4, unit: 'px' } },
    alias: { $value: '{base}' },
    field: { $ref: '#/alias/$value/value' },
  }) }]);
  assert.deepEqual([...graph.links.get('alias')?.values() ?? []][0]?.value, { value: 4, unit: 'px' });
  assert.deepEqual([...referenceConsumers(graph, 'base').downstream], ['field']);
});

await test('renames inherited children of a merged group and reviews aliases if a move exits their base', () => {
  const file = 'tokens.json';
  const workspace = openWorkspace('Fixture', [{ path: file, text: JSON.stringify({
    base: { nested: { x: { $type: 'number', $value: 6 } } },
    derived: { $extends: '{base}', nested: { local: { $type: 'number', $value: 9 } } },
    elsewhere: {}, alias: { $value: '{derived.nested.x}' },
  }) }]);
  const rename = reviewMove(workspace, { path: 'base.nested', to: 'base.renamed', file }, true);
  assert.equal(rename.next.graph.tokens.get('alias')?.value, '{derived.renamed.x}');
  assert.equal(rename.next.graph.resolved.get('derived.nested.local'), 9);
  const move = reviewMove(workspace, { path: 'base.nested.x', to: 'elsewhere.x', file });
  assert.match(move.validationErrors?.join('\n') ?? '', /alias · Reference target is missing: derived\.nested\.x/u);
});

await test('copies a group without changing incoming links and preserves pointer suffixes in the copy', () => {
  const original = openWorkspace('Fixture', [
    { path: 'source.tokens.json', text: JSON.stringify({
      base: { channel: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.6, 0, 0] } },
        number: { $ref: '#/base/channel/$value/components/0' } },
      inbound: { $value: '{base.number}' },
    }) },
    { path: 'theme/destination.tokens.json', text: '{"target":{}}' },
  ]);
  const review = reviewDuplicate(original, [{ path: 'base', to: 'target.base-copy', file: 'theme/destination.tokens.json' }]);
  assert.equal(review.structure?.referencesUpdated, 1);
  assert.deepEqual(review.next.graph.tokens.get('target.base-copy.number')?.value, { $ref: '#/target/base-copy/channel/%24value/components/0' });
  assert.equal(review.next.graph.resolved.get('target.base-copy.number'), 0.6);
  assert.equal(review.next.files[0]?.text, original.files[0]?.text);
  assert.equal(review.next.graph.tokens.get('inbound')?.value, '{base.number}');
});

await test('honors escaped source names and validates the declared type of a numeric field reference', () => {
  const graph = openWorkspace('Fixture', [
    { path: 'parts#v1?.tokens.json', text: JSON.stringify({
      metrics: { weight: { $type: 'fontWeight', $value: 400 }, number: { $type: 'number', $value: 0.4 } },
    }) },
    { path: 'consumer.tokens.json', text: JSON.stringify({
      metal: { $type: 'color', $value: { colorSpace: 'srgb', components: [
        { $ref: 'parts%23v1%3F.tokens.json#/metrics/number/$value' }, 0, 0,
      ] } },
      curve: { $type: 'cubicBezier', $value: [0, '{metrics.weight}', 1, 0] },
    }) },
  ]).graph;
  assert.deepEqual(graph.resolved.get('metal'), { colorSpace: 'srgb', components: [0.4, 0, 0] });
  assert.equal(graph.validation.has('metal'), false);
  assert.match(graph.validation.get('curve')?.join('\n') ?? '', /\$value\/1 · Expected a number reference, found fontWeight/u);
});

await test('moves source files with inbound, outbound, and local refs while preserving metadata', () => {
  const workspace = openWorkspace('Example', [{
    path: 'a/shared.tokens.json',
    text: '{"base":{"$type":"number","$value":4},"ref":{"$type":"number","$value":{"$ref":"../local.tokens.json#/local/$value"}},"self":{"$type":"number","$value":{"$ref":"#/base/$value"}},"$extensions":{"org.example":{"$ref":"../local.tokens.json#/local/$value"}}}',
  }, {
    path: 'local.tokens.json',
    text: '{"local":{"$type":"number","$value":8},"from":{"$type":"number","$value":{"$ref":"a/shared.tokens.json#/base/%24value"}}}',
  }]);
  const review = reviewSourcePath(workspace, 'a/shared.tokens.json', 'b/c/common.tokens.json');
  assert.equal(review.structure?.referencesUpdated, 2);
  assert.deepEqual(review.impact, []);
  assert.match(review.next.files[0]?.text ?? '', /\.\.\/\.\.\/local\.tokens\.json#\/local/u);
  assert.match(review.next.files[0]?.text ?? '', /"#\/base\/\$value"/u);
  assert.match(review.next.files[0]?.text ?? '', /"org.example":\{"\$ref":"\.\.\/local/u);
  assert.match(review.next.files[1]?.text ?? '', /b\/c\/common\.tokens\.json#\/base\/%24value/u);
  assert.deepEqual(workspaceChanges(review.next).map(({ path, before, after }) => [path, before === null, after === null]), [
    ['b/c/common.tokens.json', true, false], ['local.tokens.json', false, false], ['a/shared.tokens.json', false, true],
  ]);
  assert.ok(reviewSourcePath(workspace, 'a/shared.tokens.json').validationErrors?.some(problem => problem.includes('from')));
});

await test('reviews atomic bulk edits across files and preserves sibling fields', () => {
  const workspace = openWorkspace('Example', [{
    path: 'small.tokens.json',
    text: '{\n  "space": {\n    "small": {\n      "$type": "dimension",\n      "$value": { "value": 4, "unit": "px" },\n      "$extensions": { "org.test": { "source": "authored" } }\n    }\n  }\n}\n',
  }, {
    path: 'wide.tokens.json',
    text: '{"space":{"large":{"$type":"dimension","$value":{"value":12,"unit":"rem"}}},"consumer":{"$type":"dimension","$value":"{space.small}"},"other":{"$type":"number","$value":9}}',
  }]);
  const selection = ['space.small', 'space.large'];
  const review = reviewBulkEdit(workspace, selection, { kind: 'value', pointer: '/value', value: 8 });
  assert.deepEqual(review.validationErrors, []);
  assert.deepEqual(review.bulk?.records, [
    { path: 'space.small', before: 4, after: 8 }, { path: 'space.large', before: 12, after: 8 },
  ]);
  assert.deepEqual(review.next.graph.resolved.get('space.large'), { value: 8, unit: 'rem' });
  assert.deepEqual(review.next.graph.resolved.get('consumer'), { value: 8, unit: 'px' });
  assert.match(review.next.files[0]?.text ?? '', /      "\$extensions": \{ "org.test": \{ "source": "authored" \} \}/u);
  assert.equal(workspaceChanges(review.next).length, 2);
  const mixed = reviewBulkEdit(workspace, [...selection, 'other'], { kind: 'value', value: 10 });
  assert.ok(mixed.validationErrors?.some(error => error.startsWith('space.small')));
  assert.ok(mixed.validationErrors?.some(error => error.startsWith('space.large')));
  const unavailable = reviewBulkEdit(workspace, [...selection, 'consumer'], { kind: 'value', pointer: '/value', value: 8 });
  assert.ok(unavailable.validationErrors?.some(error => error.startsWith('consumer')));
  const described = reviewBulkEdit(workspace, selection, { kind: 'description', value: 'Spacing scale' });
  const cleared = reviewBulkEdit(described.next, selection, { kind: 'description', value: '' });
  assert.equal(cleared.next.graph.tokens.get('space.small')?.node.$description, undefined);
});

await test('validates the declared type of bulk field links in partially unresolved tokens', () => {
  const workspace = openWorkspace('Example', [{ path: 'tokens.json', text: JSON.stringify({
    first: { $type: 'dimension', $value: { value: 4, unit: '{missingUnit}' } },
    second: { $type: 'dimension', $value: { value: 7, unit: '{missingUnit}' } },
    weight: { $type: 'fontWeight', $value: 500 },
    length: { $type: 'number', $value: 8 },
  }) }]);
  const update = (value: string) => reviewBulkEdit(workspace, ['first', 'second'], { kind: 'value', value, pointer: '/value' });
  assert.equal(update('{weight}').validationErrors?.filter(issue => issue.includes('Expected a number reference, found fontWeight')).length, 2);
  assert.deepEqual(update('{length}').validationErrors, []);
});

await test('pastes a group from a captured clipboard, rewrites copied links, and merges file fragments', () => {
  const source = openWorkspace('Source', [
    { path: 'a.tokens.json', text: '{"theme":{"base":{"$type":"number","$value":4},"$extensions":{"org.example":{"opaque":{"$ref":"#/theme/base"}}}}}' },
    { path: 'b.tokens.json', text: '{"theme":{"alias":{"$type":"number","$value":"{theme.base}"},"field":{"$type":"number","$value":{"$ref":"a.tokens.json#/theme/base/$value"}}}}' },
  ]);
  const clipboard = decodeClipboard(encodeClipboard(copyEntries(source, ['theme'])));
  const destination = openWorkspace('Destination', [
    { path: 'local.tokens.json', text: '{"dest":{"original":{"$type":"number","$value":7}}}' },
  ]);
  const pasted = reviewPaste(destination, clipboard, [{ path: 'theme', to: 'dest.brand', file: 'local.tokens.json' }]);
  assert.deepEqual(pasted.next.graph.resolved.get('dest.brand.alias'), 4);
  assert.deepEqual(pasted.next.graph.resolved.get('dest.brand.field'), 4);
  assert.equal(pasted.structure?.referencesUpdated, 2);
  assert.match(pasted.next.files[0]?.text ?? '', /"#\/dest\/brand\/base\/%24value"/u);
  assert.match(pasted.next.files[0]?.text ?? '', /"#\/theme\/base"/u);
  assert.equal(pasted.next.graph.resolved.get('dest.original'), 7);
  assert.throws(() => reviewPaste(destination, clipboard, [{ path: 'theme', to: 'dest.original', file: 'local.tokens.json' }]), /already exists/u);
});

await test('previews broken external links and preserves the original after a paste', () => {
  const source = openWorkspace('Source', [
    { path: 'a.tokens.json', text: '{"base":{"$type":"number","$value":4},"ref":{"$type":"number","$value":"{base}"}}' },
  ]);
  const clipboard = copyEntries(source, ['ref']);
  const empty = openWorkspace('Other', [{ path: 'tokens.json', text: '{}' }]);
  const broken = reviewPaste(empty, clipboard, [{ path: 'ref', to: 'copy', file: 'tokens.json' }]);
  assert.ok(broken.validationErrors?.some(issue => issue.includes('base')));
  assert.equal(empty.files[0]?.text, '{}');
  const copied = reviewPaste(source, clipboard, [{ path: 'ref', to: 'new', file: 'a.tokens.json' }]);
  assert.equal(copied.next.graph.tokens.get('ref')?.value, '{base}');
  assert.equal(copied.next.graph.tokens.get('new')?.value, '{base}');
});

await test('duplicates inherited tokens with pointers scoped to their authored file', () => {
  const workspace = openWorkspace('Example', [
    { path: 'base.tokens.json', text: '{"outside":{"$type":"number","$value":6},"base":{"nested":{"gap":{"$type":"number","$value":{"$ref":"#/outside/$value"}}}}}' },
    { path: 'derived.tokens.json', text: '{"derived":{"$extends":"base.tokens.json#/base"}}' },
  ]);
  const original = workspace.graph.tokens.get('derived.nested.gap');
  assert.ok(original?.inheritedFrom);
  const review = reviewDuplicate(workspace, [{ path: 'derived.nested.gap', to: 'derived.gap-copy', file: 'derived.tokens.json' }]);
  assert.deepEqual(review.next.graph.tokens.get('derived.gap-copy')?.value, { $ref: 'base.tokens.json#/outside/%24value' });
  assert.equal(review.next.graph.resolved.get('derived.gap-copy'), 6);
  assert.deepEqual(review.next.graph.tokens.get('derived.nested.gap')?.inheritedFrom, original.inheritedFrom);
});

await test('final and hosted review retain the diagnostics of an unchanged moved token', () => {
  const baseline = [{ path: 'tokens.json', text: '{"before":{"$type":"number","$value":"{missing}","$description":12}}' }];
  const original = openWorkspace('Example', baseline);
  const move = reviewMove(original, { path: 'before', to: 'after', file: 'tokens.json' }, true);
  assert.deepEqual(move.validationErrors ?? [], []);
  assert.deepEqual(reviewWorkspace(move.next).validationErrors ?? [], []);
  assert.deepEqual(reviewRepositorySources('Example', baseline, move.next.files).validationErrors ?? [], []);
  const invalid = reviewRepositorySources('Example', baseline, [{
    path: 'tokens.json', text: '{"after":{"$type":"number","$value":"{missing}","$description":13}}',
  }]);
  assert.ok(invalid.validationErrors?.some(problem => problem.includes('$description')));
});

await test('bulk type changes replace incompatible values and retain compatible values', () => {
  const workspace = openWorkspace('Example', [
    { path: 'a.tokens.json', text: '{"spacing":{"$type":"dimension","$value":{"value":4,"unit":"rem"}}}' },
    { path: 'b.tokens.json', text: '{"count":{"$type":"number","$value":2}}' },
  ]);
  const result = reviewBulkEdit(workspace, ['spacing', 'count'], { kind: 'type', value: 'dimension',
    replacement: { value: 8, unit: 'px' } });
  assert.deepEqual(result.validationErrors, []);
  assert.deepEqual(result.next.graph.resolved.get('spacing'), { value: 4, unit: 'rem' });
  assert.deepEqual(result.next.graph.resolved.get('count'), { value: 8, unit: 'px' });
  assert.deepEqual(result.bulk?.records.map(record => record.path), ['count']);
});
