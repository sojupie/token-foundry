import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceClient } from '../integrations/workspace/session.ts';
import type { WorkspaceClientContext, WorkspaceClientInput } from '../integrations/workspace/session.ts';
import { createWorkspace, saveWorkspace, workspaceView } from '../integrations/workspace/model.ts';
import type { SharedRecovery, SharedWorkspace, WorkspaceInput } from '../integrations/workspace/model.ts';

const files = (space = 8, other = 16) => [{ path: 'source.tokens.json', text: JSON.stringify({ space: { $type: 'number', $value: space }, other: { $type: 'number', $value: other } }) }];
const snapshot = (space = 8, other = 16): WorkspaceInput => ({ name: 'Work', files: files(space, other), baseline: files() });

const source = (a: boolean, b: number | string, broken = false) => [{ path: 'source.tokens.json', text: JSON.stringify({
    ...(a ? { a: { $type: 'number', $value: 8 } } : {}), b: { $type: 'number', $value: b }, c: { $type: 'number', $value: 16 },
    ...(broken ? { existing: { $type: 'number', $value: '{missing}' } } : {}),
  }) }];
await test('an unchanged shared draft recovers after a failed permission or network check without requiring another edit', async () => {
  const server = transport(await createWorkspace('a'.repeat(64), snapshot())); let unavailable = false;
  const session = new WorkspaceClient({ ...server.api, summary: () => unavailable ? Promise.reject(new Error('Sign in again.')) : server.api.summary() });
  const client = browser(snapshot()); await session.sync('browser', client.context); await session.sync('browser', client.context);
  unavailable = true; await session.sync('browser', client.context); assert.equal(session.get('browser').phase, 'offline');
  unavailable = false; await session.sync('browser', client.context); assert.equal(session.get('browser').phase, 'saved');
});
await test('individually valid concurrent edits cannot save a newly broken combined reference, and a repair resumes sharing', async () => {
  await Promise.all([false, true].map(async broken => {
    const baseline = source(true, 12, broken); const input: WorkspaceInput = { name: 'Aliases', files: baseline, baseline };
    const server = transport(await createWorkspace('a'.repeat(64), input)); let writes = 0; let summaries = 0;
    const session = new WorkspaceClient({ ...server.api, save: (...args) => { writes++; return server.api.save(...args); }, summary: () => { summaries++; return server.api.summary(); } });
    const client = browser(input); await session.sync('browser', client.context);
    client.change({ snapshot: { ...input, files: source(true, '{a}', broken) } });
    server.set(await saveWorkspace(server.get(), server.get().draft, { ...input, files: source(false, 12, broken) }));
    const before = structuredClone(server.get()); await session.sync('browser', client.context);
    assert.equal(session.get('browser').phase, 'invalid'); assert.match(session.get('browser').problem ?? '', /a/u);
    assert.equal(writes, 0); assert.deepEqual(server.get(), before); assert.deepEqual(client.get().snapshot.files, source(true, '{a}', broken));
    const failedState = session.get('browser'); const checks = summaries;
    await session.sync('browser', client.context); assert.equal(summaries, checks + 1); assert.equal(session.get('browser'), failedState, 'An unchanged poll checks access without reviewing or emitting another state.');
    client.change({ snapshot: { ...input, files: source(true, '{c}', broken) } }); await session.sync('browser', client.context);
    assert.equal(session.get('browser').phase, 'saved'); assert.equal(writes, 1); assert.deepEqual(client.get().snapshot.files, source(false, '{c}', broken));
  }));
});

