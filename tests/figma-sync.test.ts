import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { openWorkspace, workspaceChanges } from '../lib/workspace.ts';
import { figmaBundle, proposalReview, readBundle, sourceRevision } from '../integrations/figma/projection.ts';
import { acknowledgedPull, changedValues, importedValue, pullConflicts, pullValues } from '../integrations/figma/merge.ts';
import { proposalPull } from '../integrations/figma/proposal-pull.ts';
import { isBundle, isTokenProposal } from '../integrations/figma/contract.ts';
import { parseConnection } from '../integrations/figma/transport.ts';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { sourceNumber } from '../figma/native-values.ts';
import { cubicFromPoints, isCubicEasing, roundedEasing, sourceEasing, parseEasingInput } from '../integrations/figma/easing.ts';

const source = '\uFEFF{\r\n  "sevan": {"sys": {"space": {"$type":"dimension", "$value":{"value":8,"unit":"dp"}, "$description":"Avstånd", "$extensions":{"example":{"keep":true}}}, "alias": {"$type":"dimension", "$value":"{sevan.sys.space}"}, "curve":{"$type":"cubicBezier","$value":[0.2,0,0,1]}}}\r\n}\r\n';
const workspace = () => openWorkspace('Sevan', [{ path: 'tokens/system.tokens.json', text: source }]);

await test('cubic Bézier edits retain untouched coordinate spelling, aliases and source bytes', async () => {
  const text = '\uFEFF{\r\n "curve":{"$type":"cubicBezier","$value":[1.23456789e-1, -0.125, 0.876543211, 1.125],"$extensions":{"keep":true}},\r\n "alias":{"$type":"cubicBezier","$value":"{curve}"}\r\n}\r\n';
  const original = openWorkspace('Easing', [{ path: 'easing.json', text }]); const projected = await figmaBundle(original); assert(isBundle(projected));
  assert.equal(projected.unsupported.length, 0); const row = projected.variables[0]; assert(row && isCubicEasing(row.value));
  const local = new Map(projected.variables.map(token => [token.path, importedValue(token)]));
  local.set('curve', sourceEasing(roundedEasing(row.value), row.value)); assert.equal(changedValues(projected, local).changes.length, 0);
  const changed = cubicFromPoints([0.123456789, -0.25, 0.876543211, 1.125]); assert(changed);
  local.set('curve', sourceEasing(roundedEasing(changed), row.value));
  const proposal = changedValues(projected, local); assert.equal(proposal.changes.length, 1);
  assert.equal(proposalReview(original, projected, proposal).next.files[0]?.text, text.replace('-0.125', '-0.25'));
  local.set('curve', { type: 'QUICK' }); assert.throws(() => changedValues(projected, local), /no cubic Bézier mapping/u);
  assert.throws(() => parseEasingInput('["",0,0,1]'), /finite/u); assert.throws(() => parseEasingInput('[1.1,0,0,1]'), /between/u);
  assert.deepEqual(parseEasingInput('["0.2","-0.5",0,1.5]'), cubicFromPoints([0.2, -0.5, 0, 1.5]));
});

await test('duration projection retains authored units, references and source bytes while editing timing values', async () => {
  const text = '\uFEFF{\r\n "delay":{"$type":"duration","$value":{"value":300,"unit":"ms"},"$extensions":{"example":{"keep":true}}},\r\n "seconds":{"$type":"duration","$value":{"value":0.3,"unit":"s"}},\r\n "alias":{"$type":"duration","$value":"{delay}"}\r\n}\r\n';
  const original = openWorkspace('Timing', [{ path: 'tokens/timing.json', text }]); const projected = await figmaBundle(original);
  assert(isBundle(projected)); assert.equal(projected.unsupported.length, 0);
  assert.deepEqual(projected.variables.map(row => [row.path, row.type, row.value, row.unit]), [['delay', 'TIMING', 300, 'ms'], ['seconds', 'TIMING', 0.3, 's'], ['alias', 'TIMING', 300, 'ms']]);
  const local = new Map(projected.variables.map(row => [row.path, importedValue(row)])); assert.deepEqual(changedValues(projected, local).changes, []);
  local.set('delay', 400);
  const proposal = changedValues(projected, local); assert.deepEqual(proposal.changes, [{ path: 'delay', before: { value: 300, unit: 'ms' }, after: { value: 400, unit: 'ms' } }]);
  const review = proposalReview(original, projected, proposal); assert.equal(review.validationErrors?.length ?? 0, 0);
  assert.equal(review.next.files[0]?.text, text.replace('300', '400'));
  local.set('delay', 300); local.set('alias', { alias: 'seconds' });
  assert.deepEqual(changedValues(projected, local).changes, [{ path: 'alias', before: '{delay}', after: '{seconds}' }]);
  local.set('delay', -1); assert.throws(() => changedValues(projected, local), /non-negative duration/u);
  assert.throws(() => pullValues(projected, projected, local), /negative/u);
});

