import assert from 'node:assert/strict';
import { test } from 'node:test';
import { worker } from '../worker/index.ts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { figmaRelayOrigin, parseConnection, parseInviteCode } from '../integrations/figma/transport.ts';
import { workspaceGrantCapability, workspaceInviteCapability } from '../worker/workspace-routes.ts';
import { isRecord } from '../lib/json.ts';

const origin = 'https://sevan.tokenfoundry.lindstruct.com';
const workspaceId = 'a'.repeat(64);
const grantId = 'b'.repeat(64);
const url = origin + '/figma/workspaces/' + workspaceId + '/files/' + grantId;
const settings = { EDITOR_ORIGIN: origin, ACCESS_ISSUER: 'https://team.cloudflareaccess.com', ACCESS_AUDIENCE: 'test',
  GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', GIT_SESSION_KEY: '', GIT_PROJECTS: '{}' };

await test('public plugin relay answers preflight and strips spoofed browser identity before forwarding', async () => {
  let forwarded: Request | undefined;
  const config = { ...settings, WORKSPACES: { idFromName: (name: string) => name,
    get: () => ({ fetch: (request: Request) => { forwarded = request; return Promise.resolve(Response.json({ ok: true })); } }) } };
  const handler = worker();
  const preflight = await handler.fetch(new Request(url, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Headers': 'authorization,content-type' } }), config);
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'null');
  const response = await handler.fetch(new Request(url, { method: 'POST', headers: {
    Origin: 'null', Authorization: 'Bearer ' + 'c'.repeat(64), 'X-Foundry-Subject': 'spoofed-user', 'Content-Type': 'application/json',
  }, body: '{}' }), config);
  assert.equal(response.status, 200); assert(forwarded);
  assert.equal(forwarded.headers.get('X-Foundry-Subject'), null);
  assert.equal(forwarded.headers.get('Authorization'), 'Bearer ' + 'c'.repeat(64));
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'null');
});

await test('plugin relay retains CORS and useful status codes for oversized requests and failed service calls', async () => {
  const config = { ...settings, WORKSPACES: { idFromName: (name: string) => name,
    get: () => ({ fetch: () => Promise.reject(new Error('Injected service failure')) }) } };
  const handler = worker();
  const large = await handler.fetch(new Request(url, { method: 'POST', headers: { Origin: 'null', 'Content-Length': String(2 * 1024 * 1024 + 1) }, body: '{}' }), config);
  assert.equal(large.status, 413); assert.equal(large.headers.get('Access-Control-Allow-Origin'), 'null');
  assert.match(await large.text(), /size limit/u);
  const unavailable = await handler.fetch(new Request(url, { headers: { Origin: 'null' } }), config);
  assert.equal(unavailable.status, 503); assert.equal(unavailable.headers.get('Access-Control-Allow-Origin'), 'null');
  assert.match(await unavailable.text(), /unavailable/u);
});

await test('the Access-authenticated editor creates a capability for the isolated relay without exposing browser identity', async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const publicKey = { ...await exportJWK(pair.publicKey), kid: 'figma-relay-test' };
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).setIssuer(settings.ACCESS_ISSUER).setAudience(settings.ACCESS_AUDIENCE).setSubject('designer').setExpirationTime('1h').sign(pair.privateKey);
  const handler = worker(() => Promise.resolve(Response.json({ keys: [publicKey] })));
  let subject = ''; let grant = ''; let capability = ''; let lookups = 0;
  const config = { ...settings, FIGMA_PLUGIN_ORIGIN: figmaRelayOrigin, FIGMA_CONNECTION_KEY: '1'.repeat(64),
    WORKSPACE_INDEX: { idFromName: (name: string) => name, get: () => ({ fetch: () => Promise.resolve(Response.json({ ok: true })) }) },
    WORKSPACES: {
      idFromName: (name: string) => { lookups++; return name; }, get: () => ({ fetch: async (request: Request) => {
        if (new URL(request.url).pathname === '/access-policy') return Response.json({ owner: true });
        subject = request.headers.get('X-Foundry-Subject') ?? ''; const body: unknown = await request.json();
        assert(isRecord(body) && typeof body['id'] === 'string' && typeof body['secret'] === 'string');
        grant = body['id']; capability = body['secret'];
        return Response.json({ ok: true });
      } }),
    } };
  const request = () => new Request(origin + '/git/workspaces/' + workspaceId + '/documents', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': token },
    body: JSON.stringify({ document: 'doc-1', name: 'Design', role: 'library' }),
  });
  const response = await handler.fetch(request(), config); assert.equal(response.status, 200);
  const data: unknown = await response.json(); assert(isRecord(data) && typeof data['connection'] === 'string');
  const connection = parseConnection(data['connection']);
  assert.equal(new URL(connection.url).origin, figmaRelayOrigin); assert.equal(subject, 'designer');
  assert.equal(connection.secret, await workspaceGrantCapability(workspaceId, grant, config.FIGMA_CONNECTION_KEY)); assert.equal(connection.secret, capability);
  const invalid = await handler.fetch(request(), { ...config, FIGMA_PLUGIN_ORIGIN: 'https://attacker.example' });
  assert.equal(invalid.status, 503); assert.equal(lookups, 2);
});

