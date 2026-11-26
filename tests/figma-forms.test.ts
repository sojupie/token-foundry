import assert from 'node:assert/strict';
import { test } from 'node:test';
import { figmaBundle } from '../integrations/figma/projection.ts';
import { openWorkspace } from '../lib/workspace.ts';
import { isTokenForms, readTokenFormsCopy, restoreTokenForms, saveTokenForms, splitTokenForms, tokenFormsCopy } from '../figma/forms.ts';

await test('device token forms preserve invalid input and aliases, isolate copied files, and survive a failed storage write', async () => {
  const source = await figmaBundle(openWorkspace('Forms', [{ path: 'source.json', text: '{"space":{"$type":"number","$value":8},"alias":{"$type":"number","$value":"{space}"}}' }]));
  const space = source.variables.find(row => row.path === 'space'); const alias = source.variables.find(row => row.path === 'alias'); assert(space); assert(alias);
  const forms = [{ row: space, before: 8, revision: source.revision, kind: 'value' as const, text: 'unfinished-number' },
    { row: alias, before: { alias: 'space' }, revision: source.revision, kind: 'alias' as const, text: 'space' }];
  const original = new Map([['foundry-document-identity', 'original-file']]); const document = new Map(original); const device = new Map<string, unknown>();
  let collection = 'original-key'; let fail = false; let documentWrites = 0;
  const api = { root: { getPluginData: (key: string) => document.get(key) ?? '', setPluginData: (key: string, value: string) => { documentWrites++; document.set(key, value); } },
    variables: { getLocalVariableCollectionsAsync: () => Promise.resolve([{ key: collection, getPluginData: (key: string) => key === 'foundry-collection' ? '1' : '' }]) },
    clientStorage: { keysAsync: () => Promise.resolve([...device.keys()]), getAsync: (key: string) => Promise.resolve(device.get(key)), setAsync: (key: string, value: unknown) => { if (fail) { fail = false; return Promise.reject(new Error('Storage full')); } device.set(key, value); return Promise.resolve(); }, deleteAsync: (key: string) => { device.delete(key); return Promise.resolve(); } },
    ui: { postMessage: () => undefined } };
  await restoreTokenForms(api); await saveTokenForms(api, forms); assert.equal(documentWrites, 0); assert.deepEqual(await restoreTokenForms(api), forms);
  assert.deepEqual(readTokenFormsCopy(tokenFormsCopy(forms)), forms);
  fail = true; await assert.rejects(saveTokenForms(api, []), /Storage full/u); assert.deepEqual(await restoreTokenForms(api), forms);
  collection = 'copied-key'; await assert.rejects(restoreTokenForms(api), /another file/u);
  assert.notEqual(document.get('foundry-document-identity'), original.get('foundry-document-identity'));
  assert.deepEqual(await restoreTokenForms(api), []);
  document.clear(); for (const [key, value] of original) document.set(key, value); collection = 'original-key';
  assert.deepEqual(await restoreTokenForms(api), forms);
  assert.equal(isTokenForms([forms[0], forms[0]]), false);
  assert.equal(isTokenForms([{ ...forms[0], before: NaN }]), false);
  assert.throws(() => readTokenFormsCopy('{"format":"token-foundry/token-forms","version":2,"forms":[]}'), /Choose/u);
});

await test('concurrent plugin windows retain both input branches until an explicit choice, including a later stale writer', async () => {
  const source = await figmaBundle(openWorkspace('Forms', [{ path: 'source.json', text: '{"space":{"$type":"number","$value":8}}' }]));
  const row = source.variables[0]; assert(row);
  const draft = (text: string) => ({ row, before: 8, revision: source.revision, kind: 'value' as const, text });
  const device = new Map<string, unknown>(); let failDelete = false;
  const api = () => ({ root: { getPluginData: (key: string) => key === 'foundry-document-identity' ? 'original-file' : '', setPluginData: () => { throw new Error('Form writes cannot mutate the document'); } },
    variables: { getLocalVariableCollectionsAsync: () => Promise.resolve([{ key: 'original-key', getPluginData: (key: string) => key === 'foundry-collection' ? '1' : '' }]) },
    clientStorage: { keysAsync: () => Promise.resolve([...device.keys()]), getAsync: (key: string) => Promise.resolve(device.get(key)), setAsync: (key: string, value: unknown) => { device.set(key, value); return Promise.resolve(); }, deleteAsync: (key: string) => { if (failDelete) return Promise.reject(new Error('Cleanup interrupted')); device.delete(key); return Promise.resolve(); } },
    ui: { postMessage: () => undefined } });
  const one = api(); const two = api(); await Promise.all([restoreTokenForms(one), restoreTokenForms(two)]);
  await Promise.all([saveTokenForms(one, [draft('12')]), saveTokenForms(two, [draft('14')])]);
  const reader = api(); const fork = splitTokenForms(await restoreTokenForms(reader));
  assert.equal(fork.forms.length, 0); assert.deepEqual(fork.conflicts.map(form => form.text).toSorted(), ['12', '14']);
  assert.deepEqual(readTokenFormsCopy(tokenFormsCopy(fork.conflicts)), fork.conflicts);
  failDelete = true; await saveTokenForms(reader, [draft('12')]);
  assert.deepEqual((await restoreTokenForms(api())).map(form => form.text), ['12']);
  failDelete = false; await saveTokenForms(reader, [draft('12')]); assert.equal(device.size, 1);
  await saveTokenForms(two, [draft('later 16')]);
  const last = api(); const retained = splitTokenForms(await restoreTokenForms(last));
  assert.deepEqual(retained.conflicts.map(form => form.text).toSorted(), ['12', 'later 16']);
  await saveTokenForms(last, [draft('later 16')]); assert.equal(device.size, 1);
  assert.deepEqual((await restoreTokenForms(api())).map(form => form.text), ['later 16']);
  await saveTokenForms(last, []); assert.deepEqual(await restoreTokenForms(api()), []);
});
