import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { figmaBundle } from '../integrations/figma/projection.ts';
import { openWorkspace } from '../lib/workspace.ts';
import { isBundle, isFigmaValue, isTokenProposal, sameSourceValue } from '../integrations/figma/contract.ts';
import type { FigmaValue, TokenProposal, VariableRow } from '../integrations/figma/contract.ts';
import { isRecord, requireValue } from '../lib/json.ts';
import { readStored, writeStored } from '../figma/storage.ts';
import { identifySubmission } from '../integrations/figma/submission.ts';
import { createWorkspace, offerWorkspace, pairDocument, receiveChanges, registerReplica, resumeReplica } from '../integrations/workspace/model.ts';
import { cubicFromPoints, isCubicEasing, roundedEasing } from '../integrations/figma/easing.ts';

const compiled = await build({ entryPoints: ['figma/code.ts'], bundle: true, format: 'iife', target: 'es2020', write: false });
const code = requireValue(compiled.outputFiles[0]?.text, 'Controller bundle');
const scaled = await build({ entryPoints: ['figma/code.ts'], bundle: true, format: 'iife', target: 'es2020', write: false,
  plugins: [{ name: 'test-native-units', setup(context) {
    context.onResolve({ filter: /^\.\/library-adapter\.ts$/ }, () => ({ path: 'adapter', namespace: 'native-units' }));
    context.onLoad({ filter: /^adapter$/, namespace: 'native-units' }, () => ({ contents: "export const libraryAdapter = { name: 'Opacity fixture', numberScale: path => path.endsWith('opacity') ? 100 : 1 };" }));
  } }] });
const scaledCode = requireValue(scaled.outputFiles[0]?.text, 'Scaled controller bundle');
const library = await build({ entryPoints: ['figma/code.ts'], bundle: true, format: 'iife', target: 'es2020', write: false,
  plugins: [{ name: 'test-library-source', setup(context) {
    context.onResolve({ filter: /^\.\/library-adapter\.ts$/ }, () => ({ path: 'adapter', namespace: 'library-source' }));
    context.onLoad({ filter: /^adapter$/, namespace: 'library-source' }, () => ({ contents: "export const libraryAdapter = { name: 'Fixture', required: ['space'], build: async rows => { if (rows.has('archived')) throw new Error('Archived variables reached the adapter'); return { components: 1, variants: 1, pages: [] }; } };" }));
  } }] });
const libraryCode = requireValue(library.outputFiles[0]?.text, 'Library controller bundle');
const snapshot = (space: number, alias = '{space}') => figmaBundle(openWorkspace('Test', [{ path: 'tokens/test.tokens.json',
  text: JSON.stringify({ space: { $type: 'dimension', $value: { value: space, unit: 'px' } }, alias: { $type: 'dimension', $value: alias } }) }]));
const timingSnapshot = (value: number, unit: string) => figmaBundle(openWorkspace('Timing', [{ path: 'timing.json', text: JSON.stringify({ delay: { $type: 'duration', $value: { value, unit } } }) }]));
const curve = (points: number[]) => requireValue(cubicFromPoints(points), 'Curve');
const easingSnapshot = (points: number[]) => figmaBundle(openWorkspace('Easing', [{ path: 'easing.json', text: JSON.stringify({ curve: { $type: 'cubicBezier', $value: points }, alias: { $type: 'cubicBezier', $value: '{curve}' } }) }]));
type NativeValue = FigmaValue | { type: 'VARIABLE_ALIAS'; id: string };
interface FakeVariable {
  id: string; name: string; description: string; resolvedType: VariableRow['type']; variableCollectionId: string;
  valuesByMode: Record<string, NativeValue>; scopes: string[]; hiddenFromPublishing: boolean;
  getPluginData: (key: string) => string; setPluginData: (key: string, value: string) => void;
  setValueForMode: (mode: string, value: unknown) => void;
}
function pluginData() {
  const values = new Map<string, string>();
  return { getPluginData: (key: string) => values.get(key) ?? '', setPluginData: (key: string, value: string) => { values.set(key, value); } };
}
const isStringValue = (value: unknown): value is { value: string } => isRecord(value) && typeof value['value'] === 'string';
function fixture(initialCode = code) {
  let currentCode = initialCode;
  const data = new Map<string, string>();
  const snapshotWrites: string[] = [];
  let failKey = '';
  let writesBeforeFailure = -1;
  let undoCommits = 0;
  const collections: { id: string; key: string; name: string; hiddenFromPublishing: boolean; defaultModeId: string; modes: { modeId: string; name: string }[];
    renameMode: (id: string, name: string) => void; getPluginData: (key: string) => string; setPluginData: (key: string, value: string) => void }[] = [];
  const variables: FakeVariable[] = [];
  const messages: Record<string, unknown>[] = [];
  let notifyMessage: (() => void) | undefined;
  const ui = { onmessage: (_message: unknown): void => undefined, postMessage: (message: unknown) => {
    if (isRecord(message)) messages.push(message);
    notifyMessage?.();
  } };
  const root = { getPluginData: (key: string) => data.get(key) ?? '', setPluginData: (key: string, value: string) => {
    snapshotWrites.push(key);
    if (key === failKey) { failKey = ''; throw new Error('Injected snapshot write failure'); }
    data.set(key, value);
  } };
  const device = new Map<string, unknown>();
  const api = { ui, root, showUI: () => undefined, notify: () => undefined, commitUndo: () => { undoCommits++; },
    clientStorage: { keysAsync: () => Promise.resolve([...device.keys()]), getAsync: (key: string) => Promise.resolve(device.get(key)), setAsync: (key: string, value: unknown) => { device.set(key, value); return Promise.resolve(); }, deleteAsync: (key: string) => { device.delete(key); return Promise.resolve(); } }, variables: {
    getLocalVariableCollectionsAsync: () => Promise.resolve(collections), getLocalVariablesAsync: () => Promise.resolve(variables),
    createVariableCollection: (name: string) => {
      const collection = { id: 'collection-' + collections.length, key: 'collection-key-' + collections.length, hiddenFromPublishing: false, name, defaultModeId: 'source', modes: [{ modeId: 'source', name: 'Source' }],
        renameMode: (_id: string, _name: string) => undefined, ...pluginData() };
      collections.push(collection); return collection;
    },
    createVariable: (name: string, collection: { id: string }, type: VariableRow['type']) => {
      let variableScopes: string[] = [];
      const variable: FakeVariable = { id: 'variable-' + variables.length, name, description: '', resolvedType: type,
        variableCollectionId: collection.id, valuesByMode: { source: type === 'EASING' ? requireValue(cubicFromPoints([0.5, 0, 0.5, 1]), 'Native default curve') : 0 }, get scopes() { return variableScopes; },
        set scopes(value: string[]) { if (type === 'TIMING' || type === 'EASING') throw new Error('Cannot set scopes on this variable type'); variableScopes = value; }, hiddenFromPublishing: false, ...pluginData(),
        setValueForMode: (mode, value) => {
          if (writesBeforeFailure === 0) { writesBeforeFailure = -1; throw new Error('Injected native value failure'); }
          if (writesBeforeFailure > 0) writesBeforeFailure--;
          if ((type === 'TIMING' || type === 'FLOAT') && typeof value === 'number') {
            if (!Number.isFinite(Math.fround(value))) throw new Error('Value exceeds the native float range');
            variable.valuesByMode[mode] = Math.fround(value);
          }
          else if (type === 'EASING' && isCubicEasing(value)) variable.valuesByMode[mode] = roundedEasing(value);
          else if (isFigmaValue(value)) variable.valuesByMode[mode] = value;
          else if (isRecord(value) && value['type'] === 'VARIABLE_ALIAS' && typeof value['id'] === 'string') variable.valuesByMode[mode] = { type: 'VARIABLE_ALIAS', id: value['id'] };
          else throw new Error('Invalid native value');
        } };
      variables.push(variable); return variable;
    },
    createVariableAlias: (variable: FakeVariable) => ({ type: 'VARIABLE_ALIAS', id: variable.id }),
  } };
  const restart = (nextCode = currentCode) => { currentCode = nextCode; runInNewContext(currentCode, { figma: api, __html__: '', setTimeout, console: { error: () => undefined } }); };
  restart();
  const send = async (message: { type: string; [key: string]: unknown }) => {
    const offset = messages.length;
    const owns = (item: Record<string, unknown>) => item['request'] === message.type &&
      (message['serial'] === undefined || item['serial'] === message['serial']) && (message['client'] === undefined || item['client'] === message['client']);
    const terminal = message.type === 'inspect' || message.type === 'edit' || message.type === 'resolve-native-unit' ? ['state', 'error'] :
      message.type === 'save-token-forms' ? ['token-forms-saved', 'token-forms-error', 'error'] : message.type === 'restore-token-forms' ? ['saved-token-forms', 'token-forms-error', 'error'] :
      message.type === 'remember-connection' ? ['connection-saved', 'connection-storage-error', 'error'] : message.type === 'restore-connection' ? ['saved-connection', 'error'] :
        message.type === 'forget-connection' ? ['connection-forgotten', 'error'] :
        message.type === 'proposal' ? ['proposal', 'error'] : message.type === 'cancel-pull' ? ['pull-cancelled'] : message.type === 'build-library' ? ['library-built', 'error'] : ['pulled', 'conflicts', 'error'];
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { notifyMessage = undefined; reject(new Error('Controller did not complete ' + message.type)); }, 2000);
      notifyMessage = () => {
        const found = messages.slice(offset).find(item => owns(item) && terminal.includes(String(item['type'])));
        if (found) { clearTimeout(timer); notifyMessage = undefined; resolve(found); }
      };
    });
    ui.onmessage(message);
    const completed = await result;
    // Error handling refreshes state before posting its terminal error. Drain that queued callback.
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    return messages.slice(offset).find(item => owns(item) && item['type'] === 'error') ?? completed;
  };
  const edit = async (input: { path: string; value?: FigmaValue; alias?: string }) => {
    const state = await send({ type: 'inspect' });
    const source = state['bundle'];
    assert(isRecord(source));
    const local = state['local'];
    assert(Array.isArray(local));
    const before: unknown = local.find((row: unknown) => isRecord(row) && row['path'] === input.path);
    assert(isRecord(before));
    return send({ type: 'edit', ...input, revision: source['revision'], expected: before['value'] });
  };
  return { send, dispatch: (message: unknown) => ui.onmessage(message), nativeVariables: api.variables, edit, restart, root, variables, collections, messages, snapshotWrites, undoCount: () => undoCommits,
    variable: (path: string) => requireValue(variables.find(variable => variable.getPluginData('foundry-token-path') === path), path),
    failSnapshot: () => { failKey = 'foundry-snapshot-head'; }, failValueAfter: (count: number) => { writesBeforeFailure = count; },
    addMode: () => { collections[0]?.modes.push({ modeId: 'other', name: 'Other context' }); } };
}

