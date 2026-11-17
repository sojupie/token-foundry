import type { ResolverModel, ResolverResolution } from '../../lib/resolver.ts';
import type { Move } from '../../lib/structure.ts';
import type { TokenChange } from '../../lib/token-types.ts';
import { diffFile, workspaceChanges } from '../../lib/workspace.ts';
import type { BulkEdit, ResolverEditScope, Review, Workspace } from '../../lib/workspace.ts';

export type WorkspaceReviewRequest =
  | { kind: 'save'; workspace: Workspace }
  | { kind: 'resolver'; workspace: Workspace; draft: Review; scope: ResolverEditScope }
  | { kind: 'source'; workspace: Workspace; file: string; text: string; scope: ResolverEditScope | undefined }
  | { kind: 'edit'; workspace: Workspace; file: string; change: TokenChange }
  | { kind: 'move'; workspace: Workspace; moves: readonly Move[]; operation: 'move' | 'rename' | 'duplicate' }
  | { kind: 'delete'; workspace: Workspace; paths: readonly string[] }
  | { kind: 'bulk'; workspace: Workspace; paths: readonly string[]; edit: BulkEdit };

type OpenRequest = { kind: 'open'; name: string; files: Workspace['baseline'] };
type OpenSampleRequest = { kind: 'sample'; url: string };
type VariantRequest = { kind: 'variant'; model: ResolverModel; inputs: Readonly<Record<string, string>> };
export type WorkspaceWorkerRequest = WorkspaceReviewRequest | OpenRequest | OpenSampleRequest | VariantRequest;
export type WorkspaceWorkerResult = { review: Omit<Review, 'diff'> } | { workspace: Workspace } | { variant: ResolverResolution } | { error: string };

async function exchange(request: WorkspaceWorkerRequest, signal?: AbortSignal): Promise<WorkspaceWorkerResult> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./workspace-review.worker.ts', import.meta.url), { type: 'module' });
  let abort: (() => void) | undefined;
  try {
    return await new Promise<WorkspaceWorkerResult>((resolve, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      worker.addEventListener('message', (event: MessageEvent<WorkspaceWorkerResult>) => {
        if ('error' in event.data) reject(new Error(event.data.error));
        else resolve(event.data);
      }, { once: true });
      worker.addEventListener('error', event => {
        event.preventDefault();
        reject(new Error(event.message || 'The workspace operation could not run.'));
      }, { once: true });
      worker.addEventListener('messageerror', () => {
        reject(new Error('The workspace result could not be read.'));
      }, { once: true });
      worker.postMessage(request, []);
    });
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    worker.terminate();
  }
}

export async function runWorkspaceReview(request: WorkspaceReviewRequest, signal?: AbortSignal): Promise<Review> {
  const result = await exchange(request, signal);
  if ('review' in result) {
    let diff: string | undefined;
    const baseline = request.kind === 'save' ? request.workspace.baseline : request.workspace.files;
    return { ...result.review,
      get diff() { return diff ??= workspaceChanges({ baseline, files: result.review.next.files }).map(diffFile).join(''); },
    };
  }
  throw new Error('Expected a workspace review.');
}

async function readWorkspace(request: OpenRequest | OpenSampleRequest): Promise<Workspace> {
  const result = await exchange(request);
  if ('workspace' in result) return result.workspace;
  throw new Error('Expected a token workspace.');
}

export function openWorkspaceInWorker(name: string, files: Workspace['baseline']): Promise<Workspace> {
  return readWorkspace({ kind: 'open', name, files });
}

export function openSampleInWorker(url: string): Promise<Workspace> {
  return readWorkspace({ kind: 'sample', url });
}

export async function resolveVariantInWorker(model: ResolverModel, inputs: VariantRequest['inputs'], signal: AbortSignal) {
  const result = await exchange({ kind: 'variant', model, inputs }, signal);
  if ('variant' in result) return result.variant;
  throw new Error('Expected a resolved variant.');
}