await test('Figma round trips only edited values and retains original units, aliases, metadata and source bytes', async () => {
  const original = workspace();
  const bundle = await figmaBundle(original);
  assert(isBundle(bundle));
  assert.equal(bundle.variables.length, 3);
  assert.equal(bundle.unsupported.length, 0);
  assert.equal(bundle.files[0]?.text, source);
  const local = new Map(bundle.variables.map(row => [row.path, importedValue(row)]));
  assert.deepEqual(changedValues(bundle, local).changes, []);
  local.set('sevan.sys.space', 12);
  const proposal = changedValues(bundle, local);
  assert(isTokenProposal(proposal));
  assert.deepEqual(proposal.changes, [{ path: 'sevan.sys.space', before: { value: 8, unit: 'dp' }, after: { value: 12, unit: 'dp' } }]);
  const review = proposalReview(original, bundle, proposal);
  assert.equal(review.validationErrors?.length ?? 0, 0);
  const edited = review.next.files[0]?.text;
  assert(edited);
  assert.equal(edited, source.replace('"value":8', '"value":12'));
  const updated = await figmaBundle(review.next);
  const restored = new Map(updated.variables.map(row => [row.path, importedValue(row)])); restored.set('sevan.sys.space', 8);
  assert.equal(proposalReview(review.next, updated, changedValues(updated, restored)).next.files[0]?.text, source);
  const oldTree = parseTree(source.slice(1));
  const newTree = parseTree(edited.slice(1));
  assert(oldTree && newTree);
  const oldValue = findNodeAtLocation(oldTree, ['sevan', 'sys', 'space', '$value']);
  const newValue = findNodeAtLocation(newTree, ['sevan', 'sys', 'space', '$value']);
  assert(oldValue && newValue);
  assert.equal(edited.slice(0, newValue.offset + 1), source.slice(0, oldValue.offset + 1));
  assert.equal(edited.slice(newValue.offset + newValue.length + 1), source.slice(oldValue.offset + oldValue.length + 1));
  assert.equal(review.next.graph.resolved.get('sevan.sys.alias') && JSON.stringify(review.next.graph.resolved.get('sevan.sys.alias')), JSON.stringify({ value: 12, unit: 'dp' }));
  assert.equal(workspaceChanges(review.next).length, 1);
  assert.equal(original.files[0]?.text, source);
  await assert.rejects(() => readBundle(JSON.stringify({ ...bundle, files: [{ path: '../bad.tokens.json', text: source }] })), /Invalid/u);
  const forged = await readBundle(JSON.stringify({ ...bundle, variables: [{ path: 'wrong' }] }));
  assert.deepEqual(forged.variables, bundle.variables);
});

