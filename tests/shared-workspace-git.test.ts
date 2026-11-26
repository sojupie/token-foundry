import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SharedWorkspaceStore, readWorkspaceRecord } from '../worker/workspace.ts';
import { isRecord } from '../lib/json.ts';
import { isSharedWorkspace, isWorkspaceView } from '../integrations/workspace/model.ts';
import type { PullRequestProposal } from '../integrations/github/contract.ts';
import { proposalUnavailable } from '../integrations/github/contract.ts';

await test('a closed proposal or deleted branch releases only an unstarted review and retains the draft for reconciliation', async () => {
  await Promise.all(['closed', 'deleted'].map(async scenario => {
    const values = new Map<string, unknown>(); let sequence = Promise.resolve();
    const state = { storage: { get: (key: string) => Promise.resolve(structuredClone(values.get(key))), put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); return Promise.resolve(); } },
      blockConcurrencyWhile: <T>(action: () => Promise<T>) => { const next = sequence.then(action); sequence = next.then(() => undefined, () => undefined); return next; } };
    const repository = 'org/tokens'; const revision = 'a'.repeat(40); const branch = 'token-editor/' + 'A'.repeat(43);
    const before = '{"space":{"$type":"number","$value":8}}\r\n'; const after = before.replace(':8', ':12'); const path = 'tokens/base.tokens.json';
    let mutations = 0;
    const transport: typeof fetch = (input, options) => {
      if (options?.method && options.method !== 'GET') mutations++;
      const endpoint = decodeURIComponent(new URL(input instanceof Request ? input.url : input).pathname);
      if (endpoint === '/repos/' + repository) return Promise.resolve(Response.json({ default_branch: 'main' }));
      if (endpoint.endsWith('/pulls')) return Promise.resolve(Response.json(scenario === 'closed' ? [] : [{ number: 7 }]));
      if (endpoint.endsWith('/git/ref/heads/' + branch)) return Promise.resolve(scenario === 'deleted' ? new Response(null, { status: 404 }) : Response.json({ object: { sha: revision } }));
      throw new Error('Rejected preflight must not continue: ' + endpoint);
    };
    let store = new SharedWorkspaceStore(state, {}, transport);
    const call = (endpoint: string, method = 'GET', body?: unknown) => store.fetch(new Request('https://workspace/' + endpoint, { method,
      headers: { 'X-Foundry-Subject': 'owner', 'X-Foundry-Git-Token': 'fixture' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const pin = { repository, revision, root: 'tokens', branch, pullRequest: 'https://github.com/org/tokens/pull/7' };
    const files = [{ path, text: before }];
    const created: unknown = await (await call('create', 'POST', { id: '1'.repeat(64), snapshot: { name: 'Draft', files, baseline: files, repository: pin } })).json(); assert(isWorkspaceView(created));
    assert.equal((await call('workspace', 'PUT', { before: created.draft.revision, snapshot: { name: 'Draft', files: [{ path, text: after }], baseline: files, repository: pin } })).status, 200);
    const response = await call('proposal', 'POST', { root: 'tokens', proposal: { repository, revision, branch, changes: [{ path, before, after }] } });
    assert.equal(response.status, 409); const rejected: unknown = await response.json(); assert(isRecord(rejected)); assert.equal(rejected['code'], proposalUnavailable);
    store = new SharedWorkspaceStore(state, {}, transport);
    const retained: unknown = await (await call('workspace')).json(); assert(isWorkspaceView(retained));
    assert.equal(retained.repositorySave, undefined); assert.equal(retained.baseline.files[0]?.text, before); assert.equal(retained.draft.files[0]?.text, after); assert.equal(mutations, 0);
    const { branch: oldBranch, pullRequest, ...latest } = pin; void oldBranch; void pullRequest;
    assert.equal((await call('workspace', 'PUT', { before: retained.draft.revision, snapshot: { name: 'Draft', files: retained.draft.files, baseline: files, repository: latest } })).status, 200);
  }));
});

await test('a lost GitHub commit response resumes after a server restart and checkpoints only reviewed bytes while native edits continue', async () => {
  const values = new Map<string, unknown>(); let sequence = Promise.resolve();
  const state = { storage: { get: (key: string) => Promise.resolve(structuredClone(values.get(key))), put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); return Promise.resolve(); } },
    blockConcurrencyWhile: <T>(action: () => Promise<T>) => { const next = sequence.then(action); sequence = next.then(() => undefined, () => undefined); return next; } };
  const repository = 'org/tokens'; const base = 'a'.repeat(40); const committed = 'b'.repeat(40);
  const rootTree = 'c'.repeat(40); const tokenTree = 'd'.repeat(40); const path = 'tokens/base.tokens.json';
  const before = '\uFEFF{"space":{"$type":"number","$value":8},"other":{"$type":"number","$value":16}}\r\n';
  const reviewed = before.replace(':8', ':12'); const prefix = '/repos/' + repository;
  let branch = ''; let head = base; let commits = 0; let calls = 0;
  let entered: (() => void) | undefined; const committing = new Promise<void>(resolve => { entered = resolve; });
  let release: (() => void) | undefined; const waiting = new Promise<void>(resolve => { release = resolve; });
  const transport: typeof fetch = async (input, options) => {
    calls++;
    const url = new URL(input instanceof Request ? input.url : input); const endpoint = decodeURIComponent(url.pathname);
    if (endpoint === prefix) return Response.json({ default_branch: 'main' });
    if (endpoint === prefix + '/git/ref/heads/main') return Response.json({ object: { sha: base } });
    if (endpoint.startsWith(prefix + '/git/ref/heads/token-editor/')) return branch ? Response.json({ object: { sha: head } }) : new Response(null, { status: 404 });
    if (endpoint === prefix + '/git/commits/' + base) return Response.json({ tree: { sha: rootTree } });
    if (endpoint === prefix + '/git/trees/' + rootTree) return Response.json({ truncated: false, tree: [{ path: 'tokens', type: 'tree', sha: tokenTree }] });
    if (endpoint === prefix + '/git/trees/' + tokenTree) return Response.json({ truncated: false, tree: [{ path: 'base.tokens.json', type: 'blob', mode: '100644', size: before.length }] });
    if (endpoint === prefix + '/contents/' + path) return new Response(url.searchParams.get('ref') === committed ? reviewed : before);
    if (endpoint === prefix + '/git/refs') {
      assert(typeof options?.body === 'string'); const body: unknown = JSON.parse(options.body);
      assert(isRecord(body) && typeof body['ref'] === 'string'); branch = body['ref'].slice('refs/heads/'.length);
      return Response.json({}, { status: 201 });
    }
    if (endpoint === '/graphql') { commits++; head = committed; entered?.(); await waiting; throw new Error('Injected lost GitHub commit response'); }
    if (endpoint === prefix + '/compare/' + base + '...' + committed) return Response.json({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, files: [{ filename: path, status: 'modified' }] });
    if (endpoint === prefix + '/pulls') return Response.json([{ number: 7 }]);
    throw new Error('Unexpected Git request: ' + endpoint);
  };
  let store = new SharedWorkspaceStore(state, {}, transport);
  const call = (endpoint: string, method = 'GET', body?: unknown, subject = 'owner') => store.fetch(new Request('https://workspace/' + endpoint, { method,
    headers: { 'X-Foundry-Subject': subject, 'X-Foundry-Git-Token': 'ephemeral-never-stored' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const files = [{ path, text: before }];
  assert.equal((await call('create', 'POST', { id: '1'.repeat(64), snapshot: { name: 'Draft', files, baseline: files, repository: { repository, revision: base, root: 'tokens' } } })).status, 200);
  assert.equal((await call('documents', 'POST', { document: 'library', name: 'Library', role: 'library', id: '2'.repeat(64), secret: '3'.repeat(64) })).status, 200);
  const original: unknown = await (await call('workspace')).json(); assert(isWorkspaceView(original));
  const edited: unknown = await (await call('workspace', 'PUT', { before: original.draft.revision, snapshot: { name: 'Draft', files: [{ path, text: reviewed }], baseline: files, repository: original.repository } })).json(); assert(isWorkspaceView(edited));
  const proposal: PullRequestProposal = { repository, revision: base, changes: [{ path, before, after: reviewed }] };
  const saving = call('proposal', 'POST', { root: 'tokens', proposal }); await committing;
  const during: unknown = await (await call('workspace')).json(); assert(isWorkspaceView(during)); assert(during.repositorySave && !during.repositorySave.result);
  const native: unknown = await (await call('resolve', 'POST', { document: 'library', proposal: { schemaVersion: 1, sourceRevision: original.draft.revision, changes: [{ path: 'other', before: 16, after: 20 }] } })).json();
  assert(isRecord(native) && native['accepted'] === true, 'Native saves continue while the Git request is pending.');
  release?.(); const lost = await saving; assert.equal(lost.status, 400);
  const pending = await readWorkspaceRecord(state.storage); assert(isRecord(pending) && isSharedWorkspace(pending['workspace'])); assert(pending['workspace'].repositorySave && !pending['workspace'].repositorySave.result);
  assert.equal(JSON.stringify(pending).includes('ephemeral-never-stored'), false);
  store = new SharedWorkspaceStore(state, {}, transport);
  assert.equal((await call('proposal', 'POST', { root: 'tokens', proposal }, 'another-account')).status, 403);
  const resumed = await call('proposal', 'POST', { root: 'tokens', proposal }); assert.equal(resumed.status, 200, await resumed.clone().text());
  const result: unknown = await resumed.json(); assert(isRecord(result) && isWorkspaceView(result['workspace']));
  const saved = result['workspace']; assert.equal(saved.repository?.revision, committed); assert.equal(saved.repository?.branch, branch);
  assert.equal(saved.baseline.files[0]?.text, reviewed); assert.equal(saved.draft.files[0]?.text, reviewed.replace(':16', ':20'));
  assert(saved.repositorySave?.result); assert.equal(commits, 1);
  const beforeRetry = calls;
  assert.equal((await call('proposal', 'POST', { root: 'tokens', proposal })).status, 200); assert.equal(calls, beforeRetry, 'A completed request replays its durable result without another Git write.');
  const stale = await call('proposal', 'POST', { root: 'tokens', proposal: { ...proposal, changes: [{ path, before, after: before.replace(':8', ':99') }] } });
  assert.equal(stale.status, 400); assert.equal(calls, beforeRetry);
});
