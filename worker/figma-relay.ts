import { figmaCapability, verifyFigmaCapability } from './figma-capability.ts';
import { HttpError, json, limitedText, randomSecret } from './http.ts';
import { isRecord } from '../lib/json.ts';
import type { WorkspaceNamespace } from './workspace.ts';

export function pluginCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  // Figma's sandbox uses an opaque origin. Authorization is the scoped secret, never browser cookies.
  if (origin === 'null' || origin === 'https://www.figma.com' || origin === 'https://www.figma.com:443') {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Vary', 'Origin');
  }
  return new Response(response.body, { status: response.status, headers });
}

export async function pairingPoll(request: Request, index: WorkspaceNamespace | undefined, id: string): Promise<Response> {
  if (request.method === 'OPTIONS') return pluginCors(new Response(null, { status: 204 }), request.headers.get('Origin'));
  if (request.method !== 'GET' || !index) return pluginCors(json({ message: 'Pairing is unavailable.' }, 503), request.headers.get('Origin'));
  const response = await index.get(index.idFromName('figma-pairings')).fetch(new Request('https://index/pairings?id=' + id, { headers: { Authorization: request.headers.get('Authorization') ?? '' } }));
  return pluginCors(response, request.headers.get('Origin'));
}

export async function workspacePlugin(request: Request, workspaces: WorkspaceNamespace | undefined, workspace: string, grant: string): Promise<Response> {
  let response: Response;
  try {
    if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
    else if (!workspaces) response = json({ message: 'Shared workspaces are unavailable.' }, 503);
    else if (!['GET', 'POST'].includes(request.method)) response = json({ message: 'Route not found.' }, 404);
    else {
      const headers = new Headers(request.headers); headers.delete('X-Foundry-Subject');
      response = await workspaces.get(workspaces.idFromName('workspace:' + workspace)).fetch(new Request('https://workspace/file/' + grant + new URL(request.url).search, {
        method: request.method, headers, ...(request.method === 'POST' ? { body: await limitedText(request, 2 * 1024 * 1024) } : {}),
      }));
    }
  } catch (error) { response = json({ message: error instanceof HttpError ? error.message : 'Workspace sync is temporarily unavailable. Your Figma edits are retained.' }, error instanceof HttpError ? error.status : 503); }
  return pluginCors(response, request.headers.get('Origin'));
}

export async function workspaceInviteRedeem(
  request: Request,
  workspaces: WorkspaceNamespace | undefined,
  workspaceId: string,
  inviteId: string,
  origin: string,
  connectionKey?: string,
): Promise<Response> {
  let response: Response;
  try {
    if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
    else if (!workspaces) response = json({ message: 'Shared workspaces are unavailable.' }, 503);
    else if (request.method !== 'POST') response = json({ message: 'Route not found.' }, 404);
    else {
      const body: unknown = JSON.parse(await limitedText(request, 16_000));
      if (!isRecord(body) || typeof body['document'] !== 'string' || !body['document'] || typeof body['name'] !== 'string' || !body['name'].trim()) {
        response = json({ message: 'The Figma file details are incomplete.' }, 400);
      } else {
        const grant = randomSecret();
        const grantSecret = connectionKey ? await figmaCapability('workspace/' + workspaceId + '/' + grant, connectionKey) : randomSecret();
        const headers = new Headers(request.headers);
        headers.delete('X-Foundry-Subject');
        headers.set('Content-Type', 'application/json');
        const redeemed = await workspaces.get(workspaces.idFromName('workspace:' + workspaceId)).fetch(new Request('https://workspace/invite/' + inviteId, {
          method: 'POST',
          headers,
          body: JSON.stringify({ document: body['document'], name: body['name'].trim(), grant, secret: grantSecret }),
        }));
        if (!redeemed.ok) response = redeemed;
        else {
          const data: unknown = await redeemed.json();
          response = json({
            ...(isRecord(data) ? data : {}),
            connection: origin + '/figma/workspaces/' + workspaceId + '/files/' + grant + '#' + grantSecret,
          });
        }
      }
    }
  } catch (error) {
    response = json({ message: error instanceof HttpError ? error.message : error instanceof SyntaxError ? 'The pairing request is invalid.' : 'Workspace sync is temporarily unavailable.' }, error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 503);
  }
  return pluginCors(response, request.headers.get('Origin'));
}

interface RelayConfig { RELAY_ORIGIN: string; FIGMA_CONNECTION_KEY?: string; WORKSPACES?: WorkspaceNamespace; WORKSPACE_INDEX?: WorkspaceNamespace }
export default {
  async fetch(request: Request, config: RelayConfig): Promise<Response> {
    const url = new URL(request.url);
    const pair = /^\/figma\/pairing\/([a-f0-9]{64})$/u.exec(url.pathname);
    if (url.origin === config.RELAY_ORIGIN && pair?.[1]) return pairingPoll(request, config.WORKSPACE_INDEX, pair[1]);
    const workspace = /^\/figma\/workspaces\/([a-f0-9]{64})\/files\/([a-f0-9]{64})$/u.exec(url.pathname);
    const invite = /^\/figma\/workspaces\/([a-f0-9]{64})\/invites\/([a-f0-9]{64})$/u.exec(url.pathname);
    if (url.origin !== config.RELAY_ORIGIN || !workspace && !invite) return json({ message: 'Route not found.' }, 404);
    if (request.method === 'OPTIONS') return pluginCors(new Response(null, { status: 204 }), request.headers.get('Origin'));
    if (invite && request.method !== 'POST' || !invite && !['GET', 'POST'].includes(request.method)) return pluginCors(json({ message: 'Route not found.' }, 404), request.headers.get('Origin'));
    try {
      // Reject invalid capabilities before looking up a Durable Object. Random
      // public requests must not instantiate arbitrary workspace objects.
      if (invite) {
        const workspaceId = invite[1] ?? '';
        const inviteId = invite[2] ?? '';
        if (!await verifyFigmaCapability(request, 'invite/' + workspaceId + '/' + inviteId, config.FIGMA_CONNECTION_KEY)) return pluginCors(json({ message: 'The pairing code is invalid.' }, 401), request.headers.get('Origin'));
        return await workspaceInviteRedeem(request, config.WORKSPACES, workspaceId, inviteId, config.RELAY_ORIGIN, config.FIGMA_CONNECTION_KEY);
      }
      const workspaceId = workspace?.[1] ?? '';
      const grantId = workspace?.[2] ?? '';
      if (!await verifyFigmaCapability(request, 'workspace/' + workspaceId + '/' + grantId, config.FIGMA_CONNECTION_KEY)) return pluginCors(json({ message: 'The Figma connection code is invalid.' }, 401), request.headers.get('Origin'));
      return await workspacePlugin(request, config.WORKSPACES, workspaceId, grantId);
    } catch (error) {
      return pluginCors(json({ message: error instanceof HttpError ? error.message : 'Figma sync is temporarily unavailable.' }, error instanceof HttpError ? error.status : 503), request.headers.get('Origin'));
    }
  },
};