await test('stale conflict choices do not write and explicit current choices adopt their result while review is open', async () => {
  const server = transport(await createWorkspace('a'.repeat(64), snapshot())); const session = new WorkspaceClient(server.api); const client = browser(snapshot());
  await session.sync('browser', client.context); client.change({ snapshot: snapshot(12), canApplyRemote: false });
  server.set(await saveWorkspace(server.get(), server.get().draft, snapshot(10))); await session.sync('browser', client.context);
  const first = session.get('browser').conflicts?.[0]; assert(first);
  server.set(await saveWorkspace(server.get(), server.get().draft, snapshot(11)));
  await session.sync('browser', client.context, [{ id: first.id, keep: 'custom', value: 14 }]);
  assert.equal(session.get('browser').phase, 'conflict'); assert.deepEqual(workspaceView(server.get()).draft.files, files(11)); assert.deepEqual(client.get().snapshot.files, files(12));
  const current = session.get('browser').conflicts?.[0]; assert(current); assert.notEqual(current.id, first.id);
  await session.sync('browser', client.context, [{ id: current.id, keep: 'custom', value: 14 }]);
  assert.equal(session.get('browser').phase, 'saved'); assert.deepEqual(client.get().snapshot.files, files(14)); assert.deepEqual(workspaceView(server.get()).draft.files, files(14));
});

await test('adopting a completed repository checkpoint invalidates an older in-flight poll before it can write or replace recovery', async () => {
  const pin = { repository: 'org/tokens', root: 'tokens', revision: '1'.repeat(40) };
  const input = { ...snapshot(12), repository: pin }; const server = transport(await createWorkspace('a'.repeat(64), input));
  let release: (() => void) | undefined; let entered: (() => void) | undefined; let slow = false; let writes = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const session = new WorkspaceClient({ ...server.api,
    summary: async () => { const version = server.get().version; if (slow) { entered?.(); await waiting; } return { version }; },
    save: async (...args) => { writes++; return server.api.save(...args); },
  });
  const client = browser(input); await session.sync('browser', client.context);
  slow = true; const pending = session.sync('browser', client.context); await started;
  server.set(await saveWorkspace(server.get(), server.get().draft, { ...input, baseline: files(12), repository: { ...pin, revision: '2'.repeat(40) } }));
  const completed = workspaceView(server.get()); session.adopt('browser', completed, client.context);
  release?.(); await pending;
  assert.equal(writes, 0); assert.equal(session.get('browser').view?.version, completed.version); assert.equal(client.recovery()?.repository?.revision, '2'.repeat(40));
  assert.equal(client.get().snapshot.repository?.revision, '2'.repeat(40));
});

await test('requests during a slow response coalesce and only the latest local draft is saved afterward', async () => {
  let release: (() => void) | undefined; let entered: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const server = transport(await createWorkspace('a'.repeat(64), snapshot())); let summaries = 0;
  const session = new WorkspaceClient({ ...server.api, summary: async () => { summaries++; entered?.(); await waiting; return { version: server.get().version }; } });
  const client = browser(snapshot()); await session.sync('browser', client.context);
  const pending = session.sync('browser', client.context); await started;
  for (let value = 10; value < 110; value++) { client.change({ snapshot: snapshot(value) }); assert.equal(session.sync('browser', client.context), pending); }
  release?.(); await pending;
  assert.deepEqual(workspaceView(server.get()).draft.files, files(109)); assert.equal(summaries, 2);
});
function transport(initial: SharedWorkspace, delay?: () => Promise<void>) {
  let server = initial;
  return { get: () => server, set: (state: SharedWorkspace) => { server = state; }, api: {
    create: () => Promise.resolve(workspaceView(server)), load: () => Promise.resolve(workspaceView(server)), summary: () => Promise.resolve({ version: server.version }),
    save: async (_id: string, before: string, input: WorkspaceInput) => { server = await saveWorkspace(server, before, input); await delay?.(); return workspaceView(server); },
  } };
}
function browser(input: WorkspaceInput) {
  let current: WorkspaceClientInput = { client: 'browser', snapshot: input, canApplyRemote: true, origin: 'http://localhost:5173' };
  let recovery: SharedRecovery | undefined; let replacements = 0;
  const context: WorkspaceClientContext = { current: () => current,
    replace: view => { replacements++; current = { ...current, snapshot: { name: view.name, files: view.draft.files, baseline: view.baseline.files, ...(view.repository ? { repository: view.repository } : {}) } }; },
    remember: link => { recovery = link; current = { ...current, recovery: link }; } };
  return { context, get: () => current, change: (value: Partial<WorkspaceClientInput>) => { current = { ...current, ...value }; }, recovery: () => recovery, replacements: () => replacements };
}

