import { planResolver } from '../../lib/resolver.ts';
import type { ComparableContext, ResolverModel, ResolverResolution, compareContexts } from '../../lib/resolver.ts';
import type { JsonValue } from '../../lib/json.ts';
import { restoreWorkspace, reviewDelta } from './workspace-delta.ts';
import type { ReviewDelta } from './workspace-delta.ts';
import type { Move } from '../../lib/structure.ts';
import type { TokenChange } from '../../lib/token-types.ts';
import { reviewFileChanges, withReviewDiff, workspaceChanges } from '../../lib/workspace.ts';
import type { BulkEdit, FileChange, MoveDestination, ResolverBulkScope, ResolverEditScope, Review, Workspace } from '../../lib/workspace.ts';

export interface ResolverEdit {
  file: string;
  parts: readonly string[];
  value: JsonValue;
  insert?: boolean | undefined;
}

export type WorkspaceReviewRequest =
  | { kind: 'save'; workspace: Workspace }
  | { kind: 'resolver'; workspace: Workspace; draft: Review; scope: ResolverEditScope }
  | ({ kind: 'resolver-edit'; workspace: Workspace; scope: ResolverEditScope } & ResolverEdit)
  | { kind: 'source'; workspace: Workspace; file: string; text: string; scope: ResolverEditScope | undefined }
  | { kind: 'edit'; workspace: Workspace; file: string; change: TokenChange }
  | { kind: 'proposal'; workspace: Workspace; text: string }
  | { kind: 'restore-inherited'; workspace: Workspace; path: string }
  | { kind: 'move'; workspace: Workspace; moves: readonly Move[]; operation: 'move' | 'rename' | 'duplicate' }
  | { kind: 'delete'; workspace: Workspace; paths: readonly string[] }
  | { kind: 'resolver-structure'; workspace: Workspace; scope: ResolverBulkScope; operation: 'rename' | 'move' | 'duplicate' | 'delete';
    changes: readonly { path: string; to?: string }[]; target?: MoveDestination }
  | { kind: 'bulk'; workspace: Workspace; paths: readonly string[]; edit: BulkEdit; scope?: ResolverBulkScope };

type OpenRequest = { kind: 'open'; name: string; files: Workspace['baseline'] };
type OpenSampleRequest = { kind: 'sample'; url: string };
type VariantRequest = { kind: 'variant'; plan: ReturnType<typeof planResolver> };
type ComparisonRequest = { kind: 'compare'; before: string | ComparableContext; after: string | ComparableContext };
type DiffRequest = { kind: 'diff'; changes: readonly FileChange[] } |
  { kind: 'diff'; before: string; after: string; saved: boolean };
type Snapshot = { name: string; baseline: Workspace['baseline']; sources: Workspace['baseline'] };

type ReviewOperation<R = WorkspaceReviewRequest> = R extends WorkspaceReviewRequest ?
  Omit<R, 'workspace' | 'draft' | 'scope'> & (R extends { kind: 'resolver'; scope: infer S }
    ? { draft: ReviewDelta; scope: S }
    : R extends { scope?: ResolverBulkScope }
      ? { scope?: { review: ResolverEditScope; resolution: string | ResolverResolution } | undefined }
      : Pick<R, Extract<keyof R, 'scope'>>) : never;

export type WorkspaceWorkerRequest = OpenRequest | OpenSampleRequest | VariantRequest | ComparisonRequest | DiffRequest |
  { kind: 'review'; base: string; snapshot?: Snapshot; operation: ReviewOperation };
export type WorkspaceWorkerResult =
  | { review: ReviewDelta; snapshotId: string }
  | { workspace: Workspace; snapshotId: string }
  | { variant: ResolverResolution; variantId: string }
  | { comparison: ReturnType<typeof compareContexts> }
  | { diff: string }
  | { missing: 'workspace' | 'variant' }
  | { error: string };
export type WorkerTask = { id: number; request: WorkspaceWorkerRequest } | { cancel: number };
export type WorkerReply = { id: number; result: WorkspaceWorkerResult };

interface WorkerSession {
  worker: Worker;
  workspaces: WeakMap<Workspace, string>;
  variants: WeakMap<ResolverResolution, string>;
  reviews: WeakMap<Review, Extract<DiffRequest, { before: string }>>;
  pending: Map<number, { resolve: (result: WorkspaceWorkerResult) => void; reject: (reason: unknown) => void }>;
}

let session: WorkerSession | undefined;
let serial = 0;
const workers = import.meta.glob<new () => Worker>('./workspace-review.worker.ts', { eager: true, query: '?worker&inline', import: 'default' });

function workspaceWorker(): WorkerSession {
  if (session) return session;
  const ReviewWorker = workers['./workspace-review.worker.ts'];
  if (!ReviewWorker) throw new Error('The workspace review worker is unavailable.');
  const worker = new ReviewWorker();
  const ready: WorkerSession = { worker, workspaces: new WeakMap(), variants: new WeakMap(), reviews: new WeakMap(), pending: new Map() };
  session = ready;
  function failed(message: string) {
    if (session === ready) session = undefined;
    worker.terminate();
    for (const task of ready.pending.values()) task.reject(new Error(message));
    ready.pending.clear();
  }
  worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
    const task = ready.pending.get(event.data.id);
    if (!task) return;
    ready.pending.delete(event.data.id);
    if ('error' in event.data.result) task.reject(new Error(event.data.result.error));
    else task.resolve(event.data.result);
  });
  worker.addEventListener('error', event => {
    event.preventDefault();
    failed(event.message || 'The workspace operation could not run.');
  });
  worker.addEventListener('messageerror', () => failed('The workspace result could not be read.'));
  return ready;
}

