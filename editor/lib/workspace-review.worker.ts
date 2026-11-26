/// <reference lib="webworker" />
import { compareContexts, resolveResolverPlan } from '../../lib/resolver.ts';
import type { ResolverResolution } from '../../lib/resolver.ts';
import { errorMessage } from '../../lib/json.ts';
import { diffFile, openWorkspace, reviewAffectedResolvers, reviewBulkEdit, reviewDelete, reviewDuplicate, reviewEdit, reviewMoves, reviewProposal, reviewRemoveOverride, reviewResolverStructure, reviewResolverValue, reviewSource, reviewWorkspace, workspaceChanges } from '../../lib/workspace.ts';
import type { Review, Workspace } from '../../lib/workspace.ts';
import { restoreWorkspace, reviewDelta } from './workspace-delta.ts';
import type { WorkerReply, WorkerTask, WorkspaceWorkerRequest, WorkspaceWorkerResult } from './workspace-review.ts';

if (!(self instanceof DedicatedWorkerGlobalScope)) throw new Error('Expected a workspace review worker.');
const channel: DedicatedWorkerGlobalScope = self;

const workspaces = new Map<string, Workspace>();
const variants = new Map<string, ResolverResolution>();
let serial = 0;

function retain<T>(cache: Map<string, T>, key: string, value: T, limit = 3) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return key;
}

async function review(workspace: Workspace, operation: Extract<WorkspaceWorkerRequest, { kind: 'review' }>['operation']): Promise<Review | undefined> {
  switch (operation.kind) {
    case 'save': return reviewWorkspace(workspace);
    case 'resolver': {
      const next = restoreWorkspace(workspace, operation.draft.next);
      return reviewAffectedResolvers(workspace, { ...operation.draft, diff: '', next }, operation.scope);
    }
    case 'resolver-edit': {
      const pending = reviewResolverValue(workspace, operation.file, operation.parts, operation.value, operation.insert);
      return reviewAffectedResolvers(workspace, pending, operation.scope);
    }
    case 'source': return reviewSource(workspace, operation.file, operation.text, true, operation.scope);
    case 'edit': return reviewEdit(workspace, operation.file, operation.change);
    case 'proposal': return reviewProposal(workspace, operation.text);
    case 'restore-inherited': return reviewRemoveOverride(workspace, operation.path);
    case 'delete': return reviewDelete(workspace, operation.paths);
    case 'bulk':
    case 'resolver-structure': {
      const scope = operation.scope;
      const resolution = typeof scope?.resolution === 'string' ? variants.get(scope.resolution) : scope?.resolution;
      const resolved = scope && resolution ? { review: scope.review, resolution } : undefined;
      if (scope && !resolved) return undefined;
      if (operation.kind === 'bulk') return reviewBulkEdit(workspace, operation.paths, operation.edit, resolved);
      if (!resolved) throw new Error('Expected the edited set.');
      return reviewResolverStructure(workspace, resolved, operation.operation, operation.changes, operation.target);
    }
    case 'move': return operation.operation === 'duplicate' ? reviewDuplicate(workspace, operation.moves) :
      reviewMoves(workspace, operation.moves, operation.operation === 'rename');
    default: throw new Error('Unknown review operation.');
  }
}

function opened(workspace: Workspace): WorkspaceWorkerResult {
  return { workspace, snapshotId: retain(workspaces, 'workspace-' + ++serial, workspace) };
}

async function run(request: WorkspaceWorkerRequest): Promise<WorkspaceWorkerResult> {
  if (request.kind === 'open') return opened(openWorkspace(request.name, request.files));
  if (request.kind === 'sample') {
    const response = await fetch(request.url);
    if (!response.ok) throw new Error('The Material 3 sample could not be loaded.');
    const { unzipSync, strFromU8 } = await import('fflate');
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    return opened(openWorkspace('Material 3', Object.entries(entries).map(([path, bytes]) => ({ path, text: strFromU8(bytes) }))));
  }
  if (request.kind === 'variant') {
    const variant = resolveResolverPlan(request.plan);
    return { variant, variantId: retain(variants, 'variant-' + ++serial, variant, 2) };
  }
  if (request.kind === 'compare') {
    const before = typeof request.before === 'string' ? variants.get(request.before) : request.before;
    const after = typeof request.after === 'string' ? variants.get(request.after) : request.after;
    return before && after ? { comparison: compareContexts(before, after) } : { missing: 'variant' };
  }
  if (request.kind === 'diff') {
    if ('changes' in request) return { diff: request.changes.map(diffFile).join('') };
    const before = workspaces.get(request.before);
    const after = workspaces.get(request.after);
    if (!before || !after) return { missing: 'workspace' };
    const baseline = request.saved ? before.baseline : before.files;
    return { diff: workspaceChanges({ baseline, files: after.files }).map(diffFile).join('') };
  }
  const stored = workspaces.get(request.base);
  const snapshot = request.snapshot;
  const workspace = stored ?? (snapshot && { ...openWorkspace(snapshot.name, snapshot.sources), baseline: snapshot.baseline });
  if (!workspace) return { missing: 'workspace' };
  retain(workspaces, request.base, workspace);
  const checked = await review(workspace, request.operation);
  if (!checked) return { missing: 'variant' };
  return { review: reviewDelta(workspace, checked), snapshotId: retain(workspaces, 'workspace-' + ++serial, checked.next) };
}

// Superseded work waiting in the queue can be discarded before parsing or composing.
const queued = new Map<number, WorkspaceWorkerRequest>();
let running = false;

function schedule() {
  if (running || !queued.size) return;
  running = true;
  setTimeout(() => { void nextTask(); }, 0);
}

async function nextTask() {
  const next = queued.entries().next().value;
  if (next) {
    const [id, request] = next;
    try {
      const result = await run(request);
      if (queued.has(id)) channel.postMessage({ id, result } satisfies WorkerReply, []);
    } catch (failure) {
      if (queued.has(id)) channel.postMessage({ id, result: { error: errorMessage(failure) } } satisfies WorkerReply, []);
    } finally {
      queued.delete(id);
    }
  }
  running = false;
  schedule();
}

channel.addEventListener('message', (event: MessageEvent<WorkerTask>) => {
  if ('cancel' in event.data) queued.delete(event.data.cancel);
  else queued.set(event.data.id, event.data.request);
  schedule();
});