await test('a delayed shared save cannot replace a newer local edit and the queued edit advances from its acknowledgement', async () => {
  let complete: (() => void) | undefined; let entered: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { complete = resolve; });
  const saving = new Promise<void>(resolve => { entered = resolve; });
  const server = transport(await createWorkspace('a'.repeat(64), snapshot()), () => { entered?.(); return waiting; });
  const session = new WorkspaceClient(server.api); const client = browser(snapshot());
  await session.sync('browser', client.context);
  client.change({ snapshot: snapshot(12) });
  const first = session.sync('browser', client.context); await saving;
  client.change({ snapshot: snapshot(20) }); complete?.(); await first;
  assert.deepEqual(client.get().snapshot.files, files(20)); assert.equal(client.replacements(), 0);
  await session.sync('browser', client.context);
  assert.deepEqual(workspaceView(server.get()).draft.files, files(20)); assert.equal(session.get('browser').phase, 'saved');
});

await test('remote updates wait for unfinished forms and then merge a committed local edit against the retained baseline', async () => {
  const server = transport(await createWorkspace('a'.repeat(64), snapshot())); const session = new WorkspaceClient(server.api); const client = browser(snapshot());
  await session.sync('browser', client.context);
  const revision = client.recovery()?.accepted.revision;
  server.set(await saveWorkspace(server.get(), server.get().draft, snapshot(12)));
  client.change({ canApplyRemote: false }); await session.sync('browser', client.context);
  assert.equal(session.get('browser').phase, 'updates'); assert.equal(client.recovery()?.accepted.revision, revision); assert.equal(client.replacements(), 0);
  client.change({ canApplyRemote: true, snapshot: snapshot(8, 20) }); await session.sync('browser', client.context);
  assert.deepEqual(client.get().snapshot.files, files(12, 20)); assert.equal(session.get('browser').phase, 'saved');
});

await test('a newer repository checkpoint is adopted rather than overwritten by a browser with no checkpoint edits', async () => {
  const pin = { repository: 'example/tokens', root: 'tokens', revision: '1'.repeat(40) };
  const original = { ...snapshot(), repository: pin };
  const server = transport(await createWorkspace('a'.repeat(64), original)); const session = new WorkspaceClient(server.api); const client = browser(original);
  await session.sync('browser', client.context);
  server.set(await saveWorkspace(server.get(), server.get().draft, { name: 'Work', files: files(12), baseline: files(12), repository: { ...pin, revision: '2'.repeat(40) } }));
  await session.sync('browser', client.context);
  assert.equal(server.get().repository?.revision, '2'.repeat(40)); assert.equal(client.get().snapshot.repository?.revision, '2'.repeat(40));
  assert.deepEqual(client.get().snapshot.baseline, files(12));
});

await test('a response for another workspace does not change the active editor or its recovery identity', async () => {
  let finish: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const server = transport(await createWorkspace('a'.repeat(64), snapshot()));
  const originalLoad = server.api.create;
  const session = new WorkspaceClient({ ...server.api, create: async () => { await waiting; return originalLoad(); } });
  const client = browser(snapshot()); const pending = session.sync('browser', client.context);
  await new Promise<void>(resolve => { setTimeout(resolve, 0); });
  client.change({ client: 'other-workspace', snapshot: snapshot(42) }); finish?.(); await pending;
  assert.equal(client.recovery(), undefined); assert.equal(client.replacements(), 0); assert.deepEqual(client.get().snapshot.files, files(42));
});