async function exchange(worker: WorkerSession, request: WorkspaceWorkerRequest, signal?: AbortSignal): Promise<WorkspaceWorkerResult> {
  signal?.throwIfAborted();
  const id = ++serial;
  function abort() {
    if (!worker.pending.has(id)) return;
    worker.worker.postMessage({ cancel: id } satisfies WorkerTask, []);
    worker.pending.get(id)?.reject(signal?.reason);
    worker.pending.delete(id);
  }
  try {
    return await new Promise<WorkspaceWorkerResult>((resolve, reject) => {
      worker.pending.set(id, { resolve, reject });
      signal?.addEventListener('abort', abort, { once: true });
      worker.worker.postMessage({ id, request } satisfies WorkerTask, []);
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    worker.pending.delete(id);
  }
}

function reviewOperation(request: WorkspaceReviewRequest, variantId?: string): ReviewOperation {
  const { workspace, ...operation } = request;
  if (operation.kind === 'resolver') {
    const { draft, ...rest } = operation;
    return { ...rest, draft: reviewDelta(workspace, draft) };
  }
  if ((operation.kind === 'bulk' || operation.kind === 'resolver-structure') && operation.scope) {
    return { ...operation, scope: { review: operation.scope.review, resolution: variantId ?? operation.scope.resolution } };
  }
  return operation;
}

export async function runWorkspaceReview(request: WorkspaceReviewRequest, signal?: AbortSignal): Promise<Review> {
  const worker = workspaceWorker();
  const { workspace } = request;
  const base = worker.workspaces.get(workspace) ?? 'client-' + ++serial;
  const scope = request.kind === 'bulk' || request.kind === 'resolver-structure' ? request.scope : undefined;
  function register() {
    return { name: workspace.name, baseline: workspace.baseline, sources: workspace.files.map(({ path, text }) => ({ path, text })) };
  }
  async function requestReview(snapshot: Snapshot | undefined, variantId: string | undefined): Promise<Review> {
    const result = await exchange(worker, { kind: 'review', base, operation: reviewOperation(request, variantId),
      ...(snapshot ? { snapshot } : {}) }, signal);
    if ('missing' in result) {
      if (result.missing === 'workspace' && !snapshot) return requestReview(register(), variantId);
      if (result.missing === 'variant' && variantId) return requestReview(snapshot, undefined);
    }
    if ('review' in result) {
      worker.workspaces.set(workspace, base);
      const next = restoreWorkspace(workspace, result.review.next);
      worker.workspaces.set(next, result.snapshotId);
      const baseline = request.kind === 'save' ? workspace.baseline : workspace.files;
      const review = withReviewDiff({ ...result.review, next }, () => workspaceChanges({ baseline, files: next.files }));
      worker.reviews.set(review, { kind: 'diff', before: base, after: result.snapshotId, saved: request.kind === 'save' });
      return review;
    }
    throw new Error('Expected a workspace review.');
  }
  return requestReview(worker.workspaces.has(workspace) ? undefined : register(), scope && worker.variants.get(scope.resolution));
}

async function readWorkspace(request: OpenRequest | OpenSampleRequest): Promise<Workspace> {
  const worker = workspaceWorker();
  const result = await exchange(worker, request);
  if ('workspace' in result) {
    worker.workspaces.set(result.workspace, result.snapshotId);
    return result.workspace;
  }
  throw new Error('Expected a token workspace.');
}

export function openWorkspaceInWorker(name: string, files: Workspace['baseline']): Promise<Workspace> {
  return readWorkspace({ kind: 'open', name, files });
}

export function openSampleInWorker(url: string): Promise<Workspace> {
  return readWorkspace({ kind: 'sample', url });
}

export async function resolveVariantInWorker(model: ResolverModel, inputs: Readonly<Record<string, string>>, signal: AbortSignal) {
  const worker = workspaceWorker();
  const result = await exchange(worker, { kind: 'variant', plan: planResolver(model, inputs) }, signal);
  if ('variant' in result) {
    worker.variants.set(result.variant, result.variantId);
    return result.variant;
  }
  throw new Error('Expected a resolved variant.');
}

function comparisonSource({ graph }: ResolverResolution): ComparableContext {
  const tokens = new Map<string, { type: string | undefined }>();
  for (const [path, { type }] of graph.tokens) tokens.set(path, { type });
  return { graph: { tokens, resolved: graph.resolved, issues: graph.issues, validation: graph.validation } };
}

export async function compareVariantsInWorker(before: ResolverResolution, after: ResolverResolution, signal: AbortSignal) {
  const worker = workspaceWorker();
  const first = await exchange(worker, { kind: 'compare',
    before: worker.variants.get(before) ?? comparisonSource(before),
    after: worker.variants.get(after) ?? comparisonSource(after),
  }, signal);
  const result = 'missing' in first ? await exchange(worker, {
    kind: 'compare', before: comparisonSource(before), after: comparisonSource(after),
  }, signal) : first;
  if ('comparison' in result) return result.comparison;
  throw new Error('Expected a variant comparison.');
}

export async function reviewDiffInWorker(review: Review, signal?: AbortSignal): Promise<string> {
  const worker = workspaceWorker();
  const resident = worker.reviews.get(review);
  if (resident) {
    const result = await exchange(worker, resident, signal);
    if ('diff' in result) return result.diff;
  }
  const changes = reviewFileChanges(review);
  if (!changes) return review.diff;
  const result = await exchange(worker, { kind: 'diff', changes }, signal);
  if ('diff' in result) return result.diff;
  throw new Error('Expected a file diff.');
}