await test('native submission identity survives restart and changes after consuming a receipt without export document writes', async () => {
  const app = fixture(); const base = await snapshot(8); const accepted = await snapshot(12); const id = 'a'.repeat(64);
  await app.send({ type: 'pull', bundle: base }); await app.edit({ path: 'space', value: 12 });
  const writes = app.snapshotWrites.length; const undo = app.undoCount();
  const reply = await app.send({ type: 'proposal', id, serial: 37 });
  assert.equal(reply['serial'], 37);
  const first = reply['proposal'];
  assert(isRecord(first) && typeof first['intentId'] === 'string' && typeof first['intentSequence'] === 'number');
  assert.deepEqual(JSON.parse(JSON.stringify(first)), await identifySubmission({ schemaVersion: 1, sourceRevision: base.revision,
    changes: [{ path: 'space', before: { value: 8, unit: 'px' }, after: { value: 12, unit: 'px' } }] }, '', id, first['intentId'], first['intentSequence']));
  app.restart(); assert.equal(JSON.stringify((await app.send({ type: 'proposal', id }))['proposal']), JSON.stringify(first));
  assert.equal(app.snapshotWrites.length, writes); assert.equal(app.undoCount(), undo);
  const acknowledgement = { id: 'accepted-12', sourceRevision: base.revision, values: [{ path: 'space', value: 12 }] };
  await app.send({ type: 'pull', bundle: accepted, acknowledgement }); await app.send({ type: 'pull', bundle: base });
  await app.edit({ path: 'space', value: 12 }); app.restart();
  const fresh = (await app.send({ type: 'proposal', id }))['proposal']; assert(isRecord(fresh) && isRecord(first));
  assert.equal(fresh['acknowledgedReceipt'], acknowledgement.id); assert.equal(fresh['workspaceId'], id);
  assert.notEqual(fresh['submissionId'], first['submissionId']);
  assert.equal(JSON.stringify(fresh['changes']), JSON.stringify(first['changes']));
});

await test('an active controller observes a snapshot and receipt saved by another device without document or Undo writes', async () => {
  const app = fixture(); const base = await snapshot(8); const next = await snapshot(12);
  await app.send({ type: 'pull', bundle: base });
  writeStored(app.root, 'foundry-snapshot-head', { bundle: await snapshot(10), receipt: 'intermediate-receipt' });
  writeStored(app.root, 'foundry-snapshot-head', { bundle: next, receipt: 'other-device-receipt' });
  app.variable('space').valuesByMode['source'] = 12;
  const writes = app.snapshotWrites.length; const undo = app.undoCount();
  const state = await app.send({ type: 'inspect' });
  assert(isBundle(state['bundle'])); assert.equal(state['bundle'].revision, next.revision);
  assert.equal(state['acknowledgedReceipt'], 'other-device-receipt'); assert.equal(state['changed'], 0);
  assert.equal(app.snapshotWrites.length, writes); assert.equal(app.undoCount(), undo);
});

await test('native 12 to 14 to 12 keeps distinct ordered intent and a stable retry after reopening', async () => {
  const app = fixture(); await app.send({ type: 'pull', bundle: await snapshot(8) }); const id = 'a'.repeat(64);
  const proposals = await [12, 14, 12].reduce(async (previous, value) => {
    const gathered = await previous;
    await app.edit({ path: 'space', value }); const reply = await app.send({ type: 'proposal', id });
    assert(isTokenProposal(reply['proposal'])); return [...gathered, reply['proposal']];
  }, Promise.resolve<TokenProposal[]>([]));
  assert.equal(new Set(proposals.map(proposal => proposal.submissionId)).size, 3);
  assert.equal(new Set(proposals.map(proposal => proposal.intentId)).size, 1);
  assert.deepEqual(proposals.map(proposal => proposal.intentSequence), [2, 3, 4]);
  app.restart(); const retry = await app.send({ type: 'proposal', id });
  assert.equal(JSON.stringify(retry['proposal']), JSON.stringify(proposals[2]));
});

await test('an older acknowledgement cannot erase a fresh native edit or roll its consumed context back', async () => {
  const app = fixture(); const base = await snapshot(8); const twelve = await snapshot(12); const id = 'a'.repeat(64);
  await app.send({ type: 'pull', bundle: base }); await app.send({ type: 'proposal', id });
  const accepted = { id: 'device:20', sourceRevision: base.revision, values: [{ path: 'space', value: 12 }] };
  await app.edit({ path: 'space', value: 12 }); await app.send({ type: 'pull', bundle: twelve, acknowledgement: accepted });
  const restored = { id: 'device:30', sourceRevision: twelve.revision, values: [{ path: 'space', value: 8 }] };
  await app.send({ type: 'pull', bundle: base, acknowledgement: restored }); await app.edit({ path: 'space', value: 12 });
  const delayed = await app.send({ type: 'pull', bundle: base, acknowledgement: accepted });
  assert.equal(delayed['type'], 'pulled'); assert.equal(app.variable('space').valuesByMode['source'], 12);
  const state = await app.send({ type: 'inspect' }); assert.equal(state['acknowledgedReceipt'], restored.id); assert.equal(state['changed'], 1);
});

await test('native proposal failures retain request ownership', async () => {
  const error = await fixture().send({ type: 'proposal', serial: 47, client: 'a'.repeat(64) });
  assert.equal(error['type'], 'error'); assert.equal(error['request'], 'proposal'); assert.equal(error['serial'], 47);
  assert.equal(error['client'], 'a'.repeat(64));
});

