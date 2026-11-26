import { isRecord, isUnknownArray } from '../lib/json.ts';
import { isPullChoice } from '../integrations/figma/merge.ts';
import { isTokenProposal } from '../integrations/figma/contract.ts';
import { acknowledgeSource, createWorkspace, disconnectDocument, inspectIncoming, isIdentity, isSharedWorkspace, isWorkspaceInput, offerWorkspace, pairDocument, receiveChanges, renameWorkspace, saveReviewDrafts, saveWorkspace, workspaceView } from '../integrations/workspace/model.ts';
import { isConflictDraft } from '../integrations/figma/recovery.ts';
import { SourceSnapshotUnavailable } from '../integrations/workspace/model.ts';
import { beginRepositorySave, cancelRepositorySave, finishRepositorySave, startRepositorySave } from '../integrations/workspace/model.ts';
import { pruneReplicas, registerReplica, resumeReplica } from '../integrations/workspace/model.ts';
import { baseChanged, isProposal, proposalUnavailable } from '../integrations/github/contract.ts';
import { GitHub } from './github.ts';
import type { RepositorySaveResult, SharedWorkspace } from '../integrations/workspace/model.ts';
import { RepositoryConflicts } from '../lib/repository-merge.ts';
import { WorkspaceMergeInvalid } from '../integrations/workspace/merge.ts';
import { fail, HttpError, json, limitedText } from './http.ts';

export interface WorkspaceStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete?(key: string): Promise<boolean>;
  deleteAll?(): Promise<void>;
}
interface State { storage: WorkspaceStorage; blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> }
export interface WorkspaceNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }
interface Grant { id: string; document: string; hash: string; expires: number; created?: number }
interface WorkspaceInvite { id: string; hash: string; role: 'library' | 'concept'; expires: number }
interface Record { owner: string; workspace: SharedWorkspace; grants: Grant[]; invites?: WorkspaceInvite[] }
function authorized(record: Record, subject: string | null, headers: Headers) {
  const pin = record.workspace.repository;
  return !!subject && (subject === record.owner || !!pin && headers.get('X-Foundry-Repository') === pin.repository && headers.get('X-Foundry-Repository-Root') === pin.root);
}
function privateView(record: Record) {
  const view = workspaceView(record.workspace);
  for (const file of view.documents) {
    const grants = record.grants.filter(item => item.document === file.id && item.expires > Date.now());
    file.connections = grants.map(grant => {
      const cursor = record.workspace.replicas?.find(item => item.id === grant.id);
      return { id: grant.id, expires: grant.expires, ...(grant.created !== undefined ? { created: grant.created } : {}), baseline: cursor?.baseline ?? file.baseline, offered: cursor?.offered ?? file.offered, acknowledged: cursor?.acknowledged === true };
    });
    if (grants.length) file.expires = Math.max(...grants.map(grant => grant.expires));
  }
  return view;
}
const isStored = (value: unknown): value is Record => isRecord(value) && typeof value['owner'] === 'string' && isSharedWorkspace(value['workspace']) &&
  isUnknownArray(value['grants']) && value['grants'].every(grant => isRecord(grant) && isIdentity(grant['id']) && typeof grant['document'] === 'string' && isIdentity(grant['hash']) && typeof grant['expires'] === 'number' &&
    (grant['created'] === undefined || typeof grant['created'] === 'number')) &&
  (value['invites'] === undefined || isUnknownArray(value['invites']) && value['invites'].every(invite => isRecord(invite) && isIdentity(invite['id']) && isIdentity(invite['hash']) && ['library', 'concept'].includes(String(invite['role'])) && typeof invite['expires'] === 'number'));
