import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHub } from '../worker/github.ts';
import { HttpError } from '../worker/http.ts';
import { isRecord } from '../lib/json.ts';

await test('save recovery rejects divergent or additional commits even when the compared file names match', async () => {
  const repository = 'org/tokens'; const revision = '1'.repeat(40); const committed = '2'.repeat(40); const branch = 'token-editor/' + 'A'.repeat(43);
  await Promise.all([{ status: 'diverged', ahead_by: 1, behind_by: 1, total_commits: 1 }, { status: 'ahead', ahead_by: 1, behind_by: 1, total_commits: 1 }, { status: 'ahead', ahead_by: 2, behind_by: 0, total_commits: 2 }].map(async comparison => {
    const transport: typeof fetch = input => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (decodeURIComponent(url.pathname).endsWith('/git/ref/heads/' + branch)) return Promise.resolve(Response.json({ object: { sha: committed } }));
      if (url.pathname.endsWith('/compare/' + revision + '...' + committed)) return Promise.resolve(Response.json({ ...comparison, files: [{ filename: 'tokens/base.tokens.json', status: 'modified' }] }));
      throw new Error('Unverified history must not reach another Git operation.');
    };
    await assert.rejects(new GitHub(repository, 'fixture', transport).recoverProposal({ repository, revision, branch, changes: [{ path: 'tokens/base.tokens.json', before: 'before', after: 'after' }] }), (error: unknown) => error instanceof HttpError && error.status === 409);
  }));
});

await test('subsequent edits stay on the same proposal and use the submitted commit as their baseline', async () => {
  const repository = 'org/tokens';
  const initial = '1'.repeat(40);
  const committed = '2'.repeat(40);
  const nextCommit = '3'.repeat(40);
  const tree = '4'.repeat(40);
  const root = '5'.repeat(40);
  const path = 'tokens/base.tokens.json';
  const before = '{"space":{"$type":"number","$value":8}}\n';
  const first = before.replace(':8', ':12');
  const second = before.replace(':8', ':16');
  let head = '';
  let headOid = initial;
  let current = before;
  let opened = false;
  let closed = false;
  let commits = 0;
  let pulls = 0;
  const transport: typeof fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const endpoint = decodeURIComponent(url.pathname);
    const prefix = '/repos/' + repository;
    if (endpoint === prefix) return Response.json({ default_branch: 'main' });
    if (endpoint === prefix + '/git/ref/heads/main') return Response.json({ object: { sha: initial } });
    if (endpoint.startsWith(prefix + '/git/ref/heads/token-editor/')) return head ? Response.json({ object: { sha: headOid } }) : new Response(null, { status: 404 });
    if (endpoint.startsWith(prefix + '/git/commits/')) return Response.json({ tree: { sha: root } });
    if (endpoint === prefix + '/git/trees/' + root) return Response.json({ truncated: false, tree: [{ path: 'tokens', type: 'tree', sha: tree }] });
    if (endpoint === prefix + '/git/trees/' + tree) return Response.json({ truncated: false, tree: [{ path: 'base.tokens.json', type: 'blob', mode: '100644', size: current.length }] });
    if (endpoint === prefix + '/contents/' + path) return new Response(url.searchParams.get('ref') === initial ? before : current);
    if (endpoint === prefix + '/git/refs') {
      assert(typeof options?.body === 'string');
      const body: unknown = JSON.parse(options.body);
      assert(isRecord(body) && typeof body['ref'] === 'string');
      head = body['ref'].slice('refs/heads/'.length);
      return Response.json({}, { status: 201 });
    }
    if (endpoint === '/graphql') {
      assert(typeof options?.body === 'string');
      const body: unknown = JSON.parse(options.body);
      assert(isRecord(body) && isRecord(body['variables']) && isRecord(body['variables']['input']));
      const operation = body['variables']['input'];
      assert.equal(operation['expectedHeadOid'], headOid);
      assert.deepEqual(operation['branch'], { repositoryNameWithOwner: repository, branchName: head });
      commits++;
      current = commits === 1 ? first : second;
      headOid = commits === 1 ? committed : nextCommit;
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: headOid } } } });
    }
    if (endpoint === prefix + '/pulls') {
      if (options?.method === 'POST') { opened = true; pulls++; return Response.json({ number: 7 }, { status: 201 }); }
      return Response.json(opened && !closed ? [{ number: 7 }] : []);
    }
    throw new Error('Unexpected request: ' + endpoint);
  };
  const client = new GitHub(repository, 'fixture', transport);
  const created = await client.propose('tokens', { repository, revision: initial, changes: [{ path, before, after: first }] });
  assert.equal(created.revision, committed);
  assert.equal(created.branch, head);
  const snapshot = await client.open(repository, 'tokens', head);
  assert.equal(snapshot.revision, committed);
  assert.equal(snapshot.files[0]?.text, first);
  const updated = await client.propose('tokens', { repository, branch: head, revision: committed, changes: [{ path, before: first, after: second }] });
  assert.equal(updated.url, created.url);
  assert.equal(updated.branch, head);
  assert.equal(updated.revision, nextCommit);
  assert.equal(pulls, 1);
  assert.equal(commits, 2);
  await assert.rejects(() => client.propose('tokens', { repository, branch: head, revision: committed, changes: [{ path, before: first, after: second }] }), (error: unknown) => error instanceof HttpError && error.status === 409);
  closed = true;
  await assert.rejects(() => client.open(repository, 'tokens', head), /merged or closed/u);
  await assert.rejects(() => client.open(repository, 'tokens', 'main'), /proposal created in Foundry/u);
});