await test('native mutation and inspection replies retain their UI session without leaking a previous operation serial', async () => {
  const app = fixture(); const source = await snapshot(8); const client = 'a'.repeat(64);
  const pulled = await app.send({ type: 'pull', bundle: source, serial: 14, client });
  assert.equal(pulled['type'], 'pulled'); assert.equal(pulled['serial'], 14); assert.equal(pulled['client'], client); assert.equal(pulled['request'], 'pull');
  const inspected = await app.send({ type: 'inspect', client: 'b'.repeat(64) });
  assert.equal(inspected['client'], 'b'.repeat(64)); assert.equal(inspected['serial'], undefined); assert.equal(inspected['request'], 'inspect');
});

await test('timing variables use native seconds and preserve authored milliseconds and cross-unit aliases through restart', async () => {
  const files = [{ path: 'tokens/timing.json', text: '{"delay":{"$type":"duration","$value":{"value":300,"unit":"ms"}},"seconds":{"$type":"duration","$value":{"value":0.3,"unit":"s"}},"alias":{"$type":"duration","$value":"{delay}"}}\r\n' }];
  const source = await figmaBundle(openWorkspace('Timing', files)); const app = fixture();
  assert.equal((await app.send({ type: 'pull', bundle: source }))['type'], 'pulled');
  assert.equal(app.variable('delay').resolvedType, 'TIMING'); assert.equal(app.variable('delay').valuesByMode['source'], Math.fround(0.3));
  assert.equal(app.variable('seconds').valuesByMode['source'], Math.fround(0.3)); assert.equal(app.variable('delay').getPluginData('foundry-value-scale'), '0.001');
  const unchanged = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(unchanged)); assert.equal(unchanged.sourceRevision, source.revision); assert.equal(unchanged.changes.length, 0);
  await app.edit({ path: 'delay', value: 400 }); assert.equal(app.variable('delay').valuesByMode['source'], Math.fround(0.4));
  app.variable('delay').valuesByMode['source'] = Math.fround(0.4); app.restart();
  const proposal = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(proposal));
  assert.deepEqual(JSON.parse(JSON.stringify(proposal.changes)), [{ path: 'delay', before: { value: 300, unit: 'ms' }, after: { value: 400, unit: 'ms' } }]);
  await app.edit({ path: 'alias', alias: 'seconds' }); assert.deepEqual(JSON.parse(JSON.stringify(app.variable('alias').valuesByMode['source'])), { type: 'VARIABLE_ALIAS', id: app.variable('seconds').id });
  const aliased = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(aliased));
  assert.deepEqual(JSON.parse(JSON.stringify(aliased.changes[1])), { path: 'alias', before: '{delay}', after: '{seconds}' });
  const before = app.variable('delay').valuesByMode['source']; const undo = app.undoCount();
  const rejected = await app.edit({ path: 'delay', value: -1 }); assert.equal(rejected['type'], 'error'); assert.match(String(rejected['message']), /negative/u);
  assert.equal(app.variable('delay').valuesByMode['source'], before); assert.equal(app.undoCount(), undo);
  const rounded = await app.edit({ path: 'delay', value: 400.000001 }); assert.equal(rounded['type'], 'error'); assert.equal(rounded['code'], 'timing-precision');
  assert.equal(app.variable('delay').valuesByMode['source'], before); assert.equal(app.undoCount(), undo);
  await app.edit({ path: 'seconds', value: 0.4 }); app.variable('seconds').valuesByMode['source'] = Math.fround(0.4);
  const secondsEdit = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(secondsEdit));
  assert.deepEqual(JSON.parse(JSON.stringify(secondsEdit.changes.find(change => change.path === 'seconds'))), { path: 'seconds', before: { value: 0.3, unit: 's' }, after: { value: 0.4, unit: 's' } });
});

await test('easing imports native curves and aliases, retains source precision and exports a changed coordinate through restart', async () => {
  const points = [0.123456789, -0.125, 0.876543211, 1.125]; const source = await easingSnapshot(points); const app = fixture();
  assert.equal((await app.send({ type: 'pull', bundle: source }))['type'], 'pulled');
  const original = app.variable('curve'); assert.equal(original.resolvedType, 'EASING');
  assert.equal(JSON.stringify(original.valuesByMode['source']), JSON.stringify(roundedEasing(curve(points))));
  assert.equal(JSON.stringify(app.variable('alias').valuesByMode['source']), JSON.stringify({ type: 'VARIABLE_ALIAS', id: original.id }));
  app.restart(); const unchanged = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(unchanged)); assert.equal(unchanged.changes.length, 0);
  assert.equal((await app.edit({ path: 'curve', value: curve([points[0] ?? 0, -0.25, points[2] ?? 1, 1.125]) }))['type'], 'state');
  app.restart(); const edited = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(edited));
  assert.deepEqual(JSON.parse(JSON.stringify(edited.changes)), [{ path: 'curve', before: points, after: [0.123456789, -0.25, 0.876543211, 1.125] }]);
  assert.equal(app.variable('curve').id, original.id);
  const undo = app.undoCount(); const rejected = await app.edit({ path: 'curve', value: curve([0.123456781234567, -0.25, 0.876543211, 1.125]) });
  assert.equal(rejected['type'], 'error'); assert.equal(rejected['code'], 'easing-precision'); assert.equal(app.undoCount(), undo);
  original.setValueForMode('source', { type: 'QUICK' }); const state = await app.send({ type: 'inspect' });
  assert.match(String(state['issue']), /no cubic Bézier mapping/u); assert(isBundle(state['bundle']));
  assert.match(JSON.stringify(state['local']), /QUICK/u); assert.equal((await app.send({ type: 'proposal' }))['type'], 'error');
  assert.equal((await app.edit({ path: 'curve', value: curve(points) }))['type'], 'state');
  const repaired = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(repaired)); assert.equal(repaired.changes.length, 0);
  await app.edit({ path: 'curve', alias: 'alias' }); assert.match(String(app.messages.at(-1)?.['message']), /circular/u);
});

await test('easing import resumes a failed initial write and rejects excessive points before journaling', async () => {
  const source = await easingSnapshot([0.2, 0, 0, 1]); const app = fixture(); app.failValueAfter(0);
  assert.equal((await app.send({ type: 'pull', bundle: source }))['type'], 'error'); assert.equal(app.variables.length, 2);
  app.restart(); assert.equal((await app.send({ type: 'resume-pull' }))['type'], 'pulled'); assert.equal(app.variables.length, 2);
  const unchanged = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(unchanged)); assert.equal(unchanged.changes.length, 0);
  const excessive = fixture(); const rejected = await excessive.send({ type: 'pull', bundle: await easingSnapshot([0.2, 1e40, 0, 1]) });
  assert.equal(rejected['type'], 'error'); assert.match(String(rejected['message']), /native number range/u);
  assert.equal(excessive.variables.length, 0); assert.equal(excessive.collections.length, 0); assert.equal(excessive.root.getPluginData('foundry-operation-head'), '');
});

await test('custom numeric and easing conflict choices cannot silently consume precision and can be corrected in the same review', async () => {
  await Promise.all(['timing', 'easing', 'number'].map(async kind => {
    const app = fixture();
    const base = kind === 'number' ? await snapshot(8) : kind === 'timing' ? await timingSnapshot(300, 'ms') : await easingSnapshot([0.2, 0, 0, 1]);
    const incoming = kind === 'number' ? await snapshot(10) : kind === 'timing' ? await timingSnapshot(500, 'ms') : await easingSnapshot([0.4, 0, 0, 1]);
    const path = kind === 'number' ? 'space' : kind === 'timing' ? 'delay' : 'curve'; const local = kind === 'number' ? 12 : kind === 'timing' ? 400 : curve([0.3, 0, 0, 1]);
    const excessivePrecision = kind === 'number' ? 12.0000001 : kind === 'timing' ? 400.000001 : curve([0.123456781234567, 0, 0, 1]);
    await app.send({ type: 'pull', bundle: base }); await app.edit({ path, value: local });
    const before = JSON.stringify(app.variable(path).valuesByMode); const undo = app.undoCount();
    const review = await app.send({ type: 'pull', bundle: incoming }); assert.equal(review['type'], 'conflicts');
    const refused = await app.send({ type: 'resolve-pull', id: review['id'], choices: [{ path, value: excessivePrecision }] });
    assert.equal(refused['type'], 'error'); assert.match(String(refused['message']), /round-trip/u);
    assert.equal(JSON.stringify(app.variable(path).valuesByMode), before); assert.equal(app.undoCount(), undo); assert.equal(app.root.getPluginData('foundry-operation-head'), '');
    assert.equal((await app.send({ type: 'resolve-pull', id: review['id'], choices: [{ path, value: local }] }))['type'], 'pulled');
    const proposal = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(proposal)); assert.equal(proposal.changes[0]?.path, path);
  }));
});

