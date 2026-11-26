import { openWorkspace, reviewAgainstLatest } from '../../lib/workspace.ts';
import { mergeRepositorySources, RepositoryConflicts } from '../../lib/repository-merge.ts';
import type { RepositoryChoice, RepositoryConflict } from '../../lib/repository-merge.ts';
import type { SourceFile } from '../figma/contract.ts';
const sameFiles = (left: SourceFile[], right: SourceFile[]) => left === right || left.length === right.length && left.every((file, index) => file.path === right[index]?.path && file.text === right[index]?.text);

export class WorkspaceMergeInvalid extends Error {
  readonly conflicts: RepositoryConflict[];
  constructor(message: string, conflicts: RepositoryConflict[] = []) { super(message); this.conflicts = conflicts; }
}

/** Validate interactions between edits while retaining diagnostics already present in either draft. */
export function mergeWorkspaceSources(name: string, baseline: SourceFile[], local: SourceFile[], remote: SourceFile[], choices?: RepositoryChoice[]): SourceFile[] {
  // Only a combined edit needs interaction validation. One unchanged side cannot
  // introduce a new interaction, and recoverable source errors remain editable.
  if (choices === undefined) {
    if (sameFiles(local, baseline) || sameFiles(local, remote)) return remote;
    if (sameFiles(remote, baseline)) return local;
  }
  try {
    const review = reviewAgainstLatest({ ...openWorkspace(name, local), baseline }, openWorkspace(name, remote), choices);
    return review ? review.next.files.map(({ path, text }) => ({ path, text })) : remote;
  } catch (error) {
    if (error instanceof RepositoryConflicts) throw error;
    let conflicts: RepositoryConflict[] = [];
    if (choices?.length) {
      try { mergeRepositorySources(baseline, local, remote); }
      catch (unresolved) { if (unresolved instanceof RepositoryConflicts) conflicts = unresolved.conflicts; }
    }
    throw new WorkspaceMergeInvalid(error instanceof Error ? error.message : 'The combined draft is invalid. Review the affected definitions before saving.', conflicts);
  }
}
