import { isRecord } from '../../lib/json.ts';
import { isWorkspaceView } from './model.ts';
import type { WorkspaceInput, WorkspaceView } from './model.ts';

export class SharedWorkspaceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export async function workspaceRequest(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch('/git/workspaces' + path, { method, redirect: 'manual', credentials: 'same-origin', signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
  if (response.type === 'opaqueredirect') throw new SharedWorkspaceError(401, 'Sign in to Foundry to resume shared work. Your local draft is retained.');
  const data: unknown = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : undefined;
  if (!response.ok || !isRecord(data)) throw new SharedWorkspaceError(response.status, isRecord(data) && typeof data['message'] === 'string' ? data['message'] : 'Shared work is unavailable. Your local draft is retained.');
  return data;
}
export async function loadSharedWorkspace(id: string): Promise<WorkspaceView> {
  const view = await workspaceRequest('/' + id);
  if (!isWorkspaceView(view)) throw new Error('The shared workspace response is incomplete. Your local draft is retained.');
  return view;
}
export async function createSharedWorkspace(client: string, snapshot: WorkspaceInput): Promise<WorkspaceView> {
  const view = await workspaceRequest('', 'POST', { client, snapshot });
  if (!isWorkspaceView(view)) throw new Error('The shared workspace response is incomplete.');
  return view;
}
export async function saveSharedWorkspace(id: string, before: string, snapshot: WorkspaceInput): Promise<WorkspaceView> {
  const view = await workspaceRequest('/' + id, 'PUT', { before, snapshot });
  if (!isWorkspaceView(view)) throw new Error('The shared save response is incomplete. Your local draft is retained.');
  return view;
}
export async function deleteSharedWorkspace(id: string): Promise<void> {
  await workspaceRequest('/' + id, 'DELETE');
}
