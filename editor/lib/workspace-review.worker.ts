/// <reference lib="webworker" />
import { errorMessage } from '../../lib/json.ts';
import { reviewAffectedResolvers, reviewSource, reviewWorkspace } from '../../lib/workspace.ts';
import type { WorkspaceReviewRequest, WorkspaceReviewResult } from './workspace-review.ts';

if (!(self instanceof DedicatedWorkerGlobalScope)) throw new Error('Expected a workspace review worker.');
const channel: DedicatedWorkerGlobalScope = self;
channel.addEventListener('message', (event: MessageEvent<WorkspaceReviewRequest>) => {
  let result: WorkspaceReviewResult;
  try {
    const request = event.data;
    if (request.kind === 'save') result = { review: reviewWorkspace(request.workspace) };
    else if (request.kind === 'resolver') result = { review: reviewAffectedResolvers(request.workspace, request.draft, request.scope) };
    else result = { review: reviewSource(request.workspace, request.file, request.text, true, request.scope) };
  } catch (failure) {
    result = { error: errorMessage(failure) };
  }
  channel.postMessage(result, []);
});
