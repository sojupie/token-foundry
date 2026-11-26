import { isRecord, isUnknownArray } from '../lib/json.ts';
import { isIdentity, isRepositoryPin, isWorkspaceInput, isWorkspaceView } from '../integrations/workspace/model.ts';
import { figmaCapability } from './figma-capability.ts';
import { figmaRelayOrigin } from '../integrations/figma/transport.ts';
import { digest } from './workspace.ts';
import type { WorkspaceNamespace } from './workspace.ts';
import { fail, HttpError, json, limitedText, randomSecret } from './http.ts';
import { configuredProjects } from './github.ts';

export interface WorkspaceConfig { EDITOR_ORIGIN: string; WORKSPACES?: WorkspaceNamespace; WORKSPACE_INDEX?: WorkspaceNamespace; FIGMA_CONNECTION_KEY?: string; FIGMA_PLUGIN_ORIGIN?: string; GIT_PROJECTS?: string }
export const workspaceGrantCapability = (workspace: string, grant: string, key?: string) => figmaCapability('workspace/' + workspace + '/' + grant, key);
export const workspaceInviteCapability = (workspace: string, invite: string, key?: string) => figmaCapability('invite/' + workspace + '/' + invite, key);
export type RepositoryAccess = (repository: string, root?: string) => Promise<boolean>;

async function workspaceEntries(response: Response): Promise<Record<string, unknown>[]> {
  if (!response.ok) fail(response.status, 'The workspace list is unavailable.');
  const data: unknown = await response.json();
  if (!isRecord(data) || !isUnknownArray(data['workspaces']) || !data['workspaces'].every(entry => isRecord(entry) && isIdentity(entry['id']) && typeof entry['name'] === 'string' &&
    (entry['repository'] === undefined || typeof entry['repository'] === 'string'))) fail(502, 'The workspace list is incomplete.');
  return data['workspaces'].filter(isRecord);
}

async function accessibleWorkspaces(own: Response, config: WorkspaceConfig, access: RepositoryAccess): Promise<Response> {
  const entries = await workspaceEntries(own); const registry = config.WORKSPACE_INDEX;
  if (!registry || !config.GIT_PROJECTS) return json({ workspaces: entries });
  const repositories = [...configuredProjects(config.GIT_PROJECTS).keys()];
  const results = await Promise.allSettled(repositories.map(async repository => {
    if (!await access(repository)) return { repository };
    const key = 'repository:' + repository.toLowerCase();
    const workspaces = await workspaceEntries(await registry.get(registry.idFromName(key)).fetch(new Request('https://index/', { headers: { 'X-Foundry-Subject': key } })));
    return { repository, workspaces: workspaces.filter(entry => typeof entry['repository'] === 'string' && entry['repository'].toLowerCase() === repository.toLowerCase()) };
  }));
  const allowed = new Set<string>(); const gathered = new Map<string, Record<string, unknown>>();
  let signIn = false; let partial = false;
  for (const result of results) {
    if (result.status === 'rejected') {
      if (result.reason instanceof HttpError && result.reason.status === 401) signIn = true;
      else if (!(result.reason instanceof HttpError && [403, 404].includes(result.reason.status))) partial = true;
    } else if (result.value.workspaces) {
      allowed.add(result.value.repository.toLowerCase());
      for (const entry of result.value.workspaces) gathered.set(String(entry['id']), entry);
    }
  }
  const backfills: Promise<Response>[] = [];
  for (const entry of entries) if (entry['repository'] === undefined || typeof entry['repository'] === 'string' && allowed.has(entry['repository'].toLowerCase())) {
    const previous = gathered.get(String(entry['id']));
    if (!previous || Number(entry['version'] ?? 0) > Number(previous['version'] ?? 0)) {
      gathered.set(String(entry['id']), entry);
      if (typeof entry['repository'] === 'string') {
        const key = 'repository:' + entry['repository'].toLowerCase();
        backfills.push(registry.get(registry.idFromName(key)).fetch(new Request('https://index/', { method: 'POST', headers: { 'X-Foundry-Subject': key }, body: JSON.stringify(entry) })));
      }
    }
  }
  const indexed = await Promise.allSettled(backfills);
  if (indexed.some(result => result.status === 'rejected' || !result.value.ok)) partial = true;
  return json({ workspaces: [...gathered.values()].toSorted((left, right) => Number(right['updated'] ?? 0) - Number(left['updated'] ?? 0)),
    repositoryDiscovery: signIn ? 'sign-in' : partial ? 'partial' : 'ready' });
}