function reviewReplica(state: SharedWorkspace, document: string, requested: unknown): string | undefined {
  if (requested !== undefined && requested !== null) {
    if (!isIdentity(requested) || !state.replicas?.some(item => item.id === requested && item.document === document)) fail(400, 'Choose a connection belonging to this Figma file.');
    return requested;
  }
  const pending = state.incoming.filter(item => item.document === document);
  if (pending.length === 1) return pending[0]?.replica;
  const replicas = state.replicas?.filter(item => item.document === document) ?? [];
  if (!pending.length && replicas.length === 1) return replicas[0]?.id;
  if (pending.length > 1 || replicas.length > 1) fail(409, 'Choose the connection whose changes you want to review.');
  return undefined;
}
export const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Two alternating generations: every chunk and count precedes the active pointer. */
export async function readWorkspaceRecord(storage: WorkspaceStorage): Promise<unknown> {
  const head = await storage.get('workspace-head');
  if (head === undefined || head === null) return undefined;
  if (head !== 0 && head !== 1) fail(503, 'The workspace record is damaged. Your local draft is retained.');
  const count = await storage.get('workspace:' + head + ':count');
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 4096) fail(503, 'The workspace source is incomplete. Your local draft is retained.');
  const parts = await Promise.all(Array.from({ length: count }, (_, index) => storage.get('workspace:' + head + ':' + index)));
  if (!parts.every((part): part is string => typeof part === 'string')) fail(503, 'The workspace source is incomplete. Your local draft is retained.');
  return JSON.parse(parts.join(''));
}
export async function writeWorkspaceRecord(storage: WorkspaceStorage, value: unknown): Promise<void> {
  const head = await storage.get('workspace-head');
  if (head !== undefined && head !== null && head !== 0 && head !== 1) fail(503, 'The workspace record is damaged.');
  const bank = head === 0 ? 1 : 0;
  const text = JSON.stringify(value); const count = Math.ceil(text.length / 32_000);
  if (text.length > 16 * 1024 * 1024) fail(413, 'The shared workspace exceeds its configured 16 MB record limit. Your local draft is retained.');
  await Promise.all(Array.from({ length: count }, (_, index) => storage.put('workspace:' + bank + ':' + index, text.slice(index * 32_000, (index + 1) * 32_000))));
  await storage.put('workspace:' + bank + ':count', count);
  await storage.put('workspace-head', bank);
}
export async function deleteWorkspaceRecord(storage: WorkspaceStorage): Promise<void> {
  if (storage.deleteAll) { await storage.deleteAll(); return; }
  if (!storage.delete) { await storage.put('workspace-head', null); return; }
  const deleteKey = storage.delete.bind(storage);
  const counts = await Promise.all([0, 1].map(bank => storage.get('workspace:' + bank + ':count')));
  const keys = ['workspace-head'];
  for (const [bank, count] of counts.entries()) {
    keys.push('workspace:' + bank + ':count');
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 1 && count <= 4096) {
      for (let index = 0; index < count; index++) keys.push('workspace:' + bank + ':' + index);
    }
  }
  await Promise.all(keys.map(key => deleteKey(key)));
}
export function workspaceSummary(state: SharedWorkspace) {
  return { id: state.id, name: state.name, version: state.version, revision: state.draft, dirty: state.draft !== state.baseline, ...(state.repository ? { repository: state.repository.repository } : {}),
    ...(state.repository?.branch ? { branch: state.repository.branch } : {}), ...(state.repository?.pullRequest ? { pullRequest: state.repository.pullRequest } : {}),
    documents: state.documents.length, incoming: state.incoming.length, updated: state.activity.at(-1)?.at ?? 0 };
}
export class SharedWorkspaceStore {
  readonly state: State;
  readonly index: WorkspaceNamespace | undefined;
  readonly transport: typeof fetch;
  readonly saving = new Map<string, Promise<RepositorySaveResult>>();
  constructor(state: State, config: { WORKSPACE_INDEX?: WorkspaceNamespace } = {}, transport: typeof fetch = (input, init) => fetch(input, init)) { this.state = state; this.index = config.WORKSPACE_INDEX; this.transport = transport; }
  async #ready(record: Record): Promise<Record> {
    let next = record.workspace;
    const active = record.grants.filter(grant => grant.expires > Date.now());
    for (const grant of active) next = registerReplica(next, grant.document, grant.id, true);
    next = pruneReplicas(next, new Set(active.map(grant => grant.id)));
    if (next === record.workspace) return record;
    const migrated = { ...record, workspace: next }; await this.#commit(migrated); return migrated;
  }
  async #commit(record: Record) {
    await writeWorkspaceRecord(this.state.storage, record);
    const index = this.index;
    if (!index) return;
    // Discovery follows native changes too. Failure cannot undo a committed
    // source draft or make an accepted save appear to have failed.
    await index.get(index.idFromName('owner:' + await digest(record.owner))).fetch(new Request('https://index/', {
      method: 'POST', headers: { 'X-Foundry-Subject': record.owner }, body: JSON.stringify(workspaceSummary(record.workspace)),
    })).catch(() => undefined);
    const repository = record.workspace.repository?.repository;
    if (repository) await index.get(index.idFromName('repository:' + repository.toLowerCase())).fetch(new Request('https://index/', {
      method: 'POST', headers: { 'X-Foundry-Subject': 'repository:' + repository.toLowerCase() }, body: JSON.stringify(workspaceSummary(record.workspace)),
    })).catch(() => undefined);
  }
  async #locked<T>(action: () => Promise<T>): Promise<T> {
    // An expected HTTP error must not reject blockConcurrencyWhile: the
    // Durable Object runtime resets the object when that callback rejects.
    const result = await this.state.blockConcurrencyWhile(async () => {
      try { return { ok: true, value: await action() } as const; }
      catch (error) { return { ok: false, error } as const; }
    });
    if (!result.ok) throw result.error;
    return result.value;
  }
  async fetch(request: Request): Promise<Response> {
      try { return new URL(request.url).pathname === '/proposal' ? await this.#proposal(request) : await this.#locked(() => this.#handle(request)); }
      catch (error) {
        if (error instanceof HttpError) return json({ message: error.message, code: error.code }, error.status);
        if (error instanceof SourceSnapshotUnavailable) return json({ message: error.message, code: 'source-baseline-unavailable' }, 409);
        if (error instanceof RepositoryConflicts) return json({ message: 'The same definitions changed in another client. Review them before saving.', conflicts: error.conflicts }, 409);
        if (error instanceof WorkspaceMergeInvalid) return json({ message: error.message }, 422);
        return json({ message: error instanceof Error ? error.message : 'The workspace operation failed. Your local draft is retained.' }, 400);
      }
  }
  async #proposal(request: Request): Promise<Response> {
    if (request.method !== 'POST') fail(404, 'Route not found.');
    const subject = request.headers.get('X-Foundry-Subject'); const token = request.headers.get('X-Foundry-Git-Token');
    const body: unknown = JSON.parse(await limitedText(request, 24 * 1024 * 1024));
    if (!token || !isRecord(body) || typeof body['root'] !== 'string' || !isProposal(body['proposal'])) fail(400, 'The reviewed repository save is incomplete.');
    const root = body['root']; const proposal = body['proposal'];
    const prepared = await this.#locked(async () => {
      const record = await readWorkspaceRecord(this.state.storage);
      if (!isStored(record)) fail(404, 'The shared workspace is unavailable.');
      if (!authorized(record, subject, request.headers)) fail(403, 'GitHub repository write access is required for this workspace.');
      const next = await beginRepositorySave(record.workspace, proposal, root);
      if (next !== record.workspace) await this.#commit({ ...record, workspace: next });
      return { ...record, workspace: next };
    });
    const operation = prepared.workspace.repositorySave;
    if (!operation) fail(500, 'The reviewed repository save was not recorded.');
    if (operation.result) return json({ ...operation.result, workspace: privateView(prepared) });
    let running = this.saving.get(operation.id);
    if (!running) {
      running = (async () => {
        // Git requests run outside the storage lock. Other clients keep saving
        // their newer draft; completion advances only the reviewed checkpoint.
        const github = new GitHub(operation.request.repository, token, this.transport);
        const result = await github.recoverProposal(operation.request) ?? await github.propose(operation.root, operation.request, async () => {
          await this.#locked(async () => {
            const current = await readWorkspaceRecord(this.state.storage);
            if (!isStored(current)) fail(503, 'The reviewed repository save is unavailable.');
            await this.#commit({ ...current, workspace: startRepositorySave(current.workspace, operation.id) });
          });
        });
        await this.#locked(async () => {
          const current = await readWorkspaceRecord(this.state.storage);
          if (!isStored(current)) fail(503, 'The repository result is ready for retry. The workspace record is unavailable.');
          await this.#commit({ ...current, workspace: finishRepositorySave(current.workspace, operation.id, result) });
        });
        return result;
      })().catch(async (error: unknown) => {
        if (error instanceof HttpError && [baseChanged, proposalUnavailable].includes(error.code ?? '')) {
          await this.#locked(async () => {
            const current = await readWorkspaceRecord(this.state.storage);
            if (!isStored(current)) fail(503, 'The reviewed repository save is unavailable.');
            const saved = current.workspace.repositorySave;
            if (saved?.id !== operation.id || saved.result) return;
            if (saved.started) fail(409, 'A repository write may have started. Resume the reviewed save to verify its result before reviewing a newer checkpoint.');
            // The callback preceding the first Git mutation never ran. Release
            // only this rejected review so the retained draft can be rebased.
            await this.#commit({ ...current, workspace: cancelRepositorySave(current.workspace, operation.id) });
          });
        }
        throw error;
      }).finally(() => { this.saving.delete(operation.id); });
      this.saving.set(operation.id, running);
    }
    const result = await running;
    return this.#locked(async () => {
      const current = await readWorkspaceRecord(this.state.storage);
      if (!isStored(current)) fail(503, 'The saved repository checkpoint is ready for retry.');
      return json({ ...result, workspace: privateView(current) });
    });
  }
  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url); const subject = request.headers.get('X-Foundry-Subject');
    const stored = await readWorkspaceRecord(this.state.storage);
    let record = isStored(stored) ? stored : undefined;
    if (stored !== undefined && !record) fail(503, 'The stored workspace is invalid. Your local draft is retained.');
    const body: unknown = ['POST', 'PUT'].includes(request.method) ? JSON.parse(await limitedText(request, 24 * 1024 * 1024)) : undefined;
    if (url.pathname === '/create' && request.method === 'POST') {
      if (!subject || !isRecord(body) || !isIdentity(body['id']) || !isWorkspaceInput(body['snapshot'])) fail(400, 'The workspace is incomplete.');
      if (record && record.owner !== subject) fail(403, 'This workspace belongs to another account.');
      if (!record) { record = { owner: subject, workspace: await createWorkspace(body['id'], body['snapshot']), grants: [] }; await this.#commit(record); }
      return json(privateView(record));
    }
    if (!record) fail(404, 'The workspace is unavailable. Your local draft is retained.');
    if (url.pathname === '/access-policy' && request.method === 'GET') {
      if (!subject) fail(403, 'Sign in to open this workspace.');
      // This metadata is available only through a private Worker binding. The
      // browser Worker verifies GitHub rights before returning workspace data.
      return json({ owner: subject === record.owner, ...(record.workspace.repository ? { repository: record.workspace.repository } : {}) });
    }
    const grantPath = /^\/file\/([a-f0-9]{64})$/u.exec(url.pathname);
    let document: string | undefined;
    let replica: string | undefined;
    if (grantPath?.[1]) {
      const grant = record.grants.find(item => item.id === grantPath[1]);
      if (!grant || grant.expires <= Date.now()) fail(410, 'The Figma connection expired or was revoked. The workspace draft is retained.');
      const secret = request.headers.get('Authorization')?.replace(/^Bearer /u, '') ?? '';
      if (!isIdentity(secret) || await digest(secret) !== grant.hash) fail(403, 'The Figma connection code is invalid.');
      document = grant.document;
      replica = grant.id;
      record = await this.#ready(record);
      const resuming = request.method === 'POST' && isRecord(body) && body['action'] === 'resume';
      if (resuming && record.workspace.documents.find(file => file.id === document)?.role === 'library') {
        if (!isRecord(body) || typeof body['revision'] !== 'string') fail(400, 'The saved native source revision is missing.');
        const next = resumeReplica(record.workspace, document, replica, body['revision'], typeof body['acknowledgedReceipt'] === 'string' ? body['acknowledgedReceipt'] : undefined);
        if (next !== record.workspace) { record = { ...record, workspace: next }; await this.#commit(record); }
      }
      if (request.method === 'GET' || resuming) {
        if (url.searchParams.get('since') === record.workspace.draft && !record.workspace.incoming.some(item => item.document === document && item.replica === replica)) {
          const cursor = record.workspace.replicas?.find(item => item.id === replica);
          if (!cursor?.receipt || cursor.receipt.id === url.searchParams.get('receipt')) return json({ unchanged: true, workspace: { ...workspaceSummary(record.workspace), document, role: record.workspace.documents.find(file => file.id === document)?.role } });
        }
        const offered = await offerWorkspace(record.workspace, document, replica);
        const pending = record.workspace.incoming.some(item => item.document === document && item.replica === replica) ? await inspectIncoming(record.workspace, document, replica) : undefined;
        if (offered.state !== record.workspace) await this.#commit({ ...record, workspace: offered.state });
        return json({ ...offered.bundle, ...(pending ? { pending } : {}), ...(offered.acknowledgement ? { acknowledgement: offered.acknowledgement } : {}), expires: grant.expires,
          workspace: { ...workspaceSummary(offered.state), document, role: offered.state.documents.find(file => file.id === document)?.role } });
      }
      if (request.method !== 'POST') fail(404, 'Route not found.');
      if (isRecord(body) && body['action'] === 'acknowledge' && typeof body['revision'] === 'string') {
        const next = acknowledgeSource(record.workspace, document, body['revision'], replica);
        if (next !== record.workspace) await this.#commit({ ...record, workspace: next });
        return json({ saved: true, revision: next.draft });
      }
    } else if (/^\/invite\/([a-f0-9]{64})$/u.test(url.pathname)) {
      if (request.method !== 'POST') fail(404, 'Route not found.');
      const inviteId = /^\/invite\/([a-f0-9]{64})$/u.exec(url.pathname)?.[1] ?? '';
      const now = Date.now();
      const invite = (record.invites ?? []).find(item => item.id === inviteId && item.expires > now);
      if (!invite) fail(410, 'This pairing code expired or was already used. Create a new code in Foundry.');
      const secret = request.headers.get('Authorization')?.replace(/^Bearer /u, '') ?? '';
      if (!isIdentity(secret) || await digest(secret) !== invite.hash) fail(403, 'The pairing code is invalid.');
      if (!isRecord(body) || typeof body['document'] !== 'string' || !body['document'] || body['document'].length > 200 ||
        typeof body['name'] !== 'string' || !body['name'].trim() || body['name'].trim().length > 200 ||
        !isIdentity(body['grant']) || !isIdentity(body['secret'])) fail(400, 'The Figma file connection is incomplete.');
      const active = record.grants.filter(item => item.expires > now);
      if (active.length >= 64) fail(409, 'This workspace reached its configured 64-device connection limit. Revoke an unused connection before pairing another device.');
      record = await this.#ready(record);
      const expires = now + 8 * 60 * 60 * 1000;
      const docName = body['name'].trim();
      const next = registerReplica(pairDocument(record.workspace, { id: body['document'], name: docName, role: invite.role }), body['document'], body['grant']);
      const grants = [...active, { id: body['grant'], document: body['document'], hash: await digest(body['secret']), expires, created: now }];
      const invites = (record.invites ?? []).filter(item => item.id !== inviteId && item.expires > now);
      await this.#commit({ ...record, workspace: next, grants, invites });
      return json({ expires, role: invite.role });
    } else {
      if (!authorized(record, subject, request.headers)) fail(403, 'GitHub repository write access is required for this workspace.');
      record = await this.#ready(record);
    }

    const previous = record.workspace;
    if (!document && url.pathname === '/invites' && request.method === 'POST') {
      if (!isRecord(body) || !isIdentity(body['id']) || !isIdentity(body['secret']) || !['library', 'concept'].includes(String(body['role']))) fail(400, 'The pairing invite is incomplete.');
      const now = Date.now();
      const activeInvites = (record.invites ?? []).filter(item => item.expires > now);
      if (activeInvites.some(item => item.id === body['id'])) fail(409, 'This pairing code already exists.');
      if (activeInvites.length >= 32) fail(409, 'Too many active pairing codes exist for this workspace.');
      const expires = now + 10 * 60 * 1000;
      const invites: WorkspaceInvite[] = [...activeInvites, { id: body['id'], hash: await digest(body['secret']), role: body['role'] === 'library' ? 'library' : 'concept', expires }];
      await this.#commit({ ...record, workspace: previous, invites });
      return json({ expires });
    }
    if (!document && url.pathname === '/cancel-save' && request.method === 'POST') {
      if (!isRecord(body) || typeof body['id'] !== 'string') fail(400, 'Choose the reviewed save to cancel.');
      const next = cancelRepositorySave(previous, body['id']);
      await this.#commit({ ...record, workspace: next });
      return json(privateView({ ...record, workspace: next }));
    }
    if (!document && url.pathname === '/review' && request.method === 'GET') {
      const id = url.searchParams.get('document') ?? '';
      return json(await inspectIncoming(previous, id, reviewReplica(previous, id, url.searchParams.get('replica'))));
    }
    if (request.method === 'POST' && (url.pathname === '/review' || document && isRecord(body) && body['action'] === 'review')) {
      const id = document ?? (isRecord(body) && typeof body['document'] === 'string' ? body['document'] : undefined);
      if (!id || !isRecord(body) || typeof body['revision'] !== 'string' || !isUnknownArray(body['drafts']) || !body['drafts'].every(isConflictDraft)) fail(400, 'The review choices are incomplete.');
      const next = await saveReviewDrafts(previous, id, body['revision'], body['drafts'], replica ?? reviewReplica(previous, id, body['replica']));
      await this.#commit({ ...record, workspace: next });
      return json({ saved: true });
    }
    if (!document && url.pathname === '/workspace' && request.method === 'GET') return json(url.searchParams.get('summary') === '1' ? workspaceSummary(previous) : privateView(record));
    if (!document && url.pathname === '/workspace' && request.method === 'DELETE') {
      if (this.saving.size > 0) fail(409, 'Wait for the repository save to finish before deleting this workspace.');
      const { owner } = record;
      const { id, repository } = previous;
      await deleteWorkspaceRecord(this.state.storage);
      if (this.index) {
        const repoKey = repository ? 'repository:' + repository.repository.toLowerCase() : undefined;
        await Promise.allSettled([
          this.index.get(this.index.idFromName('owner:' + await digest(owner))).fetch(new Request('https://index/?id=' + id, { method: 'DELETE', headers: { 'X-Foundry-Subject': owner } })),
          ...(subject && subject !== owner ? [this.index.get(this.index.idFromName('owner:' + await digest(subject))).fetch(new Request('https://index/?id=' + id, { method: 'DELETE', headers: { 'X-Foundry-Subject': subject } }))] : []),
          ...(repoKey ? [this.index.get(this.index.idFromName(repoKey)).fetch(new Request('https://index/?id=' + id, { method: 'DELETE', headers: { 'X-Foundry-Subject': repoKey } }))] : []),
        ]);
      }
      return json({ deleted: true, id });
    }
    if (!document && url.pathname === '/name' && request.method === 'POST') {
      if (!isRecord(body) || typeof body['before'] !== 'string' || typeof body['name'] !== 'string') fail(400, 'Enter a workspace name.');
      const next = renameWorkspace(previous, body['before'], body['name']);
      if (next !== previous) await this.#commit({ ...record, workspace: next });
      return json(privateView({ ...record, workspace: next }));
    }
    if (!document && url.pathname === '/workspace' && request.method === 'PUT') {
      if (!isRecord(body) || typeof body['before'] !== 'string' || !isWorkspaceInput(body['snapshot'])) fail(400, 'The workspace draft is incomplete.');
      if (subject !== record.owner && (body['snapshot'].repository?.repository !== previous.repository?.repository || body['snapshot'].repository?.root !== previous.repository?.root)) fail(403, 'Open another workspace to change its repository.');
      const next = await saveWorkspace(previous, body['before'], body['snapshot']);
      if (next !== previous) await this.#commit({ ...record, workspace: next });
      return json(privateView({ ...record, workspace: next }));
    }
    if (!document && url.pathname === '/documents' && request.method === 'POST') {
      if (!isRecord(body) || typeof body['document'] !== 'string' || typeof body['name'] !== 'string' || !['library', 'concept'].includes(String(body['role'])) ||
        !isIdentity(body['id']) || !isIdentity(body['secret'])) fail(400, 'The Figma file connection is incomplete.');
      const expires = Date.now() + 8 * 60 * 60 * 1000;
      const active = record.grants.filter(item => item.expires > Date.now());
      const existing = record.grants.find(item => item.id === body['id']);
      if (existing) {
        if (existing.document !== body['document'] || existing.hash !== await digest(body['secret'])) fail(409, 'This device connection already belongs to another pairing.');
        if (existing.expires <= Date.now()) fail(410, 'Open a new pairing request from the plugin.');
        return json({ workspace: privateView(record), expires: existing.expires });
      }
      if (active.length >= 64) fail(409, 'This workspace reached its configured 64-device connection limit. Revoke an unused connection before pairing another device.');
      const next = registerReplica(pairDocument(previous, { id: body['document'], name: body['name'], role: body['role'] === 'library' ? 'library' : 'concept' }), body['document'], body['id']);
      const grants = [...active, { id: body['id'], document: body['document'], hash: await digest(body['secret']), expires, created: Date.now() }];
      await this.#commit({ ...record, workspace: next, grants });
      return json({ workspace: privateView({ ...record, workspace: next, grants }), expires });
    }
    if (!document && url.pathname === '/revoke' && request.method === 'POST') {
      if (!isRecord(body) || typeof body['document'] !== 'string') fail(400, 'Choose a linked Figma file.');
      const grant = body['grant'];
      if (grant !== undefined && (!isIdentity(grant) || !record.grants.some(item => item.id === grant && item.document === body['document']))) fail(400, 'Choose a device connection belonging to this file.');
      const grants = record.grants.filter(item => item.document !== body['document'] || grant !== undefined && item.id !== grant);
      const next = pruneReplicas(disconnectDocument(previous, body['document']), new Set(grants.filter(item => item.expires > Date.now()).map(item => item.id)));
      const disconnected = { ...record, workspace: next, grants };
      await this.#commit(disconnected);
      return json(privateView(disconnected));
    }
    if (request.method === 'POST' && (document || url.pathname === '/resolve')) {
      const proposal = isTokenProposal(body) ? body : isRecord(body) && isTokenProposal(body['proposal']) ? body['proposal'] : undefined;
      const id = document ?? (isRecord(body) && typeof body['document'] === 'string' ? body['document'] : undefined);
      const choices = isRecord(body) && isUnknownArray(body['choices']) && body['choices'].every(isPullChoice) ? body['choices'] : undefined;
      if (!proposal || !id) fail(400, 'The Figma changes are incomplete.');
      const result = await receiveChanges(previous, id, proposal, choices, isRecord(body) && typeof body['revision'] === 'string' ? body['revision'] : undefined,
        replica ?? reviewReplica(previous, id, isRecord(body) ? body['replica'] : undefined));
      if (result.state !== previous) await this.#commit({ ...record, workspace: result.state });
      if (!document) return json({ ...result, state: undefined, workspace: privateView({ ...record, workspace: result.state }) });
      return json({ accepted: result.accepted, ...result.bundle, ...(result.acknowledgement ? { acknowledgement: result.acknowledgement } : {}),
        conflicts: result.conflicts, ...('current' in result ? { current: result.current } : {}),
        ...('drafts' in result ? { drafts: result.drafts, reviewChanged: result.reviewChanged } : {}),
        workspace: { ...workspaceSummary(result.state), document: id, role: result.state.documents.find(file => file.id === id)?.role } });
    }
    return json({ message: 'Route not found.' }, 404);
  }
}

