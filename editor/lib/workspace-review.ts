import type { ResolverEditScope, Review, Workspace } from '../../lib/workspace.ts';

export type WorkspaceReviewRequest =
  | { kind: 'save'; workspace: Workspace }
  | { kind: 'resolver'; workspace: Workspace; draft: Review; scope: ResolverEditScope }
  | { kind: 'source'; workspace: Workspace; file: string; text: string; scope: ResolverEditScope | undefined };

export type WorkspaceReviewResult = { review: Review } | { error: string };

export async function runWorkspaceReview(request: WorkspaceReviewRequest, signal?: AbortSignal): Promise<Review> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./workspace-review.worker.ts', import.meta.url), { type: 'module' });
  let abort: (() => void) | undefined;
  try {
    return await new Promise<Review>((resolve, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      worker.addEventListener('message', (event: MessageEvent<WorkspaceReviewResult>) => {
        if ('error' in event.data) reject(new Error(event.data.error));
        else resolve(event.data.review);
      }, { once: true });
      worker.addEventListener('error', event => {
        event.preventDefault();
        reject(new Error(event.message || 'The workspace review could not run.'));
      }, { once: true });
      worker.addEventListener('messageerror', () => {
        reject(new Error('The workspace review result could not be read.'));
      }, { once: true });
      worker.postMessage(request, []);
    });
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    worker.terminate();
  }
}