await test('a partial native color edit retains untouched source precision, number spelling, layout and escaped units', async () => {
  const text = '\uFEFF{\r\n "ink":{"$type":"color","$value":{"colorSpace":"srgb","components":[1.234567891234e-1,0.234567891234,0.345678912345],"alpha":0.500000001}},\r\n "gap":{"$type":"dimension","$value":{"value":8,"unit":"\\u0064p"}}\r\n}\r\n';
  const precision = openWorkspace('Precision', [{ path: 'tokens/test.tokens.json', text }]); const base = await figmaBundle(precision);
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)]));
  const red = new Map(local); red.set('ink', { r: 0.75, g: Math.fround(0.234567891234), b: Math.fround(0.345678912345), a: Math.fround(0.500000001) });
  assert.equal(proposalReview(precision, base, changedValues(base, red)).next.files[0]?.text, text.replace('1.234567891234e-1', '0.75'));
  local.set('ink', { r: Math.fround(0.1234567891234), g: Math.fround(0.234567891234), b: Math.fround(0.345678912345), a: 0.75 });
  local.set('gap', 10);
  const updated = proposalReview(precision, base, changedValues(base, local));
  assert.equal(updated.next.files[0]?.text, text.replace('"alpha":0.500000001', '"alpha":0.75').replace('"value":8', '"value":10'));
  const next = await figmaBundle(updated.next); const restored = new Map(next.variables.map(row => [row.path, importedValue(row)]));
  restored.set('gap', 8);
  assert.equal(proposalReview(updated.next, next, changedValues(next, restored)).next.files[0]?.text, text.replace('"alpha":0.500000001', '"alpha":0.75'));
});

await test('source identity is deterministic and stale proposals cannot replace newer source values', async () => {
  const bundle = await figmaBundle(workspace());
  const files = [...bundle.files, { path: 'z.tokens.json', text: '{}' }];
  assert.equal(await sourceRevision(files), await sourceRevision(files.toReversed()));
  const local = new Map(bundle.variables.map(row => [row.path, importedValue(row)]));
  local.set('sevan.sys.alias', { alias: 'sevan.sys.space' });
  local.set('sevan.sys.space', 16);
  const proposal = changedValues(bundle, local);
  assert.throws(() => proposalReview(workspace(), bundle, { ...proposal, sourceRevision: '0'.repeat(64) }), /revision/u);
  const latest = openWorkspace('Sevan', [{ path: 'tokens/system.tokens.json', text: source.replace('"value":8', '"value":10') }]);
  assert.throws(() => proposalReview(latest, bundle, proposal), /mismatch/u);
  assert.throws(() => changedValues(bundle, new Map()), /missing/u);
  local.set('sevan.sys.alias', { alias: 'external.variable' });
  assert.throws(() => changedValues(bundle, local), /alias target/u);
});

await test('revision identity uses locale-independent Unicode ordering and exact BOM and line-ending bytes and rejects duplicate paths', async () => {
  const files = [{ path: 'ä.tokens.json', text: '\uFEFF{\r\n}\r\n' }, { path: 'Z.tokens.json', text: '{}' }, { path: 'a.tokens.json', text: '{\n}\n' }];
  const expected = createHash('sha256').update(JSON.stringify([files[1], files[2], files[0]])).digest('hex');
  assert.equal(await sourceRevision(files), expected);
  assert.equal(await sourceRevision(files.toReversed()), expected);
  assert.notEqual(await sourceRevision(files.map(file => ({ path: file.path, text: file.text.replaceAll('\r\n', '\n') }))), expected);
  assert.notEqual(await sourceRevision(files.map(file => ({ path: file.path, text: file.text.replace('\uFEFF', '') }))), expected);
  await assert.rejects(() => sourceRevision([...files, { path: 'Z.tokens.json', text: '{ "other": true }' }]), /unique/u);
});

await test('pull detects concurrent edits and preserves local edits across unrelated remote changes', async () => {
  const base = await figmaBundle(workspace());
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)]));
  local.set('sevan.sys.space', 12);
  assert.deepEqual(pullConflicts(base, base, local), []);
  const incoming = await figmaBundle(openWorkspace('Sevan', [{ path: 'tokens/system.tokens.json', text: source.replace('"value":8', '"value":10') }]));
  assert.equal(pullConflicts(base, incoming, local)[0]?.path, 'sevan.sys.space');
  const accepted = await figmaBundle(openWorkspace('Sevan', [{ path: 'tokens/system.tokens.json', text: source.replace('"value":8', '"value":12') }]));
  assert.deepEqual(pullConflicts(base, accepted, local), []);
});