export class WorkspaceRegistry {
  readonly state: State;
  constructor(state: State) { this.state = state; }
  fetch(request: Request): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      if (new URL(request.url).pathname === '/pairings') {
        const stored = await readWorkspaceRecord(this.state.storage);
        const entries = isRecord(stored) && isUnknownArray(stored['pairings']) ? stored['pairings'].filter(isRecord).filter(entry => typeof entry['expires'] === 'number' && entry['expires'] > Date.now()) : [];
        const id = new URL(request.url).searchParams.get('id');
        if (request.method === 'GET') {
          const entry = entries.find(item => item['id'] === id);
          if (!entry) return json({ pending: true });
          const secret = request.headers.get('Authorization')?.replace(/^Bearer /u, '') ?? '';
          if (!isIdentity(secret) || await digest(secret) !== entry['hash']) return json({ message: 'The pairing secret is invalid.' }, 403);
          if (entry['ready'] === false) return json({ pending: true });
          return json({ connection: entry['connection'], expires: entry['expires'] });
        }
        if (request.method !== 'POST' || !request.headers.get('X-Foundry-Subject')) return json({ message: 'Approve this connection in Foundry.' }, 403);
        const body: unknown = JSON.parse(await limitedText(request, 16_000));
        if (!isRecord(body) || !isIdentity(body['id']) || !isIdentity(body['secret']) || typeof body['connection'] !== 'string') return json({ message: 'The pairing request is invalid.' }, 400);
        const previous = entries.find(item => item['id'] === body['id']);
        const hash = await digest(body['secret']);
        if (previous && (previous['hash'] !== hash || previous['connection'] !== body['connection'] || previous['binding'] !== body['binding'])) return json({ message: 'This pairing request already belongs to another file or workspace. Open a new pairing request from the plugin.' }, 409);
        if (previous && (body['reserve'] === true || previous['ready'] !== false)) return json({ reserved: true, approved: previous['ready'] !== false });
        if (entries.length >= 128 && !previous) return json({ message: 'Pairing is busy. Try again after the current requests expire.' }, 503);
        await writeWorkspaceRecord(this.state.storage, { pairings: [...entries.filter(item => item['id'] !== body['id']), { id: body['id'], hash, connection: body['connection'], ...(body['binding'] === undefined ? {} : { binding: body['binding'] }), ready: body['reserve'] !== true, expires: previous?.['expires'] ?? Date.now() + 10 * 60 * 1000 }] });
        return json({ reserved: true, approved: body['reserve'] !== true });
      }
      const subject = request.headers.get('X-Foundry-Subject');
      if (!subject) return json({ message: 'Sign in to open workspaces.' }, 403);
      const stored = await readWorkspaceRecord(this.state.storage);
      const owner = isRecord(stored) ? stored['owner'] : undefined;
      if (owner !== undefined && owner !== subject) return json({ message: 'This workspace list belongs to another account.' }, 403);
      if (request.method === 'GET') return json({ workspaces: isRecord(stored) && isUnknownArray(stored['workspaces']) ? stored['workspaces'] : [] });
      if (request.method === 'DELETE') {
        const id = new URL(request.url).searchParams.get('id');
        if (!isIdentity(id)) return json({ message: 'Choose a workspace to remove.' }, 400);
        const previous = isRecord(stored) ? stored['workspaces'] : undefined;
        const workspaces = isUnknownArray(previous) ? previous.filter(item => !isRecord(item) || item['id'] !== id) : [];
        await writeWorkspaceRecord(this.state.storage, { owner: owner ?? subject, workspaces });
        return json({ deleted: true });
      }
      if (request.method !== 'POST') return json({ message: 'Route not found.' }, 404);
      const body: unknown = JSON.parse(await limitedText(request, 16_000));
      if (!isRecord(body) || !isIdentity(body['id']) || typeof body['name'] !== 'string') return json({ message: 'The workspace entry is incomplete.' }, 400);
      const previous = isRecord(stored) ? stored['workspaces'] : undefined;
      const workspaces = isUnknownArray(previous) ? previous.filter(item => !isRecord(item) || item['id'] !== body['id']) : [];
      await writeWorkspaceRecord(this.state.storage, { owner: subject, workspaces: [body, ...workspaces] });
      return json({ saved: true });
    });
  }
}
