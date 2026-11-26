import assert from 'node:assert/strict';
import { test } from 'node:test';
import relay from '../worker/figma-relay.ts';
import { figmaCapability } from '../worker/figma-capability.ts';
import { figmaRelayOrigin, parseConnection, parseInviteCode } from '../integrations/figma/transport.ts';

const workspaceId = 'a'.repeat(64);
const grantId = 'b'.repeat(64);
const inviteId = 'd'.repeat(64);
const secret = '1'.repeat(64);
const url = figmaRelayOrigin + '/figma/workspaces/' + workspaceId + '/files/' + grantId;
const inviteUrl = figmaRelayOrigin + '/figma/workspaces/' + workspaceId + '/invites/' + inviteId;
const config = { RELAY_ORIGIN: figmaRelayOrigin, FIGMA_CONNECTION_KEY: secret };

await test('the isolated relay authenticates its capability before any workspace lookup and strips private identity headers', async () => {
  let lookups = 0; let forwarded: Request | undefined;
  const settings = { ...config, WORKSPACES: { idFromName: (name: string) => { lookups++; assert.equal(name, 'workspace:' + workspaceId); return name; },
    get: () => ({ fetch: (request: Request) => { forwarded = request; return Promise.resolve(Response.json({ ok: true })); } }) } };
  const preflight = await relay.fetch(new Request(url, { method: 'OPTIONS', headers: { Origin: 'null' } }), settings);
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'null'); assert.equal(lookups, 0);
  const denied = await relay.fetch(new Request(url, { headers: { Origin: 'null', Authorization: 'Bearer ' + '0'.repeat(64), 'X-Foundry-Subject': 'spoofed-owner' } }), settings);
  assert.equal(denied.status, 401); assert.equal(lookups, 0); assert.equal(denied.headers.get('Access-Control-Allow-Origin'), 'null');
  const valid = await figmaCapability('workspace/' + workspaceId + '/' + grantId, secret);
  const accepted = await relay.fetch(new Request(url, { method: 'POST', headers: { Origin: 'null', Authorization: 'Bearer ' + valid, 'X-Foundry-Subject': 'spoofed-owner' }, body: '{}' }), settings);
  assert.equal(accepted.status, 200); assert.equal(lookups, 1); assert(forwarded);
  assert.equal(forwarded.headers.get('X-Foundry-Subject'), null); assert.equal(forwarded.headers.get('Authorization'), 'Bearer ' + valid);
  assert.equal(new URL(forwarded.url).pathname, '/file/' + grantId);
  assert.notEqual(await figmaCapability('workspace/' + 'c'.repeat(64) + '/' + grantId, secret), valid);
  assert.notEqual(await figmaCapability('workspace/' + workspaceId + '/' + grantId, '2'.repeat(64)), valid);
});

await test('the isolated relay rejects foreign hosts, removed legacy routes, private browser routes and mutation methods', async () => {
  const valid = await figmaCapability('workspace/' + workspaceId + '/' + grantId, secret);
  const headers = { Origin: 'null', Authorization: 'Bearer ' + valid };
  assert.equal((await relay.fetch(new Request('https://other.example/figma/workspaces/' + workspaceId + '/files/' + grantId, { headers }), config)).status, 404);
  assert.equal((await relay.fetch(new Request(figmaRelayOrigin + '/figma/sync/' + workspaceId, { headers }), config)).status, 404);
  assert.equal((await relay.fetch(new Request(figmaRelayOrigin + '/git/workspaces', { headers }), config)).status, 404);
  await Promise.all(['PUT', 'DELETE'].map(async method => {
    const denied = await relay.fetch(new Request(url, { method, headers }), config);
    assert.equal(denied.status, 404); assert.equal(denied.headers.get('Access-Control-Allow-Origin'), 'null');
  }));
  assert.equal(parseConnection(url + '#' + valid).url, url);
  assert.throws(() => parseConnection(figmaRelayOrigin + '/figma/sync/' + workspaceId + '#' + valid));
  assert.throws(() => parseConnection(url.replace('.workers.dev', '.workers.dev.attacker.example') + '#' + valid));
});

await test('the isolated relay retains CORS and failure status for missing configuration, large bodies and service failures', async () => {
  const missing = await relay.fetch(new Request(url, { headers: { Origin: 'null' } }), { RELAY_ORIGIN: figmaRelayOrigin });
  assert.equal(missing.status, 503); assert.equal(missing.headers.get('Access-Control-Allow-Origin'), 'null');
  const authorization = 'Bearer ' + await figmaCapability('workspace/' + workspaceId + '/' + grantId, secret);
  const settings = { ...config, WORKSPACES: { idFromName: (name: string) => name,
    get: () => ({ fetch: () => Promise.reject(new Error('Injected remote object failure')) }) } };
  const large = await relay.fetch(new Request(url, { method: 'POST', headers: { Origin: 'null', Authorization: authorization, 'Content-Length': String(2 * 1024 * 1024 + 1) }, body: '{}' }), settings);
  assert.equal(large.status, 413); assert.equal(large.headers.get('Access-Control-Allow-Origin'), 'null');
  const failed = await relay.fetch(new Request(url, { headers: { Origin: 'null', Authorization: authorization } }), settings);
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('Access-Control-Allow-Origin'), 'null');
});

await test('the isolated relay verifies invite capabilities before redeeming a one-time pairing code', async () => {
  let lookups = 0; let forwarded: Request | undefined;
  const settings = { ...config, WORKSPACES: { idFromName: (name: string) => { lookups++; assert.equal(name, 'workspace:' + workspaceId); return name; },
    get: () => ({ fetch: (request: Request) => { forwarded = request; return Promise.resolve(Response.json({ expires: Date.now() + 60_000, role: 'library' })); } }) } };
  const denied = await relay.fetch(new Request(inviteUrl, { method: 'POST', headers: { Origin: 'null', Authorization: 'Bearer ' + '0'.repeat(64), 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: 'doc-1', name: 'Library file' }) }), settings);
  assert.equal(denied.status, 401); assert.equal(lookups, 0); assert.equal(denied.headers.get('Access-Control-Allow-Origin'), 'null');
  const inviteSecret = await figmaCapability('invite/' + workspaceId + '/' + inviteId, secret);
  const accepted = await relay.fetch(new Request(inviteUrl, { method: 'POST', headers: { Origin: 'null', Authorization: 'Bearer ' + inviteSecret, 'X-Foundry-Subject': 'spoofed', 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: 'doc-1', name: 'Library file' }) }), settings);
  assert.equal(accepted.status, 200); assert.equal(lookups, 1); assert(forwarded);
  assert.equal(forwarded.headers.get('X-Foundry-Subject'), null);
  assert.equal(new URL(forwarded.url).pathname, '/invite/' + inviteId);
  const payload: unknown = await accepted.json();
  assert(typeof payload === 'object' && payload !== null && 'connection' in payload && typeof payload.connection === 'string');
  const parsed = parseConnection(payload.connection);
  assert.equal(new URL(parsed.url).origin, figmaRelayOrigin);
  assert.equal(parseInviteCode(inviteUrl + '#' + inviteSecret).secret, inviteSecret);
  assert.throws(() => parseInviteCode(url + '#' + inviteSecret));
});