await test('scalar float32 values retain authored precision and ordinary decimal edits while rejecting collapsed input', async () => {
  const source = await figmaBundle(openWorkspace('Scalar', [{ path: 'scalar.json', text: '{"value":{"$type":"number","$value":0.1234567891234}}' }]));
  const app = fixture(); await app.send({ type: 'pull', bundle: source });
  assert.equal(app.variable('value').valuesByMode['source'], Math.fround(0.1234567891234));
  const unchanged = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(unchanged)); assert.equal(unchanged.changes.length, 0);
  assert.equal((await app.edit({ path: 'value', value: 0.3 }))['type'], 'state'); app.restart();
  const edited = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(edited));
  assert.deepEqual(JSON.parse(JSON.stringify(edited.changes)), [{ path: 'value', before: 0.1234567891234, after: 0.3 }]);
  const undo = app.undoCount(); const rejected = await app.edit({ path: 'value', value: 0.300000001 });
  assert.equal(rejected['code'], 'number-precision'); assert.equal(app.variable('value').valuesByMode['source'], Math.fround(0.3)); assert.equal(app.undoCount(), undo);
});

await test('a newly supported timing projection imports with the same source revision without rewriting an unchanged legacy mapping', async () => {
  const source = await figmaBundle(openWorkspace('Timing', [{ path: 'timing.json', text: '{"space":{"$type":"number","$value":8},"delay":{"$type":"duration","$value":{"value":300,"unit":"ms"}}}' }]));
  const legacy = { ...source, variables: source.variables.filter(row => row.type !== 'TIMING'), unsupported: [{ path: 'delay', reason: 'Legacy projection' }] };
  const app = fixture(); await app.send({ type: 'pull', bundle: legacy });
  assert.equal(app.collections[0]?.getPluginData('foundry-mapping-version'), '4:generic');
  assert.equal((await app.send({ type: 'pull', bundle: source }))['type'], 'pulled');
  assert.equal(app.variable('delay').valuesByMode['source'], Math.fround(0.3)); assert.equal(app.variable('space').valuesByMode['source'], 8);
  const writes = app.snapshotWrites.length; const undo = app.undoCount();
  await app.send({ type: 'pull', bundle: source }); assert.equal(app.snapshotWrites.length, writes); assert.equal(app.undoCount(), undo);
});

await test('an interrupted legacy timing creation resumes its untouched default and retains an actual later native edit', async () => {
  const source = await figmaBundle(openWorkspace('Timing', [{ path: 'timing.json', text: '{"delay":{"$type":"duration","$value":{"value":300,"unit":"ms"}}}' }]));
  await Promise.all([0, Math.fround(0.4)].map(async value => {
    const app = fixture(); const collection = app.nativeVariables.createVariableCollection('Timing · Tokens'); collection.setPluginData('foundry-collection', '1');
    const variable = app.nativeVariables.createVariable('delay', collection, 'TIMING'); variable.setPluginData('foundry-token-path', 'delay'); variable.valuesByMode['source'] = value;
    writeStored(app.root, 'foundry-operation-head', { next: source, beforeRevision: '', local: [], desired: [{ path: 'delay', value: 300 }] }); app.restart();
    const resumed = await app.send({ type: 'resume-pull' });
    if (value === 0) { assert.equal(resumed['type'], 'pulled'); assert.equal(variable.valuesByMode['source'], Math.fround(0.3)); }
    else {
      assert.equal(resumed['type'], 'conflicts'); assert.equal(variable.valuesByMode['source'], value);
      assert.deepEqual(JSON.parse(JSON.stringify(resumed['conflicts'])), [{ path: 'delay', before: 0, local: 400, remote: 300, beforeUnit: 'ms', remoteUnit: 'ms' }]);
      assert.equal((await app.send({ type: 'resolve-pull', id: resumed['id'], choices: [{ path: 'delay', value: 400 }] }))['type'], 'pulled');
      const proposal = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(proposal));
      assert.deepEqual(JSON.parse(JSON.stringify(proposal.changes)), [{ path: 'delay', before: { value: 300, unit: 'ms' }, after: { value: 400, unit: 'ms' } }]);
    }
    assert.equal(app.variables.length, 1); assert.equal(app.root.getPluginData('foundry-operation-head'), '');
  }));
});

await test('a fresh failed timing import retains initial values and resumes without a false conflict or duplicate variable', async () => {
  const source = await figmaBundle(openWorkspace('Timing', [{ path: 'timing.json', text: '{"delay":{"$type":"duration","$value":{"value":300,"unit":"ms"}}}' }]));
  const app = fixture(); app.failValueAfter(0); assert.equal((await app.send({ type: 'pull', bundle: source }))['type'], 'error');
  assert.equal(app.variables.length, 1); assert(app.variable('delay').getPluginData('foundry-import-initial'));
  app.restart(); assert.equal((await app.send({ type: 'resume-pull' }))['type'], 'pulled');
  assert.equal(app.variables.length, 1); assert.equal(app.variable('delay').valuesByMode['source'], Math.fround(0.3)); assert.equal(app.variable('delay').getPluginData('foundry-import-initial'), '');
});

await test('interrupted duration unit changes compare physical timing values and retain later native edits in their current source units', async () => {
  const before = await timingSnapshot(300, 'ms'); const next = await timingSnapshot(0.5, 's');
  await Promise.all([0.5, 0.4, 300].map(async nativeValue => {
    const app = fixture(); await app.send({ type: 'pull', bundle: before }); app.failSnapshot();
    assert.equal((await app.send({ type: 'pull', bundle: next }))['type'], 'error');
    app.variable('delay').valuesByMode['source'] = nativeValue; app.restart();
    const state = await app.send({ type: 'inspect' }); assert.deepEqual(JSON.parse(JSON.stringify(state['unitConflicts'])), []);
    const resumed = await app.send({ type: 'resume-pull' });
    if (nativeValue === 0.5) assert.equal(resumed['type'], 'pulled');
    else {
      assert.equal(resumed['type'], 'conflicts'); assert.equal(app.variable('delay').valuesByMode['source'], nativeValue);
      assert.deepEqual(JSON.parse(JSON.stringify(resumed['conflicts'])), [{ path: 'delay', before: 300, local: nativeValue, remote: 0.5, beforeUnit: 'ms', remoteUnit: 's' }]);
      assert.equal((await app.send({ type: 'resolve-pull', id: resumed['id'], choices: [{ path: 'delay', value: nativeValue }] }))['type'], 'pulled');
      const proposal = (await app.send({ type: 'proposal' }))['proposal']; assert(isTokenProposal(proposal));
      assert.deepEqual(JSON.parse(JSON.stringify(proposal.changes)), [{ path: 'delay', before: { value: 0.5, unit: 's' }, after: { value: nativeValue, unit: 's' } }]);
    }
  }));
});

await test('unrepresentable native plans fail before creation or journaling and corrected conflict choices remain usable', async () => {
  const app = fixture(); const excessive = await timingSnapshot(1e40, 's');
  const refused = await app.send({ type: 'pull', bundle: excessive }); assert.equal(refused['type'], 'error'); assert.match(String(refused['message']), /native number range/u);
  assert.equal(app.collections.length, 0); assert.equal(app.variables.length, 0); assert.equal(app.root.getPluginData('foundry-operation-head'), '');
  const base = await snapshot(8); const incoming = await snapshot(10); await app.send({ type: 'pull', bundle: base }); await app.edit({ path: 'space', value: 12 });
  const review = await app.send({ type: 'pull', bundle: incoming }); assert.equal(review['type'], 'conflicts');
  const undo = app.undoCount(); const head = app.root.getPluginData('foundry-snapshot-head');
  const rejected = await app.send({ type: 'resolve-pull', id: review['id'], choices: [{ path: 'space', value: 1e40 }] });
  assert.equal(rejected['type'], 'error'); assert.match(String(rejected['message']), /native number range/u);
  assert.equal(app.variable('space').valuesByMode['source'], 12); assert.equal(app.undoCount(), undo); assert.equal(app.root.getPluginData('foundry-operation-head'), ''); assert.equal(app.root.getPluginData('foundry-snapshot-head'), head);
  assert.equal((await app.send({ type: 'resolve-pull', id: review['id'], choices: [{ path: 'space', value: 14 }] }))['type'], 'pulled');
  assert.equal(app.variable('space').valuesByMode['source'], 14);
});

