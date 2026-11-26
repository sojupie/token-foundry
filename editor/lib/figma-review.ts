import { isTokenProposal, sameSourceValue } from '../../integrations/figma/contract.ts';
import type { TokenProposal } from '../../integrations/figma/contract.ts';
import { isConflictDraft } from '../../integrations/figma/recovery.ts';
import type { ConflictDraft } from '../../integrations/figma/recovery.ts';
import { isRecord, isUnknownArray } from '../../lib/json.ts';

export interface IncomingReviewRecovery {
  workspace: string; document: string; replica?: string; proposal: TokenProposal; drafts: ConflictDraft[];
}
export interface PreparedIncomingInput { complete: () => void; release: () => void }
export const sameIncomingReview = (a: IncomingReviewRecovery, b: IncomingReviewRecovery) =>
  a.workspace === b.workspace && a.document === b.document && a.replica === b.replica && sameSourceValue(a.proposal, b.proposal);
export const isIncomingReviewRecovery = (value: unknown): value is IncomingReviewRecovery => isRecord(value) &&
  typeof value['workspace'] === 'string' && typeof value['document'] === 'string' &&
  (value['replica'] === undefined || typeof value['replica'] === 'string') && isTokenProposal(value['proposal']) &&
  isUnknownArray(value['drafts']) && value['drafts'].every(isConflictDraft);