export async function workspaceHeaders(store: ReturnType<WorkspaceNamespace['get']>, subject: string, access?: RepositoryAccess): Promise<Record<string, string>> {
  const headers = { 'Content-Type': 'application/json', 'X-Foundry-Subject': subject };
  const policyResponse = await store.fetch(new Request('https://workspace/access-policy', { headers }));
  if (!policyResponse.ok) fail(policyResponse.status, 'The shared workspace is unavailable. Your local draft is retained.');
  const policy: unknown = await policyResponse.json();
  if (!isRecord(policy) || typeof policy['owner'] !== 'boolean' || policy['repository'] !== undefined && !isRepositoryPin(policy['repository'])) fail(502, 'The workspace access policy is incomplete.');
  const pin = policy['repository'];
  if (pin && access) {
    if (!await access(pin.repository, pin.root)) fail(403, 'GitHub repository write access is required for this workspace.');
    return { ...headers, 'X-Foundry-Repository': pin.repository, 'X-Foundry-Repository-Root': pin.root };
  }
  if (!policy['owner']) fail(403, 'GitHub repository write access is required for this workspace.');
  return headers;
}

export async function workspaceBrowser(request: Request, config: WorkspaceConfig, subject: string, access?: RepositoryAccess): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = /^\/git\/workspaces(?:\/([a-f0-9]{64})(?:\/(name|documents|pair|invites|revoke|resolve|review|cancel-save))?)?$/u.exec(url.pathname);
  if (!match) return undefined;
  if (!config.WORKSPACES || !config.WORKSPACE_INDEX) fail(503, 'Shared workspaces are unavailable. Your local draft is retained.');
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) return json({ message: 'Route not found.' }, 404);
  if (request.method === 'DELETE' && (!match[1] || match[2])) return json({ message: 'Route not found.' }, 404);
  let body: unknown;
  if (request.method !== 'GET') {
    if (request.headers.get('Origin') !== config.EDITOR_ORIGIN) fail(403, 'Use Foundry to update the workspace.');
    if (request.method !== 'DELETE') {
      if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') fail(403, 'Use Foundry to update the workspace.');
      try { body = JSON.parse(await limitedText(request, 24 * 1024 * 1024)); }
      catch { return json({ message: 'The workspace request is invalid.' }, 400); }
    }
  }
  const index = config.WORKSPACE_INDEX.get(config.WORKSPACE_INDEX.idFromName('owner:' + await digest(subject)));
  let headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Foundry-Subject': subject };
  if (!match[1] && request.method === 'GET') {
    const repository = url.searchParams.get('repository');
    if (!repository) {
      const own = await index.fetch(new Request('https://index/', { headers }));
      return config.GIT_PROJECTS && access ? accessibleWorkspaces(own, config, access) : own;
    }
    if (!access || !await access(repository)) fail(403, 'GitHub repository write access is required to list its workspaces.');
    const key = 'repository:' + repository.toLowerCase();
    return config.WORKSPACE_INDEX.get(config.WORKSPACE_INDEX.idFromName(key)).fetch(new Request('https://index/', { headers: { 'X-Foundry-Subject': key } }));
  }
  const creating = !match[1] && request.method === 'POST';
  if (creating && (!isRecord(body) || typeof body['client'] !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/u.test(body['client']) || !isWorkspaceInput(body['snapshot']))) fail(400, 'The workspace is incomplete.');
  const id = creating && isRecord(body) ? await digest(subject + '\0' + String(body['client'])) : match[1];
  if (!id || !isIdentity(id)) return json({ message: 'Route not found.' }, 404);
  const store = config.WORKSPACES.get(config.WORKSPACES.idFromName('workspace:' + id));
  if (creating && isRecord(body) && isWorkspaceInput(body['snapshot']) && body['snapshot'].repository && access && !await access(body['snapshot'].repository.repository, body['snapshot'].repository.root)) fail(403, 'GitHub repository write access is required to share its workspace.');
  if (!creating) headers = await workspaceHeaders(store, subject, access);
  let path = creating ? 'create' : match[2] ?? 'workspace';
  let payload: unknown = creating && isRecord(body) ? { id, snapshot: body['snapshot'] } : body;
  if (path === 'invites' && request.method === 'POST') {
    if (!isRecord(body) || !['library', 'concept'].includes(String(body['role']))) fail(400, 'Choose a role for the Figma file.');
    if (config.FIGMA_PLUGIN_ORIGIN && config.FIGMA_PLUGIN_ORIGIN !== figmaRelayOrigin) fail(503, 'The Figma relay origin is invalid.');
    const inviteId = randomSecret();
    const inviteSecret = config.FIGMA_PLUGIN_ORIGIN ? await workspaceInviteCapability(id, inviteId, config.FIGMA_CONNECTION_KEY) : randomSecret();
    const invited = await store.fetch(new Request('https://workspace/invites', {
      method: 'POST', headers, body: JSON.stringify({ id: inviteId, secret: inviteSecret, role: body['role'] }),
    }));
    if (!invited.ok) return invited;
    const result: unknown = await invited.json();
    const code = (config.FIGMA_PLUGIN_ORIGIN ?? config.EDITOR_ORIGIN) + '/figma/workspaces/' + id + '/invites/' + inviteId + '#' + inviteSecret;
    return json({ ...(isRecord(result) ? result : {}), code });
  }
  let connection: string | undefined;
  const pairing = path === 'pair';
  if ((path === 'documents' || pairing) && request.method === 'POST') {
    if (!isRecord(body)) fail(400, 'Choose a Figma file.');
    if (typeof body['document'] !== 'string' || !body['document'] || typeof body['name'] !== 'string' || !body['name'].trim() || !['library', 'concept'].includes(String(body['role']))) fail(400, 'Name the Figma file and choose its role.');
    if (pairing && (!isIdentity(body['pair']) || !isIdentity(body['secret']))) fail(400, 'Open a new pairing request from the plugin.');
    path = 'documents';
    const grant = pairing ? await digest('figma-pairing\0' + id + '\0' + String(body['pair'])) : randomSecret();
    if (config.FIGMA_PLUGIN_ORIGIN && config.FIGMA_PLUGIN_ORIGIN !== figmaRelayOrigin) fail(503, 'The Figma relay origin is invalid.');
    const secret = config.FIGMA_PLUGIN_ORIGIN ? await workspaceGrantCapability(id, grant, config.FIGMA_CONNECTION_KEY) : pairing ? await digest(String(body['secret']) + '\0' + grant) : randomSecret();
    payload = { ...body, id: grant, secret };
    connection = (config.FIGMA_PLUGIN_ORIGIN ?? config.EDITOR_ORIGIN) + '/figma/workspaces/' + id + '/files/' + grant + '#' + secret;
    if (pairing) {
      // Reserve this exact target before issuing a grant. A retry, lost reply or
      // competing workspace approval must not create another connection.
      const reservation = await config.WORKSPACE_INDEX.get(config.WORKSPACE_INDEX.idFromName('figma-pairings')).fetch(new Request('https://index/pairings', {
        method: 'POST', headers, body: JSON.stringify({ id: body['pair'], secret: body['secret'], connection, binding: await digest(JSON.stringify([body['document'], body['role']])), reserve: true }),
      }));
      if (!reservation.ok) return reservation;
      const reserved: unknown = await reservation.json();
      if (isRecord(reserved) && reserved['approved'] === true) return json({ approved: true });
    }
  }
  if (request.method === 'GET' && url.searchParams.get('summary') === '1') path += '?summary=1';
  if (request.method === 'GET' && path === 'review') path += '?document=' + encodeURIComponent(url.searchParams.get('document') ?? '') + (url.searchParams.has('replica') ? '&replica=' + encodeURIComponent(url.searchParams.get('replica') ?? '') : '');
  const response = await store.fetch(new Request('https://workspace/' + path, { method: request.method, headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }));
  if (!response.ok || request.method === 'DELETE' || request.method === 'GET' && path !== 'workspace') return response;
  const data: unknown = await response.json();
  if (request.method === 'GET' && isWorkspaceView(data) && data.repository) {
    const key = 'repository:' + data.repository.repository.toLowerCase();
    await config.WORKSPACE_INDEX.get(config.WORKSPACE_INDEX.idFromName(key)).fetch(new Request('https://index/', {
      method: 'POST', headers: { 'X-Foundry-Subject': key }, body: JSON.stringify({ id: data.id, name: data.name, repository: data.repository.repository, version: data.version, revision: data.draft.revision,
        ...(data.repository.branch ? { branch: data.repository.branch } : {}), ...(data.repository.pullRequest ? { pullRequest: data.repository.pullRequest } : {}), updated: data.activity.at(-1)?.at ?? 0 }),
    })).catch(() => undefined);
  }
  if (request.method === 'GET') return json(data);
  if (pairing && connection && isRecord(body)) {
    const paired = await config.WORKSPACE_INDEX.get(config.WORKSPACE_INDEX.idFromName('figma-pairings')).fetch(new Request('https://index/pairings', {
      method: 'POST', headers, body: JSON.stringify({ id: body['pair'], secret: body['secret'], connection, binding: await digest(JSON.stringify([body['document'], body['role']])) }),
    }));
    if (!paired.ok) return paired;
  }
  const view = isRecord(data) && isRecord(data['workspace']) ? data['workspace'] : data;
  if (isRecord(view) && typeof view['id'] === 'string' && typeof view['name'] === 'string') {
    const entry = { id: view['id'], name: view['name'], version: view['version'], ...(isRecord(view['draft']) ? { revision: view['draft']['revision'] } : {}),
      ...(isRecord(view['repository']) ? { repository: view['repository']['repository'], branch: view['repository']['branch'], pullRequest: view['repository']['pullRequest'] } : {}), updated: Date.now() };
    // Discovery is a cache. A failed index update must not turn an already
    // committed draft into an apparent failed save or discard its acknowledgement.
    await index.fetch(new Request('https://index/', { method: 'POST', headers, body: JSON.stringify(entry) })).catch(() => undefined);
  }
  return json({ ...(isRecord(data) ? data : {}), ...(connection && !pairing ? { connection } : {}), ...(pairing ? { approved: true } : {}) });
}