await test('a malformed queued mutation cannot steal an active request and incomplete commands finish with owned errors', async () => {
  const app = fixture(); const source = await snapshot(8); const firstClient = 'a'.repeat(64); const secondClient = 'b'.repeat(64);
  const pending = app.send({ type: 'pull', bundle: source, serial: 14, client: firstClient });
  app.dispatch({ type: 'pull', serial: 15, client: secondClient });
  const pulled = await pending;
  assert.equal(pulled['serial'], 14); assert.equal(pulled['client'], firstClient); assert.equal(pulled['type'], 'pulled');
  await app.send({ type: 'inspect', serial: 16, client: secondClient });
  const rejected = app.messages.find(message => message['type'] === 'error' && message['serial'] === 15);
  assert(rejected); assert.equal(rejected['request'], 'pull'); assert.equal(rejected['client'], secondClient);
  assert.equal(app.variable('space').valuesByMode['source'], 8);
  await ['edit', 'resolve-native-unit', 'not-a-command'].reduce(async (previous, type) => {
    await previous;
    const result = await app.send({ type, serial: 17, client: secondClient });
    assert.equal(result['type'], 'error'); assert.equal(result['request'], type); assert.equal(result['serial'], 17);
  }, Promise.resolve());
});

await test('changing workspaces keeps their receipt order separate', async () => {
  const app = fixture(); const base = await snapshot(8); const twelve = await snapshot(12);
  const one = 'a'.repeat(64); const two = 'b'.repeat(64);
  const connect = (id: string) => app.send({ type: 'remember-connection', connection: 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'c'.repeat(64) + '#' + 'd'.repeat(64) });
  await app.send({ type: 'pull', bundle: base }); await connect(one);
  await app.send({ type: 'pull', bundle: twelve, acknowledgement: { id: 'first:100', sourceRevision: base.revision, values: [{ path: 'space', value: 12 }] } });
  await connect(two);
  await app.send({ type: 'pull', bundle: base, acknowledgement: { id: 'second:2', sourceRevision: twelve.revision, values: [{ path: 'space', value: 8 }] } });
  assert.equal((await app.send({ type: 'inspect' }))['acknowledgedReceipt'], 'second:2');
  await connect(one);
  await app.send({ type: 'pull', bundle: twelve, acknowledgement: { id: 'first:100', sourceRevision: base.revision, values: [{ path: 'space', value: 12 }] } });
  assert.equal((await app.send({ type: 'inspect' }))['acknowledgedReceipt'], 'first:100');
});

await test('three native Undo and Redo cycles preserve consumed receipts through restart and save each reversion', async () => {
  const app = fixture(); const base = await snapshot(8); const id = 'a'.repeat(64); const replica = 'b'.repeat(64);
  let state = registerReplica(pairDocument(await createWorkspace(id, { name: base.name, files: base.files, baseline: base.files }), { id: 'library', name: 'Library', role: 'library' }), 'library', replica);
  await app.send({ type: 'pull', bundle: base });
  await app.send({ type: 'remember-connection', connection: 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + replica + '#' + 'c'.repeat(64) });
  await app.edit({ path: 'space', value: 12 });
  const send = async () => {
    const reply = await app.send({ type: 'proposal', id }); assert(isTokenProposal(reply['proposal']));
    const saved = await receiveChanges(state, 'library', reply['proposal'], undefined, undefined, replica);
    assert(saved.accepted && saved.bundle && saved.acknowledgement); state = saved.state;
    assert.equal((await app.send({ type: 'pull', bundle: saved.bundle, acknowledgement: saved.acknowledgement }))['type'], 'pulled');
    return saved;
  };
  const first = await send(); assert(first.bundle && first.acknowledgement);
  await [8, 12, 8, 12, 8, 12].reduce(async (previous, value) => {
    await previous;
    // Native history restores document data as well as the variables. Model the
    // original two history entries; device recovery is intentionally unchanged.
    writeStored(app.root, 'foundry-snapshot-head', { bundle: value === 8 ? base : first.bundle, receipt: value === 8 ? '' : first.acknowledgement.id, workspace: id });
    app.variable('space').setValueForMode('source', value); app.restart(); await app.send({ type: 'restore-connection' });
    const native = await app.send({ type: 'inspect' }); assert(isBundle(native['bundle']));
    state = resumeReplica(state, 'library', replica, native['bundle'].revision, String(native['acknowledgedReceipt']));
    const offered = await offerWorkspace(state, 'library', replica); state = offered.state;
    assert.equal((await app.send({ type: 'pull', bundle: offered.bundle, acknowledgement: offered.acknowledgement }))['type'], 'pulled');
    const saved = await send(); assert.equal(saved.bundle?.variables.find(row => row.path === 'space')?.value, value);
  }, Promise.resolve());
});

await test('concept pairing crosses the controller message boundary and resumes without importing token definitions', async () => {
  const native = fixture();
  const connection = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + 'a'.repeat(64) + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  assert.equal((await native.send({ type: 'remember-connection', connection, name: 'Concept', concept: true }))['type'], 'connection-saved');
  assert.equal(native.collections.length, 1); assert.equal(native.variables.length, 0);
  assert.equal(native.collections[0]?.hiddenFromPublishing, true);
  native.restart();
  const restored = await native.send({ type: 'restore-connection' });
  assert.equal(restored['code'], connection); assert.equal(restored['resume'], true); assert.equal(restored['concept'], true);
  assert.equal(native.collections.length, 1); assert.equal(native.variables.length, 0);
  const source = await snapshot(8); const writes = native.snapshotWrites.length;
  await ['pull', 'resume-pull', 'resolve-pull', 'edit', 'resolve-native-unit', 'build-library', 'proposal'].reduce(async (previous, type) => {
    await previous;
    const result = await native.send({ type, bundle: source, path: 'space', value: 12 });
    assert.equal(result['type'], 'error'); assert.match(String(result['message']), /Concept files use shared library/u);
  }, Promise.resolve());
  assert.equal(native.variables.length, 0); assert.equal(native.snapshotWrites.length, writes);
  await native.send({ type: 'forget-connection' });
  assert.equal((await native.send({ type: 'pull', bundle: source }))['type'], 'pulled', 'Explicit disconnection permits using the file with a local source.');
});

await test('unfinished token forms survive controller restart without changing native values, source or Undo history', async () => {
  const native = fixture(); const source = await snapshot(8); await native.send({ type: 'pull', bundle: source });
  const row = source.variables.find(variable => variable.path === 'space'); assert(row);
  const form = { row, before: 8, revision: source.revision, kind: 'value', text: 'unfinished-number' };
  await native.send({ type: 'restore-token-forms' });
  const writes = native.snapshotWrites.length; const undo = native.undoCount();
  const saved = await native.send({ type: 'save-token-forms', forms: [form], serial: 1 });
  assert.equal(saved['type'], 'token-forms-saved'); assert.equal(saved['serial'], 1);
  native.restart(); const restored = await native.send({ type: 'restore-token-forms' });
  assert.equal(JSON.stringify(restored['forms']), JSON.stringify([form]));
  assert.equal(native.variable('space').valuesByMode['source'], 8);
  assert.equal(native.snapshotWrites.length, writes); assert.equal(native.undoCount(), undo);
  const malformed = await native.send({ type: 'save-token-forms', forms: [{ ...form, revision: 'invalid' }], serial: 2 });
  assert.equal(malformed['type'], 'token-forms-error');
  assert.equal(JSON.stringify((await native.send({ type: 'restore-token-forms' }))['forms']), JSON.stringify([form]));
  await native.send({ type: 'save-token-forms', forms: [], serial: 3 }); native.restart();
  assert.equal(JSON.stringify((await native.send({ type: 'restore-token-forms' }))['forms']), '[]');
});

