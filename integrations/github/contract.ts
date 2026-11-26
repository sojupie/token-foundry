import { isRecord, isUnknownArray } from '../../lib/json.ts';
import type { FileChange } from '../../lib/workspace.ts';

export interface RepositorySnapshot {
  repository: string;
  revision: string;
  root: string;
  files: { path: string; text: string }[];
  branch?: string;
  pullRequest?: string;
}

export interface PullRequestProposal {
  repository: string;
  revision: string;
  changes: FileChange[];
  branch?: string;
}

export const repositoryName = /^[a-z\d][a-z\d-]*\/(?!\.{1,2}$)[a-z\d_.-]+$/iu;
export const commitOid = /^[a-f\d]{40}$/u;
export const baseChanged = 'base_changed';
export const proposalUnavailable = 'proposal_unavailable';
export const proposalBranch = /^token-editor\/[A-Za-z\d_-]{43}$/u;

function sourceFile(value: unknown): value is { path: string; text: string } {
  return isRecord(value) && typeof value['path'] === 'string' && typeof value['text'] === 'string';
}

function fileChange(value: unknown): value is FileChange {
  return isRecord(value) && typeof value['path'] === 'string' && (typeof value['before'] === 'string' || value['before'] === null) &&
    (typeof value['after'] === 'string' || value['after'] === null);
}
function pullRequestUrl(value: unknown, repository: string): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const prefix = '/' + repository + '/pull/';
    return url.origin === 'https://github.com' && url.pathname.startsWith(prefix) && /^\d+$/u.test(url.pathname.slice(prefix.length));
  } catch { return false; }
}

export function isSnapshot(value: unknown): value is RepositorySnapshot {
  return isRecord(value) && typeof value['repository'] === 'string' && repositoryName.test(value['repository']) &&
    typeof value['revision'] === 'string' && commitOid.test(value['revision']) && typeof value['root'] === 'string' && isUnknownArray(value['files']) &&
    value['files'].every(sourceFile) && (value['branch'] === undefined || typeof value['branch'] === 'string' && proposalBranch.test(value['branch'])) &&
    (value['pullRequest'] === undefined || pullRequestUrl(value['pullRequest'], value['repository']));
}

export function isProposal(value: unknown): value is PullRequestProposal {
  return isRecord(value) && typeof value['repository'] === 'string' && repositoryName.test(value['repository']) &&
    typeof value['revision'] === 'string' && commitOid.test(value['revision']) && isUnknownArray(value['changes']) &&
    value['changes'].length > 0 && value['changes'].every(fileChange) &&
    (value['branch'] === undefined || typeof value['branch'] === 'string' && proposalBranch.test(value['branch']));
}
