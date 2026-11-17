/// <reference lib="webworker" />
import { resolveResolver } from '../../lib/resolver.ts';
import { errorMessage } from '../../lib/json.ts';
import { openWorkspace, reviewAffectedResolvers, reviewBulkEdit, reviewDelete, reviewDuplicate, reviewEdit, reviewMoves, reviewSource, reviewWorkspace } from '../../lib/workspace.ts';
import type { WorkspaceReviewRequest, WorkspaceWorkerRequest, WorkspaceWorkerResult } from './workspace-review.ts';

if (!(self instanceof DedicatedWorkerGlobalScope)) throw new Error('Expected a workspace review worker.');
const channel: DedicatedWorkerGlobalScope = self;

function review(request: WorkspaceReviewRequest) {
  switch (request.kind) {
    case 'save': return reviewWorkspace(request.workspace);
    case 'resolver': return reviewAffectedResolvers(request.workspace, request.draft, request.scope);
    case 'source': return reviewSource(request.workspace, request.file, request.text, true, request.scope);
    case 'edit': {
      const result = reviewEdit(request.workspace, request.file, request.change);
      return request.workspace.authoredSource ? reviewAffectedResolvers(request.workspace, result) : result;
    }
    case 'delete': {
      const result = reviewDelete(request.workspace, request.paths);
      return request.workspace.authoredSource ? reviewAffectedResolvers(request.workspace, result) : result;
    }
    case 'bulk': {
      const result = reviewBulkEdit(request.workspace, request.paths, request.edit);
      return request.workspace.authoredSource ? reviewAffectedResolvers(request.workspace, result) : result;
    }
    case 'move': {
      const result = request.operation === 'duplicate' ? reviewDuplicate(request.workspace, request.moves) :
        reviewMoves(request.workspace, request.moves, request.operation === 'rename');
      return request.workspace.authoredSource ? reviewAffectedResolvers(request.workspace, result) : result;
    }
    default: throw new Error('Unknown review operation.');
  }
}

async function run(request: WorkspaceWorkerRequest) {
  let result: WorkspaceWorkerResult;
  try {
    if (request.kind === 'open') result = { workspace: openWorkspace(request.name, request.files) };
    else if (request.kind === 'sample') {
      const response = await fetch(request.url);
      if (!response.ok) throw new Error('The Material 3 sample could not be loaded.');
      const { unzipSync, strFromU8 } = await import('fflate');
      const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
      const files = Object.entries(entries).map(([path, bytes]) => ({ path, text: strFromU8(bytes) }));
      result = { workspace: openWorkspace('Material 3', files) };
    }
    else if (request.kind === 'variant') result = { variant: resolveResolver(request.model, request.inputs) };
    else {
      const checked = review(request);
      // Structured clone reads enumerable getters. Leave the diff lazy on the receiving side.
      Object.defineProperty(checked, 'diff', { enumerable: false });
      result = { review: checked };
    }
  } catch (failure) {
    result = { error: errorMessage(failure) };
  }
  channel.postMessage(result, []);
}

channel.addEventListener('message', (event: MessageEvent<WorkspaceWorkerRequest>) => {
  void run(event.data);
});