await test('library builds use only the accepted source, reject archived source identities and block unmapped modes', async () => {
  const app = fixture(libraryCode);
  const old = await figmaBundle(openWorkspace('Old', [{ path: 'source.tokens.json', text: JSON.stringify({ space: { $type: 'number', $value: 8 }, archived: { $type: 'number', $value: 42 } }) }]));
  await app.send({ type: 'pull', bundle: old });
  await app.send({ type: 'pull', bundle: await snapshot(8) });
  assert.equal(app.variable('archived').hiddenFromPublishing, true);
  assert.equal((await app.send({ type: 'build-library' }))['type'], 'library-built');
  const another = await figmaBundle(openWorkspace('Another source', [{ path: 'other.tokens.json', text: JSON.stringify({ other: { $type: 'number', $value: 16 } }) }]));
  await app.send({ type: 'pull', bundle: another });
  const rejected = await app.send({ type: 'build-library' }); assert.equal(rejected['type'], 'error'); assert.match(String(rejected['message']), /Fixture source snapshot/u);
  assert.equal(app.messages.findLast(item => item['type'] === 'library-available')?.['compatible'], false);
  await app.send({ type: 'pull', bundle: await snapshot(8) }); app.addMode();
  const modes = await app.send({ type: 'build-library' }); assert.equal(modes['type'], 'error'); assert.match(String(modes['message']), /Map the source variables and modes/u);
});

await test('acknowledging a source already restored by native undo performs no document writes, including after restart', async () => {
  const app = fixture(); const base = await snapshot(8); const edited = await snapshot(12);
  await app.send({ type: 'pull', bundle: base });
  await app.send({ type: 'pull', bundle: edited });
  // Model Undo restoring values and the earlier document metadata.
  writeStored(app.root, 'foundry-snapshot-head', { bundle: base, receipt: '' }); app.variable('space').setValueForMode('source', 8);
  const writes = app.snapshotWrites.length;
  const acknowledgement = { id: 'undo-acknowledgement', sourceRevision: edited.revision, values: [{ path: 'space', value: 8 }] };
  assert.equal((await app.send({ type: 'pull', bundle: base, acknowledgement }))['type'], 'pulled');
  assert.equal(app.snapshotWrites.length, writes, 'A redundant source/receipt write would clear native Redo.');
  assert.equal(app.variable('space').valuesByMode['source'], 8);
  const proposal = await app.send({ type: 'proposal' }); assert(isRecord(proposal['proposal'])); assert.equal(proposal['proposal']['sourceRevision'], base.revision);
  app.restart();
  assert.equal((await app.send({ type: 'pull', bundle: base, acknowledgement }))['type'], 'pulled');
  assert.equal(app.snapshotWrites.length, writes);
});

await test('reopening after native undo rebases its local reversion without writing away native Redo', async () => {
  const app = fixture(); const base = await snapshot(8); const accepted = await snapshot(12);
  await app.send({ type: 'pull', bundle: base }); await app.send({ type: 'pull', bundle: accepted });
  writeStored(app.root, 'foundry-snapshot-head', { bundle: base, receipt: '' }); app.variable('space').setValueForMode('source', 8);
  app.restart(); const writes = app.snapshotWrites.length;
  const acknowledgement = { id: 'saved-12', sourceRevision: base.revision, values: [{ path: 'space', value: 12 }] };
  assert.equal((await app.send({ type: 'pull', bundle: accepted, acknowledgement }))['type'], 'pulled');
  assert.equal(app.snapshotWrites.length, writes); assert.equal(app.variable('space').valuesByMode['source'], 8);
  const exported = await app.send({ type: 'proposal' }); assert(isRecord(exported['proposal']));
  assert.equal(exported['proposal']['sourceRevision'], accepted.revision);
  assert(sameSourceValue(exported['proposal']['changes'], [{ path: 'space', before: { value: 12, unit: 'px' }, after: { value: 8, unit: 'px' } }]));
});

await test('native edits require a current source and native value baseline, retaining newer edits on rejection', async () => {
  const base = await snapshot(8);
  await Promise.all([{}, { revision: base.revision }, { expected: 8 }, { revision: '0'.repeat(64), expected: 8 }].map(async preconditions => {
    const app = fixture(); await app.send({ type: 'pull', bundle: base });
    assert.equal((await app.send({ type: 'edit', path: 'space', value: 12, ...preconditions }))['type'], 'error');
    assert.equal(app.variable('space').valuesByMode['source'], 8);
  }));
  const app = fixture(); await app.send({ type: 'pull', bundle: base });
  app.variable('space').setValueForMode('source', 10);
  const stale = await app.send({ type: 'edit', path: 'space', value: 12, revision: base.revision, expected: 8 });
  assert.equal(stale['type'], 'error'); assert.match(String(stale['message']), /changed in Figma while/u);
  assert.equal(app.variable('space').valuesByMode['source'], 10);
  const result = await app.send({ type: 'proposal' });
  assert(isRecord(result['proposal']));
  assert(sameSourceValue(result['proposal']['changes'], [{ path: 'space', before: { value: 8, unit: 'px' }, after: { value: 10, unit: 'px' } }]));
  await app.send({ type: 'pull', bundle: base });
  assert.equal((await app.send({ type: 'edit', path: 'space', value: 12, revision: base.revision, expected: 10 }))['type'], 'state');
  assert.equal(app.variable('space').valuesByMode['source'], 12);
});

await test('native edit baselines preserve zero and reference values', async () => {
  const base = await figmaBundle(openWorkspace('Baselines', [{ path: 'tokens/test.tokens.json', text: JSON.stringify({
    count: { $type: 'number', $value: 0 }, alias: { $type: 'number', $value: '{count}' },
  }) }]));
  await Promise.all([{ path: 'count', expected: 0, value: 1 }, { path: 'alias', expected: { alias: 'count' }, value: 2 }].map(async input => {
    const app = fixture(); await app.send({ type: 'pull', bundle: base });
    assert.equal((await app.send({ type: 'edit', revision: base.revision, ...input }))['type'], 'state');
    assert.equal(app.variable(input.path).valuesByMode['source'], input.value);
  }));
});

await test('controller applies source, Figma and custom conflict choices with stable native identities and a new proposal baseline', async () => {
  await Promise.all([10, 12, 14].map(async value => {
    const app = fixture();
    const base = await snapshot(8);
    assert.equal((await app.send({ type: 'pull', bundle: base }))['type'], 'pulled');
    const identity = app.variable('space').id;
    await app.edit({ path: 'space', value: 12 });
    const incoming = await snapshot(10);
    const conflict = await app.send({ type: 'pull', bundle: incoming });
    assert.equal(conflict['type'], 'conflicts');
    assert.equal(app.variable('space').valuesByMode['source'], 12);
    assert.equal((await app.send({ type: 'cancel-pull' }))['type'], 'pull-cancelled');
    assert.equal(app.variable('space').valuesByMode['source'], 12);
    const retried = await app.send({ type: 'pull', bundle: incoming });
    assert.equal((await app.send({ type: 'resolve-pull', id: retried['id'], choices: [{ path: 'space', value }] }))['type'], 'pulled');
    assert.equal(app.variable('space').id, identity);
    assert.equal(app.variable('space').valuesByMode['source'], value);
    const exported = await app.send({ type: 'proposal' });
    const proposal = exported['proposal'];
    assert(isRecord(proposal));
    assert.equal(proposal['sourceRevision'], incoming.revision);
    assert(sameSourceValue(proposal['changes'], value === 10 ? [] : [{ path: 'space', before: { value: 10, unit: 'px' }, after: { value, unit: 'px' } }]));
  }));
});

await test('controller refuses stale conflict choices when native values change during the review', async () => {
  const app = fixture();
  await app.send({ type: 'pull', bundle: await snapshot(8) });
  await app.edit({ path: 'space', value: 12 });
  const conflict = await app.send({ type: 'pull', bundle: await snapshot(10) });
  app.variable('space').setValueForMode('source', 16);
  const result = await app.send({ type: 'resolve-pull', id: conflict['id'], choices: [{ path: 'space', value: 10 }] });
  assert.equal(result['type'], 'error');
  assert.match(String(result['message']), /changed while/u);
  assert.equal(app.variable('space').valuesByMode['source'], 16);
});

await test('native edits cannot bind to archived variables that are outside the accepted source snapshot', async () => {
  const app = fixture();
  await app.send({ type: 'pull', bundle: await snapshot(8) });
  await app.edit({ path: 'alias', value: 12 });
  const next = await figmaBundle(openWorkspace('Test', [{ path: 'tokens/test.tokens.json', text: '{"space":{"$type":"dimension","$value":{"value":8,"unit":"px"}}}' }]));
  const conflict = await app.send({ type: 'pull', bundle: next });
  await app.send({ type: 'resolve-pull', id: conflict['id'], choices: [{ path: 'alias', value: null }] });
  assert.equal(app.variable('alias').hiddenFromPublishing, true);
  await app.edit({ path: 'space', alias: 'alias' });
  const exported = await app.send({ type: 'proposal' });
  assert.equal(app.variable('space').valuesByMode['source'], 8);
  assert(isRecord(exported['proposal'])); assert(sameSourceValue(exported['proposal']['changes'], []));
  assert(app.messages.some(message => message['type'] === 'error' && String(message['message']).includes('current source snapshot')));
});

