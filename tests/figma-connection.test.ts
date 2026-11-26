import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetConnection, rememberConnection, restoreConnection } from '../figma/connection.ts';
import { isRecord } from '../lib/json.ts';

await test('native pairing keeps capabilities on the device, restores only on request and forgets without changing source data', async () => {
  const document = new Map<string, string>([['foundry-snapshot-head', 'original-source']]);
  const device = new Map<string, unknown>(); const messages: unknown[] = [];
  const api = { fileKey: 'file-1', root: { getPluginData: (key: string) => document.get(key) ?? '', setPluginData: (key: string, value: string) => { document.set(key, value); } },
    clientStorage: { getAsync: (key: string) => Promise.resolve(device.get(key)), setAsync: (key: string, value: unknown) => { device.set(key, value); return Promise.resolve(); }, deleteAsync: (key: string) => { device.delete(key); return Promise.resolve(); } },
    ui: { postMessage: (message: unknown) => { messages.push(message); } } };
  await restoreConnection(api); assert.equal(messages.length, 1); assert.deepEqual(messages.at(-1), { type: 'saved-connection', code: '' }); messages.length = 0;
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + 'a'.repeat(64) + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  await rememberConnection(api, code, 'Source', Date.now() + 1000);
  assert.equal(messages.length, 0); assert.equal(device.size, 1);
  assert.equal(JSON.stringify([...document]).includes('c'.repeat(64)), false);
  await restoreConnection(api);
  const restored = messages.at(-1); assert(isRecord(restored)); assert.equal(restored['code'], code); assert.equal(restored['name'], 'Source'); assert.equal(restored['resume'], true);
  await assert.rejects(rememberConnection(api, code.replace('lindstruct.com', 'lindstruct.com.attacker.example'), 'Invalid'), /connection code/u);
  assert.equal(device.size, 1);
  await forgetConnection(api); assert.equal(device.size, 0); assert.equal(document.get('foundry-snapshot-head'), 'original-source');
  assert.deepEqual(messages.at(-1), { type: 'connection-forgotten' });
  await restoreConnection(api); assert.deepEqual(messages.at(-1), { type: 'saved-connection', code: '' });
});

await test('native collection identity permits resume in the original file and isolates an actual copied-file shape', async () => {
  const original = new Map([['foundry-snapshot-head', 'source'], ['foundry-document-identity', 'logical-file']]);
  const device = new Map<string, unknown>(); const messages: unknown[] = [];
  const api = (document: Map<string, string>, collection: string) => ({
    root: { getPluginData: (key: string) => document.get(key) ?? '', setPluginData: (key: string, value: string) => { document.set(key, value); } },
    variables: { getLocalVariableCollectionsAsync: () => Promise.resolve([{ key: collection, getPluginData: (key: string) => key === 'foundry-collection' ? '1' : '' }]) },
    clientStorage: { getAsync: (key: string) => Promise.resolve(device.get(key)), setAsync: (key: string, value: unknown) => { device.set(key, value); return Promise.resolve(); }, deleteAsync: (key: string) => { device.delete(key); return Promise.resolve(); } },
    ui: { postMessage: (message: unknown) => { messages.push(message); } },
  });
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + 'a'.repeat(64) + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  await rememberConnection(api(original, 'original-key'), code, 'Workspace');
  const copy = new Map(original); await restoreConnection(api(original, 'original-key'));
  const resumed = messages.at(-1); assert(isRecord(resumed)); assert.equal(resumed['resume'], true);
  await restoreConnection(api(copy, 'copied-key'));
  const blocked = messages.at(-1); assert(isRecord(blocked)); assert.equal(blocked['code'], '');
  assert.notEqual(copy.get('foundry-document-identity'), original.get('foundry-document-identity'));
  assert.notEqual(copy.get('foundry-device-connection'), original.get('foundry-device-connection'));
  assert.equal(copy.get('foundry-snapshot-head'), 'source'); assert.equal(device.size, 1);
  await forgetConnection(api(copy, 'copied-key')); assert.equal(device.size, 1);
  await restoreConnection(api(original, 'original-key')); const retained = messages.at(-1);
  assert(isRecord(retained)); assert.equal(retained['resume'], true); assert.equal(retained['code'], code);
});

await test('empty concept retains one unpublished identity anchor, blocks copies and detects anchor removal', async () => {
  const document = new Map<string, string>(); const device = new Map<string, unknown>(); const messages: unknown[] = [];
  const collections: { key: string; hiddenFromPublishing: boolean; data: Map<string, string>; getPluginData: (key: string) => string; setPluginData: (key: string, value: string) => void }[] = [];
  const api = {
    root: { getPluginData: (key: string) => document.get(key) ?? '', setPluginData: (key: string, value: string) => { document.set(key, value); } },
    variables: {
      getLocalVariableCollectionsAsync: () => Promise.resolve(collections),
      createVariableCollection: (name: string) => {
        assert.equal(name, 'Foundry connection'); const data = new Map<string, string>();
        const collection = { key: 'original-key', hiddenFromPublishing: false, data, getPluginData: (key: string) => data.get(key) ?? '', setPluginData: (key: string, value: string) => { data.set(key, value); } };
        collections.push(collection); return collection;
      },
    },
    clientStorage: { getAsync: (key: string) => Promise.resolve(device.get(key)), setAsync: (key: string, value: unknown) => { device.set(key, value); return Promise.resolve(); }, deleteAsync: (key: string) => { device.delete(key); return Promise.resolve(); } },
    ui: { postMessage: (message: unknown) => { messages.push(message); } },
  };
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + 'a'.repeat(64) + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  await rememberConnection(api, code, 'Concept', undefined, true);
  await rememberConnection(api, code, 'Concept', undefined, true);
  assert.equal(collections.length, 1); assert.equal(collections[0]?.hiddenFromPublishing, true);
  assert.equal(collections[0]?.getPluginData('foundry-collection'), '');
  await restoreConnection(api); let result = messages.at(-1); assert(isRecord(result)); assert.equal(result['resume'], true);
  const original = new Map(document); const anchor = collections[0]; assert(anchor); anchor.key = 'duplicate-key';
  await restoreConnection(api); result = messages.at(-1); assert(isRecord(result)); assert.equal(result['code'], '');
  assert.notEqual(document.get('foundry-device-connection'), original.get('foundry-device-connection'));
  await forgetConnection(api); assert.equal(device.size, 1);
  document.clear(); for (const [key, value] of original) document.set(key, value); anchor.key = 'original-key';
  await restoreConnection(api); result = messages.at(-1); assert(isRecord(result)); assert.equal(result['resume'], true);
  collections.length = 0;
  await restoreConnection(api); result = messages.at(-1); assert(isRecord(result)); assert.equal(result['code'], '');
  assert.equal(device.size, 1);
});
