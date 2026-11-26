import { test } from 'node:test';
import assert from 'node:assert/strict';
import { figmaStatus, githubStatus } from '../editor/lib/footer-status.ts';
import { createWorkspace, workspaceView } from '../integrations/workspace/model.ts';
import type { WorkspaceView } from '../integrations/workspace/model.ts';

const gitInput = { enabled: true, online: true, session: { state: 'connected' as const, login: 'designer', repositories: ['example/tokens'] },
  error: undefined, repository: { repository: 'example/tokens', root: 'tokens', revision: 'a'.repeat(40), pullRequest: 'https://github.com/example/tokens/pull/7' },
  dirty: false, stale: false, interrupted: false, operation: undefined };

await test('GitHub stays unsaved when a draft has only been saved to workspace storage', () => {
  const pending = githubStatus({ ...gitInput, dirty: true });
  assert.equal(pending.connection.state, 'good');
  assert.equal(pending.sync.state, 'bad');
  assert.match(pending.sync.label, /waiting to be saved/u);
  assert.equal(githubStatus(gitInput).sync.state, 'good');
});

await test('cached repository data cannot make an expired or inaccessible GitHub session look connected', () => {
  assert.equal(githubStatus({ ...gitInput, session: { state: 'signed-out' } }).connection.state, 'bad');
  assert.equal(githubStatus({ ...gitInput, online: false }).sync.state, 'pending');
  assert.equal(githubStatus({ ...gitInput, session: { state: 'connected', login: 'other', repositories: [] } }).sync.state, 'bad');
  assert.equal(githubStatus({ ...gitInput, error: 'Service unavailable' }).connection.state, 'bad');
});

await test('GitHub save, failure, stale revision and interrupted save have their own sync states', () => {
  assert.equal(githubStatus({ ...gitInput, operation: { client: 'client', phase: 'saving' } }).sync.state, 'pending');
  assert.match(githubStatus({ ...gitInput, operation: { client: 'client', phase: 'failed', problem: 'Save rejected' } }).sync.label, /Save failed/u);
  assert.equal(githubStatus({ ...gitInput, stale: true }).sync.state, 'bad');
  assert.equal(githubStatus({ ...gitInput, interrupted: true }).sync.state, 'bad');
  assert.equal(githubStatus({ ...gitInput, repository: undefined }).sync.state, 'pending');
});

async function pairedView(): Promise<WorkspaceView> {
  const files = [{ path: 'tokens.json', text: '{"gap":{"$type":"number","$value":8}}' }];
  const view = workspaceView(await createWorkspace('a'.repeat(64), { name: 'Status QA', files, baseline: files }));
  return { ...view, documents: [{ id: 'b'.repeat(64), name: 'Library', role: 'library', baseline: view.draft.revision, offered: view.draft.revision,
    expires: 3000, connections: [{ id: 'c'.repeat(64), expires: 2000, baseline: view.draft.revision, offered: view.draft.revision, acknowledged: true },
      { id: 'd'.repeat(64), expires: 3000, baseline: 'e'.repeat(64), offered: view.draft.revision, acknowledged: true }] }] };
}

await test('Figma counts device acknowledgements independently, including multiple devices in one file', async () => {
  const view = await pairedView();
  const status = figmaStatus(view, 'saved', true, 1000);
  assert.equal(status.connection.state, 'good');
  assert.equal(status.sync.state, 'bad');
  assert.match(status.sync.label, /1 of 2/u);
  const caughtUp = structuredClone(view);
  for (const file of caughtUp.documents) for (const device of file.connections ?? []) device.baseline = view.draft.revision;
  assert.equal(figmaStatus(caughtUp, 'saved', true, 1000).sync.state, 'good');
});

await test('expired and revoked Figma grants stop counting as paired devices', async () => {
  const view = await pairedView();
  assert.equal(figmaStatus(view, 'saved', true, 3000).connection.state, 'bad');
  const revoked = structuredClone(view);
  for (const file of revoked.documents) file.connections = [];
  assert.equal(figmaStatus(revoked, 'saved', true, 1000).connection.state, 'bad');
});

await test('browser connectivity cannot assert Figma plugin presence or current sync', async () => {
  const view = await pairedView();
  const status = figmaStatus(view, 'offline', true, 1000);
  assert.equal(status.connection.state, 'pending');
  assert.equal(status.sync.state, 'pending');
  assert.match(status.connection.label, /offline/u);
  assert.doesNotMatch(status.connection.label, /online/u);
  assert.equal(figmaStatus(view, 'saving', true, 1000).sync.state, 'pending');
});
