import { openWorkspace } from '../../lib/workspace.ts';
import type { Workspace } from '../../lib/workspace.ts';
import type { FigmaBundle, TokenProposal } from './contract.ts';
import { acknowledgedPull, changedValues, importedValue, pullConflicts, pullValues } from './merge.ts';
import type { FigmaAcknowledgement, PullChoice } from './merge.ts';
import { figmaBundle, proposalReview } from './projection.ts';

/** Review a submitted Figma proposal against the current workspace, including independent source edits. */
export async function proposalPull(workspace: Workspace, baseline: FigmaBundle, proposal: TokenProposal, choices?: readonly PullChoice[], receipt?: FigmaAcknowledgement) {
  const original = proposalReview(openWorkspace(baseline.name, baseline.files), baseline, proposal);
  if (original.validationErrors?.length) throw new Error(original.validationErrors.join('\n'));
  const edited = await figmaBundle(original.next);
  const current = await figmaBundle(workspace);
  const local = new Map(edited.variables.map(row => [row.path, importedValue(row)]));
  const acknowledged = acknowledgedPull(baseline, current, local, receipt);
  const conflicts = pullConflicts(acknowledged.previous, current, acknowledged.local);
  if (conflicts.length && choices === undefined) return { conflicts, current, review: undefined };
  const values = pullValues(acknowledged.previous, current, acknowledged.local, choices);
  const rebased = changedValues(current, values);
  const review = rebased.changes.length ? proposalReview(workspace, current, rebased) : undefined;
  if (review?.validationErrors?.length) throw new Error(review.validationErrors.join('\n'));
  return { conflicts: [], current, review };
}
