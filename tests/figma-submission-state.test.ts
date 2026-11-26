import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeSubmission } from '../figma/submission-state.ts';

await test('device submission state orders native intent, keeps retries stable and never rolls consumed receipts back with document history', async () => {
  const storage = new Map<string, unknown>(); let writes = 0; let failure = false; let collection = 'original';
  const figma = {
    root: { getPluginData: () => 'document', setPluginData: () => { throw new Error('Submission state must not write document history.'); } },
    variables: { getLocalVariableCollectionsAsync: () => Promise.resolve([{ key: collection, getPluginData: () => '1' }]) },
    clientStorage: { getAsync: (key: string) => Promise.resolve(storage.get(key)), setAsync: (key: string, value: unknown) => { if (failure) return Promise.reject(new Error('Device full')); writes++; storage.set(key, value); return Promise.resolve(); }, deleteAsync: () => Promise.resolve() },
    ui: { postMessage: () => undefined },
  };
  const observe = (value: number, workspace = 'workspace', receipt = '', trusted = false) => observeSubmission(figma, 'source', new Map([['space', value]]), workspace, receipt, trusted);
  const first = await observe(12); const count = writes;
  assert.deepEqual(await observe(12), first); assert.equal(writes, count, 'Unchanged inspection performs no writes.');
  const middle = await observe(14); const returned = await observe(12);
  assert.equal(returned.intentId, first.intentId); assert.equal(returned.intentSequence, middle.intentSequence + 1);
  assert.notEqual(first.intentSequence, returned.intentSequence);
  await observe(12, 'workspace', 'replica:20', true);
  assert.equal((await observe(12, 'workspace', 'replica:4', true)).receipt, 'replica:20');
  assert.equal((await observe(12, 'workspace', '', true)).receipt, 'replica:20');
  assert.equal((await observe(12, 'another', 'replica:2', true)).receipt, 'replica:2');
  failure = true; await assert.rejects(observe(16), /Device full/u); failure = false;
  assert.equal((await observe(12)).intentSequence, returned.intentSequence);
  assert.equal((await observe(16)).intentSequence, returned.intentSequence + 1);
  collection = 'copied'; const copy = await observe(16);
  assert.notEqual(copy.intentId, first.intentId); assert.equal(copy.receipt, '');
});
