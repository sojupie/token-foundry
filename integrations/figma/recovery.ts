import { isRecord } from '../../lib/json.ts';
import { isPullConflict } from './merge.ts';
import type { PullConflict } from './merge.ts';

export interface ConflictDraft { path: string; keep: string; text: string; inputKind?: 'value' | 'alias'; review?: PullConflict }
export const conflictInputKind = (draft: ConflictDraft) => draft.inputKind ?? (draft.keep === 'custom' ? 'value' : draft.keep === 'alias' ? 'alias' : undefined);
export const unmatchedConflictDrafts = (conflicts: readonly { path: string }[], drafts: readonly ConflictDraft[]) =>
  drafts.filter(draft => (draft.keep || draft.text) && !conflicts.some(conflict => conflict.path === draft.path));
export const isConflictDraft = (value: unknown): value is ConflictDraft => isRecord(value) && typeof value['path'] === 'string' && typeof value['text'] === 'string' && typeof value['keep'] === 'string' && ['', 'source', 'figma', 'custom', 'alias'].includes(value['keep']) &&
  (value['inputKind'] === undefined || value['inputKind'] === 'value' || value['inputKind'] === 'alias') &&
  (value['review'] === undefined || isPullConflict(value['review']) && value['review'].path === value['path']);
