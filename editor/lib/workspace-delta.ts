import type { Review, Workspace } from '../../lib/workspace.ts';

type WorkspaceDelta = {
  name: string;
  baseline?: Workspace['baseline'];
  files: readonly (string | Workspace['files'][number])[];
  graph?: Workspace['graph'];
};
export type ReviewDelta = Omit<Review, 'diff' | 'next'> & { next: WorkspaceDelta };

export function workspaceDelta(before: Workspace, next: Workspace): WorkspaceDelta {
  const files = new Map(before.files.map(file => [file.path, file]));
  return { name: next.name, files: next.files.map(file => files.get(file.path) === file ? file.path : file),
    ...(before.baseline !== next.baseline ? { baseline: next.baseline } : {}),
    ...(before.graph !== next.graph ? { graph: next.graph } : {}) };
}

export function restoreWorkspace(before: Workspace, next: WorkspaceDelta): Workspace {
  const files = new Map(before.files.map(file => [file.path, file]));
  return { name: next.name, baseline: next.baseline ?? before.baseline, graph: next.graph ?? before.graph,
    files: next.files.map(file => {
      if (typeof file !== 'string') return file;
      const source = files.get(file);
      if (!source) throw new Error('Workspace source changed during review: ' + file);
      return source;
    }),
  };
}

export function reviewDelta(before: Workspace, review: Review): ReviewDelta {
  // The diff is a lazy getter and gets hydrated from the changed sources on demand.
  return { ...review, next: workspaceDelta(before, review.next) };
}