await test('an undo back to the old value after submission conflicts with a newer author instead of disappearing', async () => {
  const base = await figmaBundle(workspace());
  const incoming = await figmaBundle(openWorkspace('Sevan', [{ path: 'tokens/system.tokens.json', text: source.replace('"value":8', '"value":16') }]));
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)]));
  const receipt = { id: 'saved-12', sourceRevision: base.revision, values: [{ path: 'sevan.sys.space', value: 12 }] };
  const undone = acknowledgedPull(base, incoming, local, receipt);
  assert.deepEqual(pullConflicts(undone.previous, incoming, undone.local), [{ path: 'sevan.sys.space', before: 12, local: 8, remote: 16, beforeUnit: 'dp', remoteUnit: 'dp' }]);
  local.set('sevan.sys.space', 12);
  const untouched = acknowledgedPull(base, incoming, local, receipt);
  assert.deepEqual(pullConflicts(untouched.previous, incoming, untouched.local), []);
  assert.equal(pullValues(untouched.previous, incoming, untouched.local).get('sevan.sys.space'), 16);
});

await test('conflict choices rebase retained and custom Figma edits onto the incoming source without changing the input', async () => {
  const base = await figmaBundle(workspace());
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)]));
  local.set('sevan.sys.space', 12);
  const latest = openWorkspace('Sevan', [{ path: 'tokens/system.tokens.json', text: source.replace('"value":8', '"value":10') }]);
  const incoming = await figmaBundle(latest);
  assert.throws(() => pullValues(base, incoming, local), /every conflicting/u);
  for (const value of [10, 12, 14]) {
    const result = pullValues(base, incoming, local, [{ path: 'sevan.sys.space', value }]);
    const proposal = changedValues(incoming, result);
    if (value === 10) assert.deepEqual(proposal.changes, []);
    else {
      assert.deepEqual(proposal.changes, [{ path: 'sevan.sys.space', before: { value: 10, unit: 'dp' }, after: { value, unit: 'dp' } }]);
      const checked = proposalReview(latest, incoming, proposal);
      assert.equal(checked.validationErrors?.length ?? 0, 0);
    }
  }
  assert.equal(local.get('sevan.sys.space'), 12);
  assert.equal(base.variables.find(row => row.path === 'sevan.sys.space')?.value, 8);
  assert.throws(() => pullValues(base, incoming, local, [{ path: 'sevan.sys.space', value: 'wrong' }]), /wrong type/u);
  assert.throws(() => pullValues(base, incoming, local, [{ path: 'sevan.sys.space', value: { alias: 'missing' } }]), /compatible/u);
  assert.throws(() => pullValues(base, incoming, local, [{ path: 'sevan.sys.space', value: 12 }, { path: 'sevan.sys.space', value: 14 }]), /match/u);
});

await test('pull merges disjoint edits, accepts identical edits, detects alias cycles and requires explicit source-removal choices', async () => {
  const base = await figmaBundle(workspace());
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)]));
  local.set('sevan.sys.alias', 16);
  const incoming = await figmaBundle(openWorkspace('Sevan', [{ path: 'tokens/system.tokens.json', text: source.replace('"value":8', '"value":10') }]));
  const merged = pullValues(base, incoming, local);
  assert.equal(merged.get('sevan.sys.space'), 10);
  assert.equal(merged.get('sevan.sys.alias'), 16);
  local.set('sevan.sys.space', 10);
  assert.equal(pullConflicts(base, incoming, local).length, 0);
  assert.equal(changedValues(incoming, pullValues(base, incoming, local)).changes.length, 1);
  local.set('sevan.sys.space', { alias: 'sevan.sys.alias' });
  local.set('sevan.sys.alias', { alias: 'sevan.sys.space' });
  assert.throws(() => pullValues(base, incoming, local, [{ path: 'sevan.sys.space', value: { alias: 'sevan.sys.alias' } }]), /circular/u);
  const removed = { ...incoming, variables: incoming.variables.filter(row => row.path !== 'sevan.sys.alias') };
  const removedLocal = new Map(base.variables.map(row => [row.path, importedValue(row)]));
  removedLocal.set('sevan.sys.alias', 16);
  assert.throws(() => pullValues(base, removed, removedLocal), /every conflicting/u);
  assert.throws(() => pullValues(base, removed, removedLocal, [{ path: 'sevan.sys.alias', value: 16 }]), /no longer maps/u);
  assert.equal(pullValues(base, removed, removedLocal, [{ path: 'sevan.sys.alias', value: null }]).has('sevan.sys.alias'), false);
});

