import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { digest, readWorkspaceRecord, SharedWorkspaceStore, WorkspaceRegistry, writeWorkspaceRecord } from '../worker/workspace.ts';
import type { WorkspaceNamespace, WorkspaceStorage } from '../worker/workspace.ts';
import { workspaceBrowser, workspaceGrantCapability } from '../worker/workspace-routes.ts';
import { figmaRelayOrigin } from '../integrations/figma/transport.ts';
import { isBundle } from '../integrations/figma/contract.ts';
import { isRecord, requireValue } from '../lib/json.ts';
import { createWorkspace, isWorkspaceView, pairDocument, receiveChanges, saveReviewDrafts, saveWorkspace, workspaceSource } from '../integrations/workspace/model.ts';
import { HttpError } from '../worker/http.ts';
import { identifySubmission } from '../integrations/figma/submission.ts';

function storage(values: Map<string, unknown>, failAt = 0): WorkspaceStorage {
  let writes = 0;
  return { get: (key: string) => Promise.resolve(values.get(key)), put: (key: string, value: unknown) => {
    if (++writes === failAt) return Promise.reject(new Error('Injected write failure'));
    values.set(key, structuredClone(value)); return Promise.resolve();
  } };
}

await test('pairing reserves its target, stays private until ready and rejects replacement without mutating its committed approval', async () => {
  const values = new Map<string, unknown>();
  const registry = new WorkspaceRegistry({ storage: storage(values), blockConcurrencyWhile: action => action() });
  const pair = 'a'.repeat(64); const secret = 'b'.repeat(64);
  const body = { id: pair, secret, connection: 'https://example.test/first', binding: 'c'.repeat(64) };
  const approve = (input: unknown) => registry.fetch(new Request('https://index/pairings', { method: 'POST', headers: { 'X-Foundry-Subject': 'writer' }, body: JSON.stringify(input) }));
  const read = () => registry.fetch(new Request('https://index/pairings?id=' + pair, { headers: { Authorization: 'Bearer ' + secret } }));
  assert.equal((await approve({ ...body, reserve: true })).status, 200);
  assert.deepEqual(await (await read()).json(), { pending: true });
  const reserved = structuredClone([...values]);
  assert.equal((await approve({ ...body, reserve: true, connection: 'https://example.test/second' })).status, 409);
  assert.deepEqual([...values], reserved);
  assert.equal((await approve(body)).status, 200);
  const approved: unknown = await (await read()).json(); assert(isRecord(approved)); assert.equal(approved['connection'], body.connection);
  const committed = structuredClone([...values]);
  assert.equal((await approve({ ...body, reserve: true })).status, 200);
  assert.equal((await approve(body)).status, 200); assert.deepEqual([...values], committed);
});

await test('every interrupted shared-workspace generation write leaves the committed source readable and retryable', async () => {
  const initial = { source: '\uFEFF' + 'å'.repeat(50_000) + '\r\n', revision: 'before' };
  const incoming = { source: '\uFEFF' + 'ö'.repeat(70_000) + '\r\n', revision: 'after' };
  const original = new Map<string, unknown>();
  await writeWorkspaceRecord(storage(original), initial);
  const writes = Math.ceil(JSON.stringify(incoming).length / 32_000) + 2;
  await Promise.all(Array.from({ length: writes }, async (_, index) => {
    const values = new Map(original);
    await assert.rejects(writeWorkspaceRecord(storage(values, index + 1), incoming), /Injected/u);
    assert.deepEqual(await readWorkspaceRecord(storage(values)), initial);
    await writeWorkspaceRecord(storage(values), incoming);
    assert.deepEqual(await readWorkspaceRecord(storage(values)), incoming);
  }));
});

const legacyFiles = (value: number) => [{ path: 'tokens/base.json', text: '\uFEFF{"space":{"$type":"number","$value":' + value + '},"alias":{"$type":"number","$value":"{space}"}}\r\n' }];
const aliasSources = (a: boolean, b: number | string) => [{ path: 'tokens/base.json', text: JSON.stringify({
  ...(a ? { a: { $type: 'number', $value: 8 } } : {}), b: { $type: 'number', $value: b },
}) }];