await test('manual pairing invites are created by Foundry, redeemed once by the plugin, and reject reuse or wrong secrets', async () => {
  const { SharedWorkspaceStore } = await import('../worker/workspace.ts');
  const pair = await generateKeyPair('RS256', { extractable: true });
  const publicKey = { ...await exportJWK(pair.publicKey), kid: 'figma-invite-test' };
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: publicKey.kid }).setIssuer(settings.ACCESS_ISSUER).setAudience(settings.ACCESS_AUDIENCE).setSubject('designer').setExpirationTime('1h').sign(pair.privateKey);
  const storageMap = new Map<string, unknown>();
  const store = new SharedWorkspaceStore({
    storage: { get: key => Promise.resolve(structuredClone(storageMap.get(key))), put: (key, val) => { storageMap.set(key, structuredClone(val)); return Promise.resolve(); } },
    blockConcurrencyWhile: fn => fn(),
  });
  const baseFiles = [{ path: 'tokens.json', text: JSON.stringify({ space: { $type: 'number', $value: 8 } }) }];
  assert.equal((await store.fetch(new Request('https://workspace/create', {
    method: 'POST', headers: { 'X-Foundry-Subject': 'designer' },
    body: JSON.stringify({ id: workspaceId, snapshot: { name: 'Invite test', files: baseFiles, baseline: baseFiles } }),
  }))).status, 200);
  const handler = worker(() => Promise.resolve(Response.json({ keys: [publicKey] })));
  const config = {
    ...settings,
    FIGMA_PLUGIN_ORIGIN: figmaRelayOrigin,
    FIGMA_CONNECTION_KEY: '1'.repeat(64),
    WORKSPACE_INDEX: { idFromName: (name: string) => name, get: () => ({ fetch: () => Promise.resolve(Response.json({ ok: true })) }) },
    WORKSPACES: { idFromName: () => workspaceId, get: () => store },
  };
  const created = await handler.fetch(new Request(origin + '/git/workspaces/' + workspaceId + '/invites', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': token },
    body: JSON.stringify({ role: 'concept' }),
  }), config);
  assert.equal(created.status, 200);
  const inviteData: unknown = await created.json();
  assert(isRecord(inviteData) && typeof inviteData['code'] === 'string');
  const invite = parseInviteCode(inviteData['code']);
  const inviteId = invite.url.split('/').at(-1) ?? '';
  assert.equal(invite.secret, await workspaceInviteCapability(workspaceId, inviteId, config.FIGMA_CONNECTION_KEY));
  const wrongSecret = await store.fetch(new Request('https://workspace/invite/' + inviteId, {
    method: 'POST', headers: { Authorization: 'Bearer ' + '0'.repeat(64), 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: 'doc-1', name: 'Concept', grant: grantId, secret: 'd'.repeat(64) }),
  }));
  assert.equal(wrongSecret.status, 403);
  const redeemed = await store.fetch(new Request('https://workspace/invite/' + inviteId, {
    method: 'POST', headers: { Authorization: 'Bearer ' + invite.secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: 'doc-1', name: 'Concept file', grant: grantId, secret: 'd'.repeat(64) }),
  }));
  assert.equal(redeemed.status, 200);
  const redeemedBody: unknown = await redeemed.json();
  assert(isRecord(redeemedBody) && redeemedBody['role'] === 'concept');
  const replay = await store.fetch(new Request('https://workspace/invite/' + inviteId, {
    method: 'POST', headers: { Authorization: 'Bearer ' + invite.secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: 'doc-1', name: 'Concept file', grant: 'e'.repeat(64), secret: 'f'.repeat(64) }),
  }));
  assert.equal(replay.status, 410);
});