await test('Foundry reviews concurrent proposals with explicit source, Figma and custom choices', async () => {
  const base = await figmaBundle(workspace());
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)]));
  local.set('sevan.sys.space', 12);
  const proposal = changedValues(base, local);
  const latest = openWorkspace('Sevan', [{ path: 'tokens/system.tokens.json', text: source.replace('"value":8', '"value":10') }]);
  const pending = await proposalPull(latest, base, proposal);
  assert.equal(pending.conflicts.length, 1);
  assert.equal(pending.review, undefined);
  await Promise.all([10, 12, 14].map(async value => {
    const result = await proposalPull(latest, base, proposal, [{ path: 'sevan.sys.space', value }]);
    assert.equal(result.conflicts.length, 0);
    if (value === 10) assert.equal(result.review, undefined);
    else assert.deepEqual(result.review?.next.graph.tokens.get('sevan.sys.space')?.value, { value, unit: 'dp' });
  }));
  const unrelated = openWorkspace('Sevan', [{ path: 'tokens/system.tokens.json', text: source.replace('"$description":"Avstånd"', '"$description":"New description"') }]);
  const merged = await proposalPull(unrelated, base, proposal);
  assert.equal(merged.conflicts.length, 0);
  assert(merged.review?.next.files[0]?.text.includes('New description'));
});

await test('connection codes never send source data or secrets to an arbitrary origin', () => {
  const path = '/figma/workspaces/' + 'a'.repeat(64) + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  assert.equal(parseConnection('http://localhost:5173' + path).secret, 'c'.repeat(64));
  assert.throws(() => parseConnection('http://localhost:5173/figma/sync/' + 'a'.repeat(64) + '#' + 'b'.repeat(64)), /connection code/u);
  assert.throws(() => parseConnection('https://attacker.example' + path), /connection code/u);
  assert.throws(() => parseConnection('https://sevan.foundry.tokencatalog.dev.evil.test' + path), /connection code/u);
});

await test('native float32 storage never creates false edits or rewrites high precision source colors', async () => {
  const files = [{ path: 'float.tokens.json', text: JSON.stringify({
    size: { $type: 'dimension', $value: { value: 67.3, unit: 'sp' } },
    color: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 80 / 255, 79 / 255], hex: '#00504F' } },
  }) }];
  const bundle = await figmaBundle(openWorkspace('Precision', files));
  const local = new Map(bundle.variables.map(row => [row.path, importedValue(row)]));
  const native = { valuesByMode: { source: Math.fround(67.3) }, getPluginData: () => '', setPluginData: () => undefined, setValueForMode: () => undefined };
  const size = sourceNumber(native, 'source', bundle.variables.find(row => row.path === 'size'));
  assert(size !== undefined); local.set('size', size);
  local.set('color', { r: 0, g: Math.fround(80 / 255), b: Math.fround(79 / 255), a: 1 });
  assert.deepEqual(changedValues(bundle, local).changes, []);
  assert.equal(bundle.files[0]?.text, files[0]?.text);
  local.set('size', Math.fround(67.4));
  assert.equal(changedValues(bundle, local).changes.length, 1);
  local.set('color', { r: 1, g: 0, b: 0, a: 0.5 });
  const colorChange = changedValues(bundle, local).changes.find(change => change.path === 'color');
  assert.deepEqual(colorChange?.after, { colorSpace: 'srgb', components: [1, 0, 0], hex: '#FF0000', alpha: 0.5 });
});