await test('additional native modes are reported and cannot be silently omitted from an exported proposal', async () => {
  const app = fixture();
  await app.send({ type: 'pull', bundle: await snapshot(8) });
  app.addMode(); app.variable('space').setValueForMode('other', 24);
  const state = await app.send({ type: 'inspect' });
  assert.match(String(state['issue']), /Additional Figma modes/u);
  const result = await app.send({ type: 'proposal' });
  assert.equal(result['type'], 'error'); assert.match(String(result['message']), /source mapping/u);
  assert.equal(app.variable('space').valuesByMode['other'], 24);
});

await test('font pickers include nested typography sizes and weights without offering icon dimensions as font sizes', async () => {
  const app = fixture();
  const bundle = await figmaBundle(openWorkspace('Typography', [{ path: 'tokens/typography.tokens.json', text: JSON.stringify({
    sys: { typescale: { emphasized: { label: { size: { $type: 'dimension', $value: { value: 14, unit: 'sp' } }, weight: { $type: 'fontWeight', $value: 700 } } } } },
    comp: { icon: { size: { $type: 'dimension', $value: { value: 24, unit: 'dp' } } } },
  }) }]));
  await app.send({ type: 'pull', bundle });
  assert(sameSourceValue(app.variable('sys.typescale.emphasized.label.size').scopes, ['FONT_SIZE']));
  assert(sameSourceValue(app.variable('sys.typescale.emphasized.label.weight').scopes, ['FONT_WEIGHT']));
  assert(sameSourceValue(app.variable('comp.icon.size').scopes, ['WIDTH_HEIGHT']));
});

await test('native percentage projection migrates old values with stable aliases, exports source ratios and resumes an interrupted conversion', async () => {
  // Both fixture paths use the explicit percent projection, like Sevan's
  // component opacity -> system opacity aliases.
  const renamed = await figmaBundle(openWorkspace('Opacity', [{ path: 'tokens/opacity.tokens.json', text: JSON.stringify({
    opacity: { $type: 'number', $value: 0.196 }, comp: { opacity: { $type: 'number', $value: '{opacity}' } },
  }) }]));
  await Promise.all([false, true].map(async interrupt => {
    const app = fixture();
    await app.send({ type: 'pull', bundle: renamed });
    const ids = app.variables.map(variable => variable.id);
    assert.equal(app.variable('opacity').valuesByMode['source'], Math.fround(0.196));
    app.restart(scaledCode);
    if (interrupt) app.failValueAfter(0);
    const result = await app.send({ type: 'pull', bundle: renamed });
    if (interrupt) {
      assert.equal(result['type'], 'error'); app.restart();
      assert.equal((await app.send({ type: 'resume-pull' }))['type'], 'pulled');
    } else assert.equal(result['type'], 'pulled');
    assert.deepEqual(app.variables.map(variable => variable.id), ids);
    assert.equal(app.variable('opacity').valuesByMode['source'], Math.fround(19.6));
    assert(sameSourceValue(app.variable('comp.opacity').valuesByMode['source'], { type: 'VARIABLE_ALIAS', id: app.variable('opacity').id }));
    app.variable('opacity').setValueForMode('source', Math.fround(19.6));
    const clean = await app.send({ type: 'proposal' });
    assert(isRecord(clean['proposal'])); assert(sameSourceValue(clean['proposal']['changes'], []));
    app.variable('opacity').setValueForMode('source', 25);
    const changed = await app.send({ type: 'proposal' });
    assert(isRecord(changed['proposal']));
    assert(sameSourceValue(changed['proposal']['changes'], [{ path: 'opacity', before: 0.196, after: 0.25 }]));
    await app.edit({ path: 'opacity', value: 0.38 });
    assert.equal(app.variable('opacity').valuesByMode['source'], 38);
  }));
});

await test('native percentage projection rejects mixed-unit aliases before import or a direct edit', async () => {
  const app = fixture(scaledCode);
  const mixed = await figmaBundle(openWorkspace('Units', [{ path: 'tokens/test.json', text: JSON.stringify({
    value: { $type: 'number', $value: 0.1 }, opacity: { $type: 'number', $value: '{value}' },
  }) }]));
  const rejected = await app.send({ type: 'pull', bundle: mixed });
  assert.equal(rejected['type'], 'error'); assert.match(String(rejected['message']), /incompatible native number units/u);
  assert.equal(app.variables.length, 0);
  const separate = await figmaBundle(openWorkspace('Units', [{ path: 'tokens/test.json', text: JSON.stringify({
    value: { $type: 'number', $value: 0.1 }, opacity: { $type: 'number', $value: 0.1 },
  }) }]));
  assert.equal((await app.send({ type: 'pull', bundle: separate }))['type'], 'pulled');
  await app.edit({ path: 'opacity', alias: 'value' });
  assert.equal(app.variable('opacity').valuesByMode['source'], 10);
  assert(app.messages.some(message => message['type'] === 'error' && String(message['message']).includes('incompatible native number units')));
});

await test('an ambiguous interrupted unit conversion can be reviewed, preserves later edits and refuses stale unit choices', async () => {
  const app = fixture();
  const source = await figmaBundle(openWorkspace('Opacity', [{ path: 'tokens/test.json', text: '{"opacity":{"$type":"number","$value":0.1}}' }]));
  await app.send({ type: 'pull', bundle: source }); app.restart(scaledCode); app.failValueAfter(0);
  assert.equal((await app.send({ type: 'pull', bundle: source }))['type'], 'error');
  app.variable('opacity').setValueForMode('source', 26); app.restart();
  const state = await app.send({ type: 'inspect' });
  assert(sameSourceValue(state['unitConflicts'], [{ path: 'opacity', current: 26, before: 0.1, beforeScale: 1, afterScale: 100 }]));
  app.variable('opacity').setValueForMode('source', 28);
  assert.equal((await app.send({ type: 'resolve-native-unit', path: 'opacity', expectedNative: 26, value: 0.26 }))['type'], 'error');
  assert.equal(app.variable('opacity').valuesByMode['source'], 28);
  const resolved = await app.send({ type: 'resolve-native-unit', path: 'opacity', expectedNative: 28, value: 0.28 });
  assert(sameSourceValue(resolved['unitConflicts'], []));
  const review = await app.send({ type: 'resume-pull' });
  assert.equal(review['type'], 'conflicts');
  assert.equal((await app.send({ type: 'resolve-pull', id: review['id'], choices: [{ path: 'opacity', value: 0.28 }] }))['type'], 'pulled');
  assert.equal(app.variable('opacity').valuesByMode['source'], 28);
  const exported = await app.send({ type: 'proposal' });
  assert(isRecord(exported['proposal']));
  assert(sameSourceValue(exported['proposal']['changes'], [{ path: 'opacity', before: 0.1, after: 0.28 }]));
});

await test('unit recovery also works when the first snapshot import has no committed baseline yet', async () => {
  const app = fixture(scaledCode);
  const source = await figmaBundle(openWorkspace('Opacity', [{ path: 'tokens/test.json', text: '{"opacity":{"$type":"number","$value":0.1}}' }]));
  app.failValueAfter(0);
  assert.equal((await app.send({ type: 'pull', bundle: source }))['type'], 'error');
  app.variable('opacity').setValueForMode('source', 26); app.restart();
  assert.equal((await app.send({ type: 'resolve-native-unit', path: 'opacity', expectedNative: 26, value: 0.26 }))['type'], 'state');
  const review = await app.send({ type: 'resume-pull' });
  assert.equal(review['type'], 'conflicts');
  assert.equal((await app.send({ type: 'resolve-pull', id: review['id'], choices: [{ path: 'opacity', value: 0.26 }] }))['type'], 'pulled');
  assert.equal(app.variable('opacity').valuesByMode['source'], 26);
});

