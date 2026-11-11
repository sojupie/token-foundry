import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64url, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { isRecord } from '../lib/json.ts';
import { worker } from '../worker/index.ts';
import { baseChanged } from '../integrations/github/contract.ts';

const origin = 'https://editor.example.test';
const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'token-editor-test';
const repository = 'org/design-system';
const repo = '/repos/' + repository;
const path = 'tokens/system.tokens.json';
const before = '{"text":{"$type":"number","$value":1}}\n';
const after = '{"text":{"$type":"number","$value":2}}\n';
const base = '1'.repeat(40);
const changedBase = '2'.repeat(40);
const headCommit = '3'.repeat(40);
const rootTree = '4'.repeat(40);
const tokenTree = '5'.repeat(40);
const config = {
  EDITOR_ORIGIN: origin, ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience,
  GIT_PROJECTS: JSON.stringify({ [repository]: 'tokens' }),
  GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
  GIT_SESSION_KEY: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
};

await test('the Worker gates access, opens pinned files and safely retries a reviewed PR', async () => {
  const keys = await generateKeyPair('RS256');
  const key = { ...await exportJWK(keys.publicKey), kid: 'test' };
  const proof = (subject: string, target = audience) => new SignJWT({})
    .setIssuer(issuer).setAudience(target).setSubject(subject).setExpirationTime('10m')
    .setProtectedHeader({ alg: 'RS256', kid: key.kid }).sign(keys.privateKey);

  let latest = base;
  let head = '';
  let headOid = '';
  let pullCreated = false;
  let simulateFailure = true;
  let advanceBaseOnCommit = true;
  let oauthExchanges = 0;
  let commits = 0;
  let pullRequests = 0;
  const fixture: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === issuer && url.pathname === '/cdn-cgi/access/certs') return Response.json({ keys: [key] });
    if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') {
      oauthExchanges++;
      assert(init?.body instanceof URLSearchParams && init.body.has('code_verifier'));
      assert.equal(init.body.get('code'), 'mock-code');
      return Response.json({ access_token: 'ghu_mock', expires_in: 28800 });
    }
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ghu_mock');
    const pathname = decodeURIComponent(url.pathname);
    const method = init?.method;
    if (method === 'GET' && pathname === repo) return Response.json({ default_branch: 'main' });
    if (method === 'GET' && pathname === repo + '/git/ref/heads/main') return Response.json({ object: { sha: latest } });
    if (method === 'GET' && pathname === repo + '/git/commits/' + latest) return Response.json({ tree: { sha: rootTree } });
    if (pathname === repo + '/git/trees/' + rootTree) return Response.json({
      truncated: false, tree: [{ path: 'tokens', type: 'tree', sha: tokenTree }, { path: '.github', type: 'tree', sha: tokenTree }],
    });
    if (pathname === repo + '/git/trees/' + tokenTree && url.searchParams.get('recursive') === '1') return Response.json({
      truncated: false, tree: [
        { path: 'system.tokens.json', type: 'blob', mode: '100644', size: before.length },
        { path: 'symlink.tokens.json', type: 'blob', mode: '120000' },
        { path: 'settings.json', type: 'blob', mode: '100644' },
      ],
    });
    if (pathname === repo + '/contents/' + path) return new Response(url.searchParams.get('ref') === headCommit ? after : before);
    if (method === 'GET' && pathname.startsWith(repo + '/git/ref/heads/token-editor/')) {
      return head && headOid ? Response.json({ object: { sha: headOid } }) : new Response(null, { status: 404 });
    }
    if (method === 'POST') {
      const text = init?.body;
      assert(typeof text === 'string');
      const body: unknown = JSON.parse(text);
      assert(isRecord(body));
      if (pathname === repo + '/git/refs') {
        assert(typeof body['ref'] === 'string' && body['ref'].startsWith('refs/heads/token-editor/'));
        assert.equal(body['sha'], base);
        head = body['ref'].slice('refs/heads/'.length);
        headOid = base;
        return Response.json({}, { status: 201 });
      }
      if (pathname === '/graphql') {
        commits++;
        const { variables } = body;
        assert(isRecord(variables) && isRecord(variables['input']));
        assert.deepEqual(variables['input']['branch'], { repositoryNameWithOwner: repository, branchName: head });
        assert.equal(variables['input']['expectedHeadOid'], base);
        assert.deepEqual(variables['input']['fileChanges'], { additions: [{ path, contents: btoa(after) }] });
        headOid = headCommit;
        if (advanceBaseOnCommit) latest = changedBase;
        return Response.json({ data: { createCommitOnBranch: { commit: { oid: headCommit } } } });
      }
      if (pathname === repo + '/pulls') {
        pullRequests++;
        assert.equal(body['head'], head);
        assert.equal(body['base'], 'main');
        if (simulateFailure) return new Response(null, { status: 503 });
        pullCreated = true;
        return Response.json({ number: 42 }, { status: 201 });
      }
    }
    if (pathname === repo + '/compare/' + base + '...' + headCommit) {
      return Response.json({ total_commits: 1, files: [{ filename: path, status: 'modified' }] });
    }
    if (method === 'GET' && pathname === repo + '/pulls') {
      assert.equal(url.searchParams.get('head'), 'org:' + head);
      return Response.json(pullCreated ? [{ number: 42 }] : []);
    }
    throw new Error('Unexpected fixture request ' + method + ' ' + url.href);
  };

  const app = worker(fixture);
  const access = await proof('editor-user');
  const other = await proof('other-user');
  const request = (suffix: string, init?: RequestInit) => app.fetch(new Request(origin + suffix, init), config);
  assert.equal((await request('/git/sign-in')).status, 403);
  assert.equal((await request('/git/sign-in', { headers: { 'Cf-Access-Jwt-Assertion': await proof('editor-user', 'other-audience') } })).status, 403);
  const start = await request('/git/sign-in', { headers: { 'Cf-Access-Jwt-Assertion': access } });
  assert.equal(start.status, 303);
  const redirect = new URL(start.headers.get('Location') ?? '');
  assert.equal(redirect.searchParams.get('code_challenge_method'), 'S256');
  const oauthCookie = start.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  const callback = '/git/callback?code=mock-code&state=' + redirect.searchParams.get('state');
  const finish = (assertion: string, suffix = callback) => request(suffix, {
    headers: { 'Cf-Access-Jwt-Assertion': assertion, Cookie: oauthCookie },
  });
  assert.equal((await finish(other)).status, 400);
  assert.equal((await finish(access, callback + 'bad')).status, 400);
  assert.equal(oauthExchanges, 0);
  const session = await finish(access);
  assert.equal(session.status, 303);
  assert.equal(oauthExchanges, 1);
  const sessionCookie = session.headers.getSetCookie().find((value) => value.startsWith('__Secure-token-git-session='));
  assert(sessionCookie?.includes('HttpOnly') && sessionCookie.includes('Secure') && !sessionCookie.includes('ghu_mock'));

  const post = (route: 'open' | 'propose', data: object, assertion = access, from = origin) => request('/git/' + route, {
    method: 'POST', headers: {
      'Cf-Access-Jwt-Assertion': assertion, Cookie: sessionCookie?.split(';')[0] ?? '', Origin: from, 'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  assert.equal((await post('open', { repository }, other)).status, 401);
  assert.equal((await post('open', { repository }, access, 'https://elsewhere.test')).status, 403);
  assert.equal((await post('open', { repository: 'other/secret' })).status, 404);
  const snapshot = await post('open', { repository });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(await snapshot.json(), { repository, revision: base, files: [{ path, text: before }] });

  const proposal = { repository, revision: base, changes: [{ path, before, after }] };
  latest = changedBase;
  const stale = await post('propose', proposal);
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    code: baseChanged, message: 'The default branch changed. Review the latest revision before opening a pull request.',
  });
  latest = base;
  assert.equal((await post('propose', { ...proposal, changes: [{ path: '.github/workflows/deploy.yml', before, after }] })).status, 400);
  assert.equal((await post('propose', { ...proposal, changes: [{ path, before: '{}', after }] })).status, 409);
  assert.equal(commits, 0);
  const duringCommit = await post('propose', proposal);
  assert.equal(duringCommit.status, 409);
  assert.deepEqual(await duringCommit.json(), {
    code: baseChanged, message: 'The default branch changed. Review the latest revision before opening a pull request.',
  });
  assert.equal(commits, 1);
  assert.equal(pullRequests, 0);
  latest = base;
  advanceBaseOnCommit = false;
  assert.equal((await post('propose', proposal)).status, 502);
  assert.equal(commits, 1);
  simulateFailure = false;
  const retried = await post('propose', proposal);
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { url: 'https://github.com/org/design-system/pull/42' });
  assert.equal((await post('propose', proposal)).status, 200);
  assert.equal(commits, 1);
  assert.equal(pullRequests, 2);
});