await test('a stale HTTP save reports invalid merged references separately from transport failure and retains committed storage', async () => {
  const input = { name: 'Aliases', files: aliasSources(true, 12), baseline: aliasSources(true, 12) };
  const original = await createWorkspace('a'.repeat(64), input);
  const remote = await saveWorkspace(original, original.draft, { ...input, files: aliasSources(false, 12) });
  const values = new Map<string, unknown>(); const persisted = storage(values);
  await writeWorkspaceRecord(persisted, { owner: 'owner', workspace: remote, grants: [] });
  const store = new SharedWorkspaceStore({ storage: persisted, blockConcurrencyWhile: callback => callback() });
  const before = structuredClone(await readWorkspaceRecord(persisted));
  const response = await store.fetch(new Request('https://workspace/workspace', { method: 'PUT', headers: { 'X-Foundry-Subject': 'owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ before: original.draft, snapshot: { ...input, files: aliasSources(true, '{a}') } }),
  }));
  assert.equal(response.status, 422); assert.match(await response.text(), /a/u);
  assert.deepEqual(await readWorkspaceRecord(persisted), before);
});

await test('upgrading a persisted single-device workspace retains its source bytes, receipt and unfinished conflict choices', async () => {
  const grant = 'b'.repeat(64); const secret = 'c'.repeat(64);
  const initial = pairDocument(await createWorkspace('a'.repeat(64), { name: 'Legacy', files: legacyFiles(8), baseline: legacyFiles(8) }), { id: 'library', name: 'Library', role: 'library' });
  const accepted = await receiveChanges(initial, 'library', { schemaVersion: 1, sourceRevision: initial.draft, changes: [{ path: 'space', before: 8, after: 12 }] });
  assert(accepted.acknowledgement);
  const edited = await saveWorkspace(accepted.state, accepted.state.draft, { name: 'Legacy', files: legacyFiles(16), baseline: legacyFiles(8) });
  const pending = await receiveChanges(edited, 'library', { schemaVersion: 1, sourceRevision: initial.draft, changes: [{ path: 'space', before: 8, after: 14 }] });
  const workspace = await saveReviewDrafts(pending.state, 'library', pending.state.draft, [{ path: 'space', keep: 'custom', text: 'unfinished' }]);
  const values = new Map<string, unknown>(); const persisted = storage(values);
  await writeWorkspaceRecord(persisted, { owner: 'owner', workspace, grants: [{ id: grant, document: 'library', hash: await digest(secret), expires: Date.now() + 60_000 }] });
  const start = () => new SharedWorkspaceStore({ storage: persisted, blockConcurrencyWhile: callback => callback() });
  let store = start();
  const browser = () => store.fetch(new Request('https://workspace/workspace', { headers: { 'X-Foundry-Subject': 'owner' } }));
  const migrated: unknown = await (await browser()).json(); assert(isWorkspaceView(migrated));
  assert.deepEqual(migrated.draft.files, workspaceSource(workspace).files); assert.deepEqual(migrated.baseline.files, legacyFiles(8));
  assert.equal(migrated.documents[0]?.connections?.length, 1); assert.equal(migrated.incoming[0]?.replica, grant);
  assert.deepEqual(migrated.incoming[0]?.review?.drafts, [{ path: 'space', keep: 'custom', text: 'unfinished' }]);
  store = start();
  const native: unknown = await (await store.fetch(new Request('https://workspace/file/' + grant, { headers: { Authorization: 'Bearer ' + secret } }))).json();
  assert(isRecord(native) && isRecord(native['acknowledgement']) && isRecord(native['pending']));
  assert.equal(native['acknowledgement']['id'], accepted.acknowledgement.id);
  assert.deepEqual(native['pending']['drafts'], [{ path: 'space', keep: 'custom', text: 'unfinished' }]);
  const restored: unknown = await (await browser()).json(); assert(isWorkspaceView(restored));
  assert.equal(restored.draft.revision, migrated.draft.revision);
  assert(isRecord(native['workspace'])); assert.equal(restored.version, native['workspace']['version']);
  const unchanged: unknown = await (await browser()).json(); assert(isWorkspaceView(unchanged));
  assert.equal(unchanged.version, restored.version, 'Repeated reads do not migrate or save again.');
});

await test('real SQLite retains the shared draft across Worker restart and Figma grant revocation without a browser Share step', async () => {
  const compiled = await Promise.all(['worker/figma-relay.ts', 'worker/figma-state.ts'].map(entry => build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false })));
  const relay = requireValue(compiled[0]?.outputFiles[0]?.text, 'Relay'); const state = requireValue(compiled[1]?.outputFiles[0]?.text, 'Workspace Worker');
  const directory = await mkdtemp(join(tmpdir(), 'foundry-workspace-runtime-'));
  assert(resolve(directory).startsWith(resolve(tmpdir()) + sep), 'Unexpected temporary runtime path.');
  const key = '1'.repeat(64); const id = 'a'.repeat(64); const grant = 'b'.repeat(64); const secret = await workspaceGrantCapability(id, grant, key);
  const startRuntime = () => new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: directory, workers: [
    { name: 'relay', modules: true, script: relay, compatibilityDate: '2026-11-01', bindings: { RELAY_ORIGIN: figmaRelayOrigin, FIGMA_CONNECTION_KEY: key },
      durableObjects: { WORKSPACES: { className: 'SharedWorkspaceStore', scriptName: 'state', useSQLite: true }, WORKSPACE_INDEX: { className: 'WorkspaceRegistry', scriptName: 'state', useSQLite: true } } },
    { name: 'state', modules: true, script: state, compatibilityDate: '2026-11-01', durableObjects: {
      WORKSPACES: { className: 'SharedWorkspaceStore', useSQLite: true }, WORKSPACE_INDEX: { className: 'WorkspaceRegistry', useSQLite: true },
    } },
  ] }));
  let runtime = startRuntime();
  const getStore = async () => { const bindings = await runtime.getBindings<{ WORKSPACES: WorkspaceNamespace }>('state'); return bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('workspace:' + id)); };
  const call = async (path: string, method = 'GET', body?: unknown, subject = 'designer') => (await getStore()).fetch(new Request('https://workspace/' + path, { method,
    headers: { 'X-Foundry-Subject': subject }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  try {
    const files = [{ path: 'tokens/source.json', text: JSON.stringify({ $extensions: { example: { keep: 'å'.repeat(160_000) } },
      space: { $type: 'number', $value: 8 }, other: { $type: 'number', $value: 16 }, alias: { $type: 'number', $value: '{space}' } }) }];
    const created = await call('create', 'POST', { id, snapshot: { name: 'Shared', files, baseline: files } });
    assert.equal(created.status, 200, await created.text());
    const renamed = await call('name', 'POST', { before: 'Shared', name: 'SQLite workspace' });
    assert.equal(renamed.status, 200, await renamed.clone().text());
    const named: unknown = await renamed.json(); assert(isRecord(named)); assert.equal(named['name'], 'SQLite workspace');
    const paired = await call('documents', 'POST', { document: 'library', name: 'UI kit', role: 'library', id: grant, secret });
    assert.equal(paired.status, 200, await paired.text());
    const pair = 'c'.repeat(64); const pairSecret = 'd'.repeat(64);
    const bindings = await runtime.getBindings<{ WORKSPACES: WorkspaceNamespace; WORKSPACE_INDEX: WorkspaceNamespace }>('state');
    const origin = 'https://sevan.tokenfoundry.lindstruct.com';
    const approved = await workspaceBrowser(new Request(origin + '/git/workspaces/' + id + '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pair, secret: pairSecret, document: 'paired-file', name: 'Paired file', role: 'concept' }) }), { ...bindings, EDITOR_ORIGIN: origin, FIGMA_PLUGIN_ORIGIN: figmaRelayOrigin, FIGMA_CONNECTION_KEY: key }, 'designer');
    assert.equal(approved?.status, 200); const approval: unknown = await approved?.json();
    assert(isRecord(approval) && approval['approved'] === true && approval['connection'] === undefined);
    const pairedBefore: unknown = await (await call('workspace')).json();
    const retryApproval = () => workspaceBrowser(new Request(origin + '/git/workspaces/' + id + '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pair, secret: pairSecret, document: 'paired-file', name: 'Paired file', role: 'concept' }) }), { ...bindings, EDITOR_ORIGIN: origin, FIGMA_PLUGIN_ORIGIN: figmaRelayOrigin, FIGMA_CONNECTION_KEY: key }, 'designer');
    assert.equal((await retryApproval())?.status, 200);
    assert.deepEqual(await (await call('workspace')).json(), pairedBefore, 'Retrying an approved pairing creates no grant, event or expiry renewal.');
    const otherId = '2'.repeat(64);
    const otherStore = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName('workspace:' + otherId));
    assert.equal((await otherStore.fetch(new Request('https://workspace/create', { method: 'POST', headers: { 'X-Foundry-Subject': 'designer' }, body: JSON.stringify({ id: otherId, snapshot: { name: 'Other workspace', files, baseline: files } }) }))).status, 200);
    const racePair = '3'.repeat(64); const raceSecret = '4'.repeat(64);
    const approveTarget = (target: string, pairId: string, pairKey: string, index = bindings.WORKSPACE_INDEX) => workspaceBrowser(new Request(origin + '/git/workspaces/' + target + '/pair', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pair: pairId, secret: pairKey, document: 'racing-file', name: 'Racing file', role: 'concept' }),
    }), { ...bindings, WORKSPACE_INDEX: index, EDITOR_ORIGIN: origin, FIGMA_PLUGIN_ORIGIN: figmaRelayOrigin, FIGMA_CONNECTION_KEY: key }, 'designer');
    const competing = await Promise.all([approveTarget(id, racePair, raceSecret), approveTarget(otherId, racePair, raceSecret)]);
    assert.deepEqual(competing.map(response => requireValue(response, 'Pairing response').status).toSorted((left, right) => left - right), [200, 409]);
    const views: unknown[] = await Promise.all([call('workspace').then(response => response.json()), otherStore.fetch(new Request('https://workspace/workspace', { headers: { 'X-Foundry-Subject': 'designer' } })).then(response => response.json())]);
    assert(views.every(isWorkspaceView));
    assert.equal(views.flatMap(view => view.documents.filter(document => document.id === 'racing-file')).length, 1, 'Only the reserved target receives a document or grant.');
    assert(views.every(view => JSON.stringify(view.draft.files) === JSON.stringify(files)), 'Competing approval cannot change either source.');

    const interruptedPair = '5'.repeat(64); const interruptedSecret = '6'.repeat(64); let finalizationFailed = false;
    const faultIndex: WorkspaceNamespace = { idFromName: name => bindings.WORKSPACE_INDEX.idFromName(name), get: objectId => ({ fetch: async request => {
      const body: unknown = request.method === 'POST' ? await request.clone().json() : undefined;
      if (new URL(request.url).pathname === '/pairings' && isRecord(body) && body['id'] === interruptedPair && body['reserve'] !== true) { finalizationFailed = true; throw new Error('Injected pairing finalization failure'); }
      return bindings.WORKSPACE_INDEX.get(objectId).fetch(request);
    } }) };
    await assert.rejects(approveTarget(id, interruptedPair, interruptedSecret, faultIndex), /Injected pairing finalization failure/u); assert(finalizationFailed);
    const interruptedBefore: unknown = await (await call('workspace')).json(); assert(isWorkspaceView(interruptedBefore));
    const waitingPair: unknown = await (await runtime.dispatchFetch(figmaRelayOrigin + '/figma/pairing/' + interruptedPair, { headers: { Authorization: 'Bearer ' + interruptedSecret } })).json();
    assert.deepEqual(waitingPair, { pending: true }, 'A committed grant remains private until finalization.');
    assert.equal((await approveTarget(id, interruptedPair, interruptedSecret))?.status, 200);
    assert.deepEqual(await (await call('workspace')).json(), interruptedBefore, 'Retrying interrupted approval retains the exact grant, expiry, draft and event history.');
    assert.equal((await runtime.dispatchFetch(figmaRelayOrigin + '/figma/pairing/' + pair, { headers: { Authorization: 'Bearer ' + '0'.repeat(64) } })).status, 403);
    const url = figmaRelayOrigin + '/figma/workspaces/' + id + '/files/' + grant;
    const secondGrant = 'e'.repeat(64); const secondSecret = await workspaceGrantCapability(id, secondGrant, key);
    assert.equal((await call('documents', 'POST', { document: 'library', name: 'UI kit', role: 'library', id: secondGrant, secret: secondSecret })).status, 200);
    const secondURL = figmaRelayOrigin + '/figma/workspaces/' + id + '/files/' + secondGrant;
    const secondHeaders = { Origin: 'null', Authorization: 'Bearer ' + secondSecret };
    const headers = { Origin: 'null', Authorization: 'Bearer ' + secret, 'X-Foundry-Subject': 'spoofed-owner' };
    const fetched = await runtime.dispatchFetch(url, { headers }); assert.equal(fetched.status, 200);
    const bundle: unknown = await fetched.json(); assert(isBundle(bundle)); assert.deepEqual(bundle.files, files);
    const proposal = await identifySubmission({ schemaVersion: 1, sourceRevision: bundle.revision, changes: [{ path: 'space', before: 8, after: 12 }] }, '', id);
    const sent = await runtime.dispatchFetch(url, { method: 'POST', headers, body: JSON.stringify(proposal) });
    assert.equal(sent.status, 200); const accepted: unknown = await sent.json();
    assert(isRecord(accepted) && accepted['accepted'] === true && isRecord(accepted['acknowledgement']));
    const receipt = accepted['acknowledgement']['id'];
    const secondSend = await runtime.dispatchFetch(secondURL, { method: 'POST', headers: secondHeaders, body: JSON.stringify({ schemaVersion: 1, sourceRevision: bundle.revision, changes: [{ path: 'other', before: 16, after: 20 }] }) });
    assert.equal(secondSend.status, 200); const secondAccepted: unknown = await secondSend.json();
    assert(isRecord(secondAccepted) && secondAccepted['accepted'] === true && isRecord(secondAccepted['acknowledgement']));
    assert.notEqual(secondAccepted['acknowledgement']['id'], receipt);
    assert.equal((await runtime.dispatchFetch(secondURL, { method: 'POST', headers: secondHeaders, body: JSON.stringify({ action: 'resume', revision: accepted['revision'] }) })).status, 200, 'A file snapshot saved by another device is a valid resume baseline.');
    const unknownResume = await runtime.dispatchFetch(secondURL, { method: 'POST', headers: secondHeaders, body: JSON.stringify({ action: 'resume', revision: 'f'.repeat(64) }) });
    assert.equal(unknownResume.status, 409); const resumeError: unknown = await unknownResume.json();
    assert(isRecord(resumeError)); assert.equal(resumeError['code'], 'source-baseline-unavailable');
    const indexBefore: unknown = await (await bindings.WORKSPACE_INDEX.get(bindings.WORKSPACE_INDEX.idFromName('owner:' + await digest('designer'))).fetch(new Request('https://index/', { headers: { 'X-Foundry-Subject': 'designer' } }))).json();
    assert(isRecord(indexBefore) && Array.isArray(indexBefore['workspaces']));
    assert.equal(JSON.stringify(indexBefore).includes(String(secondAccepted['revision'])), true, 'Native changes update workspace discovery without a browser save.');
    await runtime.dispose(); runtime = startRuntime();
    const restoredPair: unknown = await (await runtime.dispatchFetch(figmaRelayOrigin + '/figma/pairing/' + pair, { headers: { Authorization: 'Bearer ' + pairSecret } })).json();
    assert(isRecord(restoredPair) && typeof restoredPair['connection'] === 'string');
    const connection = new URL(restoredPair['connection']); const access = connection.hash.slice(1); connection.hash = '';
    assert.equal((await runtime.dispatchFetch(connection.href, { headers: { Authorization: 'Bearer ' + access } })).status, 200);
    const restartedResponse = await runtime.dispatchFetch(url, { headers });
    const afterRestart: unknown = await restartedResponse.json();
    assert.equal(restartedResponse.status, 200, isRecord(afterRestart) ? String(afterRestart['message']) : 'Invalid response.');
    assert(isBundle(afterRestart) && isRecord(afterRestart));
    assert.equal(afterRestart.variables.find(row => row.path === 'space')?.value, 12);
    assert.equal(afterRestart.variables.find(row => row.path === 'other')?.value, 20);
    assert.equal(afterRestart.variables.find(row => row.path === 'alias')?.alias, 'space');
    const retry: unknown = await (await runtime.dispatchFetch(url, { method: 'POST', headers, body: JSON.stringify(proposal) })).json();
    assert(isRecord(retry) && isRecord(retry['acknowledgement'])); assert.equal(retry['acknowledgement']['id'], receipt);
    const beforeRevert: unknown = await (await call('workspace')).json(); assert(isWorkspaceView(beforeRevert));
    const revertedFiles = beforeRevert.draft.files.map(file => ({ ...file, text: file.text.replace('"$value":12', '"$value":8') }));
    const revertedResponse = await call('workspace', 'PUT', { before: beforeRevert.draft.revision,
      snapshot: { name: beforeRevert.name, files: revertedFiles, baseline: beforeRevert.baseline.files } });
    assert.equal(revertedResponse.status, 200); const reverted: unknown = await revertedResponse.json(); assert(isWorkspaceView(reverted));
    const fresh = await identifySubmission({ schemaVersion: 1, sourceRevision: reverted.draft.revision, changes: [{ path: 'space', before: 8, after: 12 }] }, String(receipt), id);
    assert.equal((await runtime.dispatchFetch(url, { headers })).status, 200, 'Read the restored source before editing it again.');
    const beforeInvalid: unknown = await (await call('workspace')).json();
    const postProposal = (value: unknown) => runtime.dispatchFetch(url, { method: 'POST', headers, body: JSON.stringify(value) });
    assert.equal((await postProposal({ ...fresh, submissionId: '0'.repeat(64) })).status, 400);
    assert.equal((await postProposal(await identifySubmission(fresh, String(receipt), 'f'.repeat(64)))).status, 400);
    assert.deepEqual(await (await call('workspace')).json(), beforeInvalid, 'Invalid identities do not mutate shared storage.');
    const freshResponse = await postProposal(fresh); assert.equal(freshResponse.status, 200);
    const freshAccepted: unknown = await freshResponse.json(); assert(isRecord(freshAccepted) && isRecord(freshAccepted['acknowledgement']));
    assert.equal(freshAccepted['accepted'], true); assert.notEqual(freshAccepted['acknowledgement']['id'], receipt);
    const savedFresh: unknown = await (await call('workspace')).json(); assert(isWorkspaceView(savedFresh));
    assert(savedFresh.draft.files[0]?.text.includes('"$value":12'));
    await runtime.dispose(); runtime = startRuntime();
    const freshRetry: unknown = await (await postProposal(fresh)).json(); assert(isRecord(freshRetry) && isRecord(freshRetry['acknowledgement']));
    assert.equal(freshRetry['acknowledgement']['id'], freshAccepted['acknowledgement']['id']);
    assert.deepEqual(await (await call('workspace')).json(), savedFresh, 'A persisted retry creates no new event or conflict queue.');
    const resume = (target: string, authorization: typeof secondHeaders, revision: unknown, acknowledgedReceipt: unknown) => runtime.dispatchFetch(target, {
      method: 'POST', headers: authorization, body: JSON.stringify({ action: 'resume', revision, acknowledgedReceipt }),
    });
    const resumed = await resume(secondURL, secondHeaders, savedFresh.draft.revision, freshAccepted['acknowledgement']['id']);
    assert.equal(resumed.status, 200, await resumed.clone().text());
    const secondModern = await identifySubmission({ schemaVersion: 1, sourceRevision: savedFresh.draft.revision, changes: [{ path: 'other', before: 20, after: 24 }] }, String(freshAccepted['acknowledgement']['id']), id);
    const secondModernResponse = await runtime.dispatchFetch(secondURL, { method: 'POST', headers: secondHeaders, body: JSON.stringify(secondModern) });
    assert.equal(secondModernResponse.status, 200, await secondModernResponse.clone().text());
    const crossDevice: unknown = await secondModernResponse.json(); assert(isRecord(crossDevice) && isRecord(crossDevice['acknowledgement']));
    assert.equal((await resume(url, headers, crossDevice['revision'], crossDevice['acknowledgement']['id'])).status, 200);
    const thirdModern = await identifySubmission({ schemaVersion: 1, sourceRevision: String(crossDevice['revision']), changes: [{ path: 'space', before: 12, after: 14 }] }, String(crossDevice['acknowledgement']['id']), id);
    const thirdResponse = await postProposal(thirdModern); assert.equal(thirdResponse.status, 200, await thirdResponse.clone().text());
    const thirdAccepted: unknown = await thirdResponse.json(); assert(isBundle(thirdAccepted));
    assert.equal(thirdAccepted.variables.find(row => row.path === 'space')?.value, 14); assert.equal(thirdAccepted.variables.find(row => row.path === 'other')?.value, 24);
    const beforeUnknown: unknown = await (await call('workspace')).json();
    assert.equal((await resume(url, headers, thirdAccepted.revision, 'unknown-receipt')).status, 409);
    assert.deepEqual(await (await call('workspace')).json(), beforeUnknown);
    assert.equal((await call('workspace', 'GET', undefined, 'other-account')).status, 403);
    assert.equal((await runtime.dispatchFetch(url, { headers: { Authorization: 'Bearer ' + '0'.repeat(64) } })).status, 401);
    const revoked = await call('revoke', 'POST', { document: 'library', grant }); assert.equal(revoked.status, 200);
    assert.equal((await runtime.dispatchFetch(url, { headers })).status, 410);
    assert.equal((await runtime.dispatchFetch(secondURL, { headers: secondHeaders })).status, 200, 'Revoking one device retains the other device connection.');
    const connections: unknown = await (await call('workspace')).json(); assert(isWorkspaceView(connections));
    assert.equal(connections.documents.find(file => file.id === 'library')?.connections?.length, 1);
    assert.equal((await call('revoke', 'POST', { document: 'library' })).status, 200);
    assert.equal((await runtime.dispatchFetch(secondURL, { headers: secondHeaders })).status, 410);
    const retained: unknown = await (await call('workspace')).json();
    assert(isRecord(retained) && isRecord(retained['draft'])); assert.equal(retained['draft']['revision'], thirdAccepted.revision);
    assert.equal(JSON.stringify(retained).includes(secret), false);

    const currentBindings = await runtime.getBindings<{ WORKSPACES: WorkspaceNamespace; WORKSPACE_INDEX: WorkspaceNamespace }>('state');
    const config = { ...currentBindings, EDITOR_ORIGIN: origin, GIT_PROJECTS: JSON.stringify({ 'org/tokens': 'tokens', 'private/other': 'tokens' }) };
    const repository = { repository: 'org/tokens', root: 'tokens', revision: '1'.repeat(40) };
    const source = [{ path: 'tokens/base.tokens.json', text: '{"space":{"$type":"number","$value":8}}\r\n' }];
    const browser = (subject: string, path: string, method = 'GET', body?: unknown, allowed = true) => workspaceBrowser(new Request(origin + '/git/workspaces' + path, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Foundry-Repository': repository.repository, 'X-Foundry-Repository-Root': repository.root }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config, subject,
      (name, root) => Promise.resolve(allowed && name === repository.repository && (root === undefined || root === repository.root)));
    const repoCreated = await browser('owner', '', 'POST', { client: 'repository-sharing', snapshot: { name: 'Shared repository draft', files: source, baseline: source, repository } });
    assert(repoCreated?.ok); const repoView: unknown = await repoCreated.json(); assert(isWorkspaceView(repoView));
    const sharedPath = '/' + repoView.id;
    const writeAccess = await browser('writer', sharedPath); assert.equal(writeAccess?.status, 200);
    await assert.rejects(browser('reader', sharedPath, 'GET', undefined, false), error => error instanceof HttpError && error.status === 403);
    await assert.rejects(browser('owner', sharedPath, 'GET', undefined, false), error => error instanceof HttpError && error.status === 403, 'A repository owner with revoked GitHub rights cannot bypass the browser authorization check.');
    const discovered: unknown = await (await browser('writer', '?repository=' + encodeURIComponent(repository.repository)))?.json();
    assert(isRecord(discovered) && Array.isArray(discovered['workspaces'])); assert.equal(JSON.stringify(discovered).includes(repoView.id), true);
    const firstPairing: unknown = await (await browser('writer', ''))?.json();
    assert(isRecord(firstPairing)); assert.equal(JSON.stringify(firstPairing).includes(repoView.id), true, 'A repository writer discovers another author\'s workspace without first opening that repository.');
    const deniedList: unknown = await (await browser('reader', '', 'GET', undefined, false))?.json();
    assert(isRecord(deniedList)); assert.equal(JSON.stringify(deniedList).includes(repoView.id), false);
    const revokedOwnerList: unknown = await (await browser('owner', '', 'GET', undefined, false))?.json();
    assert(isRecord(revokedOwnerList)); assert.equal(JSON.stringify(revokedOwnerList).includes(repoView.id), false, 'An old owner index cannot expose a renamed draft after write access is revoked.');
    const signedOut: unknown = await (await workspaceBrowser(new Request(origin + '/git/workspaces'), config, 'designer', () => { throw new HttpError(401, 'Sign in to GitHub.'); }))?.json();
    assert(isRecord(signedOut)); assert.equal(signedOut['repositoryDiscovery'], 'sign-in'); assert.equal(JSON.stringify(signedOut).includes('SQLite workspace'), true, 'Personal local-source drafts remain discoverable without GitHub.');
    await assert.rejects(browser('reader', '?repository=' + encodeURIComponent(repository.repository), 'GET', undefined, false), error => error instanceof HttpError && error.status === 403);
    const changed = source.map(file => ({ ...file, text: file.text.replace(':8', ':12') }));
    const sharedEdit = await browser('writer', sharedPath, 'PUT', { before: repoView.draft.revision, snapshot: { name: repoView.name, files: changed, baseline: source, repository } }); assert.equal(sharedEdit?.status, 200);
    const writerSaved: unknown = await sharedEdit?.json(); assert(isWorkspaceView(writerSaved)); assert.equal(writerSaved.draft.files[0]?.text, changed[0]?.text);
    const ownerSees: unknown = await (await browser('owner', sharedPath))?.json(); assert(isWorkspaceView(ownerSees)); assert.equal(ownerSees.draft.revision, writerSaved.draft.revision);
    const repointed = await browser('writer', sharedPath, 'PUT', { before: writerSaved.draft.revision, snapshot: { name: repoView.name, files: changed, baseline: source, repository: { ...repository, repository: 'another/tokens' } } }); assert.equal(repointed?.status, 403);
    const directStore = currentBindings.WORKSPACES.get(currentBindings.WORKSPACES.idFromName('workspace:' + repoView.id));
    assert.equal((await directStore.fetch(new Request('https://workspace/workspace', { headers: { 'X-Foundry-Subject': 'unverified-browser' } }))).status, 403);
    const deleteDoc: unknown = await (await workspaceBrowser(new Request(origin + '/git/workspaces' + sharedPath + '/documents', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: 'delete-doc', name: 'Delete doc', role: 'library' }),
    }), { ...config, FIGMA_PLUGIN_ORIGIN: figmaRelayOrigin, FIGMA_CONNECTION_KEY: key }, 'owner',
    (name, root) => Promise.resolve(name === repository.repository && (root === undefined || root === repository.root))))?.json();
    assert(isRecord(deleteDoc) && typeof deleteDoc['connection'] === 'string');
    const deleteGrantUrl = new URL(deleteDoc['connection']);
    const deleteGrantAuth = { Authorization: 'Bearer ' + deleteGrantUrl.hash.slice(1) };
    deleteGrantUrl.hash = '';
    assert.equal((await runtime.dispatchFetch(deleteGrantUrl.href, { headers: deleteGrantAuth })).status, 200);
    await assert.rejects(browser('reader', sharedPath, 'DELETE', undefined, false), error => error instanceof HttpError && error.status === 403);
    await assert.rejects(workspaceBrowser(new Request(origin + '/git/workspaces' + sharedPath, { method: 'DELETE', headers: { Origin: 'https://evil.example' } }), config, 'owner', () => Promise.resolve(true)), error => error instanceof HttpError && error.status === 403);
    const deleted = await browser('owner', sharedPath, 'DELETE');
    assert.equal(deleted?.status, 200);
    await assert.rejects(browser('owner', sharedPath), error => error instanceof HttpError && error.status === 404);
    assert.equal((await runtime.dispatchFetch(deleteGrantUrl.href, { headers: deleteGrantAuth })).status, 404);
    const ownerAfterDelete: unknown = await (await browser('owner', ''))?.json();
    assert.equal(JSON.stringify(ownerAfterDelete).includes(repoView.id), false);
    const repoAfterDelete: unknown = await (await browser('writer', '?repository=' + encodeURIComponent(repository.repository)))?.json();
    assert.equal(JSON.stringify(repoAfterDelete).includes(repoView.id), false);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

