import { isRecord, isUnknownArray } from '../../lib/json.ts';
import type { FileChange } from '../../lib/workspace.ts';

export interface RepositorySnapshot {
  repository: string;
  revision: string;
  files: { path: string; text: string }[];
}

export interface PullRequestProposal {
  repository: string;
  revision: string;
  changes: FileChange[];
}

export const repositoryName = /^[a-z\d][a-z\d-]*\/(?!\.{1,2}$)[a-z\d_.-]+$/iu;
export const commitOid = /^[a-f\d]{40}$/u;
export const baseChanged = 'base_changed';

function sourceFile(value: unknown): value is { path: string; text: string } {
  return isRecord(value) && typeof value['path'] === 'string' && typeof value['text'] === 'string';
}

function fileChange(value: unknown): value is FileChange {
  return isRecord(value) && typeof value['path'] === 'string' && typeof value['before'] === 'string' && typeof value['after'] === 'string';
}

export function isSnapshot(value: unknown): value is RepositorySnapshot {
  return isRecord(value) && typeof value['repository'] === 'string' && repositoryName.test(value['repository']) &&
    typeof value['revision'] === 'string' && commitOid.test(value['revision']) && isUnknownArray(value['files']) &&
    value['files'].every(sourceFile);
}

export function isProposal(value: unknown): value is PullRequestProposal {
  return isRecord(value) && typeof value['repository'] === 'string' && repositoryName.test(value['repository']) &&
    typeof value['revision'] === 'string' && commitOid.test(value['revision']) && isUnknownArray(value['changes']) &&
    value['changes'].length > 0 && value['changes'].every(fileChange);
}