await test('adjacent native percentage numbers remain distinct after normalization for proposals, conflicts and acknowledgements', async () => {
  const source = await figmaBundle(openWorkspace('Opacity', [{ path: 'tokens/test.json', text: '{"opacity":{"$type":"number","$value":0.29}}' }]));
  const app = fixture(scaledCode); await app.send({ type: 'pull', bundle: source });
  const bits = new Uint32Array(new Float32Array([29]).buffer); bits[0] = (bits[0] ?? 0) - 1;
  const adjacent = new Float32Array(bits.buffer)[0]; assert(adjacent !== undefined);
  assert.equal(Math.fround(adjacent / 100), Math.fround(0.29));
  app.variable('opacity').setValueForMode('source', adjacent);
  const exported = await app.send({ type: 'proposal' });
  assert(isRecord(exported['proposal']));
  assert(sameSourceValue(exported['proposal']['changes'], [{ path: 'opacity', before: 0.29, after: 0.28999998 }]));
  assert.equal(Math.fround(0.28999998 * 100), adjacent);
  const acknowledgement = { id: 'previous-opacity-edit', sourceRevision: source.revision, values: [{ path: 'opacity', value: 0.29 }] };
  await app.send({ type: 'pull', bundle: source, acknowledgement });
  assert.equal(app.variable('opacity').valuesByMode['source'], adjacent);
  const incoming = await figmaBundle(openWorkspace('Opacity', [{ path: 'tokens/test.json', text: '{"opacity":{"$type":"number","$value":0.4}}' }]));
  const conflict = await app.send({ type: 'pull', bundle: incoming });
  assert.equal(conflict['type'], 'conflicts');
  app.variable('opacity').setValueForMode('source', 29);
  assert.equal((await app.send({ type: 'resolve-pull', id: conflict['id'], choices: [{ path: 'opacity', value: 0.4 }] }))['type'], 'error');
  assert.equal(app.variable('opacity').valuesByMode['source'], 29);
});

await test('acknowledgement consumes only the submitted edit and is consumed durably even when the source revision is unchanged', async () => {
  await Promise.all([true, false].map(async applySubmitted => {
    const app = fixture();
    const base = await snapshot(8);
    await app.send({ type: 'pull', bundle: base });
    if (applySubmitted) await app.edit({ path: 'space', value: 12 });
    const acknowledgement = { id: 'declined-proposal', sourceRevision: base.revision, values: [{ path: 'space', value: 12 }] };
    assert.equal((await app.send({ type: 'pull', bundle: base, acknowledgement }))['type'], 'pulled');
    assert.equal(app.variable('space').valuesByMode['source'], 8);
    app.restart();
    await app.edit({ path: 'space', value: 12 });
    assert.equal((await app.send({ type: 'pull', bundle: base, acknowledgement }))['type'], 'pulled');
    assert.equal(app.variable('space').valuesByMode['source'], 12);
  }));
});

await test('an edit made after submission advances from its acknowledged source without inventing a conflict', async () => {
  const app = fixture(); const base = await snapshot(8); const accepted = await snapshot(12);
  await app.send({ type: 'pull', bundle: base });
  await app.edit({ path: 'space', value: 12 });
  await app.edit({ path: 'space', value: 14 });
  const acknowledgement = { id: 'saved-12', sourceRevision: base.revision, values: [{ path: 'space', value: 12 }] };
  assert.equal((await app.send({ type: 'pull', bundle: accepted, acknowledgement }))['type'], 'pulled');
  assert.equal(app.variable('space').valuesByMode['source'], 14);
  const exported = await app.send({ type: 'proposal' });
  assert(isRecord(exported['proposal'])); assert.equal(exported['proposal']['sourceRevision'], accepted.revision);
  app.restart(); assert.equal((await app.send({ type: 'inspect' }))['changed'], 1);
});

await test('choosing a different source value for a submission preserves a later native edit for its own review', async () => {
  const app = fixture(); const base = await snapshot(8); const source = await snapshot(10);
  await app.send({ type: 'pull', bundle: base }); await app.edit({ path: 'space', value: 12 }); await app.edit({ path: 'space', value: 14 });
  const acknowledgement = { id: 'resolved-submitted-12', sourceRevision: base.revision, values: [{ path: 'space', value: 12 }] };
  const writes = app.snapshotWrites.length;
  const result = await app.send({ type: 'pull', bundle: source, acknowledgement });
  assert.equal(result['type'], 'conflicts'); assert.equal(app.variable('space').valuesByMode['source'], 14); assert.equal(app.snapshotWrites.length, writes);
  assert.equal(JSON.stringify(result['conflicts']), JSON.stringify([{ path: 'space', before: 12, local: 14, remote: 10, beforeUnit: 'px', remoteUnit: 'px' }]));
  app.restart();
  const restored = await app.send({ type: 'pull', bundle: source, acknowledgement }); assert.equal(JSON.stringify(restored['conflicts']), JSON.stringify(result['conflicts']));
  assert.equal(app.variable('space').valuesByMode['source'], 14); assert.equal(app.snapshotWrites.length, writes);
});

await test('interrupted native writes and snapshot commits recover after controller restart without losing a later edit', async () => {
  await Promise.all(['native', 'snapshot'].map(async failure => {
    const app = fixture();
    const base = await snapshot(8);
    await app.send({ type: 'pull', bundle: base });
    const ids = app.variables.map(variable => variable.id);
    if (failure === 'native') app.failValueAfter(1); else app.failSnapshot();
    const next = await figmaBundle(openWorkspace('Test', [{ path: 'tokens/test.tokens.json', text: JSON.stringify({
      space: { $type: 'dimension', $value: { value: 10, unit: 'px' } }, alias: { $type: 'dimension', $value: { value: 16, unit: 'px' } },
    }) }]));
    assert.equal((await app.send({ type: 'pull', bundle: next }))['type'], 'error');
    app.restart();
    const state = await app.send({ type: 'inspect' });
    assert.equal(state['recovery'], true);
    assert(isBundle(state['bundle']));
    assert.equal(state['bundle'].revision, base.revision);
    app.variable('space').setValueForMode('source', 18);
    const conflict = await app.send({ type: 'resume-pull' });
    assert.equal(conflict['type'], 'conflicts');
    assert.equal((await app.send({ type: 'resolve-pull', id: conflict['id'], choices: [{ path: 'space', value: 18 }] }))['type'], 'pulled');
    assert.deepEqual(app.variables.map(variable => variable.id), ids);
    assert.equal(app.variable('space').valuesByMode['source'], 18);
    assert.equal(app.variable('alias').valuesByMode['source'], 16);
    assert.equal((await app.send({ type: 'inspect' }))['recovery'], false);
    const exported = await app.send({ type: 'proposal' });
    assert(isRecord(exported['proposal']));
    assert.equal(exported['proposal']['sourceRevision'], next.revision);
  }));
});

await test('every interrupted snapshot-storage write leaves the previous committed generation readable', () => {
  const initial = new Map<string, string>();
  const storage = { getPluginData: (key: string) => initial.get(key) ?? '', setPluginData: (key: string, value: string) => { initial.set(key, value); } };
  writeStored(storage, 'test', { value: 'old' });
  const next = { value: 'new'.repeat(20_000) };
  for (let failAt = 0; failAt < 6; failAt++) {
    const values = new Map(initial);
    let writes = 0;
    const broken = { getPluginData: (key: string) => values.get(key) ?? '', setPluginData: (key: string, value: string) => {
      if (writes++ === failAt) throw new Error('Injected storage failure');
      values.set(key, value);
    } };
    assert.throws(() => writeStored(broken, 'test', next), /Injected/u);
    assert.deepEqual(readStored(broken, 'test', isStringValue), { value: 'old' });
  }
});

await test('pull preserves curated hiddenFromPublishing visibility for Sevan tokens', async () => {
  const app = fixture();
  const bundle = await figmaBundle(openWorkspace('Sevan', [{
    path: 'tokens/sevan.tokens.json',
    text: JSON.stringify({
      sevan: {
        ref: { palette: { green: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0.3, 0.2], hex: '#004D33' } } } },
        sys: { color: { primary: { $type: 'color', $value: '{sevan.ref.palette.green}' } } },
      },
    }),
  }]));
  await app.send({ type: 'pull', bundle });
  assert.equal(app.variable('sevan.ref.palette.green').hiddenFromPublishing, true);
  assert.equal(app.variable('sevan.sys.color.primary').hiddenFromPublishing, false);
});
