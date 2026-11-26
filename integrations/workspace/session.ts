import { RepositoryConflicts } from '../../lib/repository-merge.ts';
import { mergeWorkspaceSources, WorkspaceMergeInvalid } from './merge.ts';
import type { RepositoryChoice, RepositoryConflict } from '../../lib/repository-merge.ts';
import { sourceRevision } from '../figma/projection.ts';
import { sameSourceValue } from '../figma/contract.ts';
import type { RepositoryPin, SharedRecovery, SourceSnapshot, WorkspaceInput, WorkspaceView } from './model.ts';
import { createSharedWorkspace, loadSharedWorkspace, saveSharedWorkspace, workspaceRequest, SharedWorkspaceError } from './client.ts';

export interface WorkspaceClientInput {
  client: string; snapshot: WorkspaceInput; recovery?: SharedRecovery; canApplyRemote: boolean; origin: string;
}
export interface WorkspaceClientState {
  phase: 'local' | 'saving' | 'saved' | 'offline' | 'updates' | 'conflict' | 'invalid';
  view?: WorkspaceView; accepted?: SourceSnapshot; problem?: string; conflicts?: RepositoryConflict[];
  checkpoint?: SourceSnapshot; repository?: RepositoryPin;
}
export interface WorkspaceClientContext {
  current: () => WorkspaceClientInput;
  replace: (view: WorkspaceView) => void;
  remember: (link: SharedRecovery) => void;
}
interface Transport {
  create: typeof createSharedWorkspace; load: typeof loadSharedWorkspace; save: typeof saveSharedWorkspace;
  summary: (id: string) => Promise<{ version: unknown }>;
}
const local: WorkspaceClientState = { phase: 'local' };

/** One revisioned session per editor workspace; views/dialogs never own its lifecycle. */
export class WorkspaceClient {
  readonly #states = new Map<string, WorkspaceClientState>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #epochs = new Map<string, number>();
  readonly #checked = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  readonly #transport: Transport;
  constructor(transport: Transport = { create: createSharedWorkspace, load: loadSharedWorkspace, save: saveSharedWorkspace,
    summary: async id => { const result = await workspaceRequest('/' + id + '?summary=1'); return { version: result['version'] }; } }) { this.#transport = transport; }
  get = (client: string): WorkspaceClientState => this.#states.get(client) ?? local;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #set(client: string, next: WorkspaceClientState) {
    const previous = this.get(client);
    if (previous.phase === next.phase && previous.view?.version === next.view?.version && previous.accepted?.revision === next.accepted?.revision && previous.problem === next.problem && previous.conflicts === next.conflicts) return;
    this.#states.set(client, next); for (const listener of this.#listeners) listener();
  }
  sync(client: string, context: WorkspaceClientContext, choices?: RepositoryChoice[]): Promise<void> {
    const running = this.#running.get(client);
    if (!choices && running) return running;
    const update = async (selected?: RepositoryChoice[]): Promise<void> => {
      if (context.current().client !== client) return;
      const before = context.current().snapshot;
      await this.#synchronize(client, context, selected);
      const state = this.get(client);
      if (state.phase === 'offline' || state.phase === 'conflict' || state.phase === 'updates' || state.phase === 'invalid' || sameSourceValue(before, context.current().snapshot)) return;
      return update();
    };
    const queued = (this.#queues.get(client) ?? Promise.resolve()).then(() => update(choices))
      .finally(() => { if (this.#running.get(client) === queued) this.#running.delete(client); });
    this.#queues.set(client, queued); this.#running.set(client, queued); return queued;
  }
  async #synchronize(client: string, context: WorkspaceClientContext, choices?: RepositoryChoice[]): Promise<void> {
      if (context.current().client !== client) return undefined;
      const epoch = this.#epochs.get(client);
      const superseded = () => this.#epochs.get(client) !== epoch;
      let view = this.get(client).view;
      const input = context.current();
      let checked: string | undefined;
      try {
        if (input.recovery && input.recovery.origin !== input.origin) throw new Error('This shared workspace belongs to ' + input.recovery.origin + '. Your local draft is retained.');
        const previous = this.get(client);
        const basis = previous.accepted ?? input.recovery?.accepted ?? { revision: await sourceRevision(input.snapshot.baseline), files: input.snapshot.baseline };
        const checkpoint = previous.checkpoint ?? input.recovery?.checkpoint ?? { revision: await sourceRevision(input.snapshot.baseline), files: input.snapshot.baseline };
        const repository = previous.repository ?? input.recovery?.repository ?? input.snapshot.repository;
        if (!view) view = input.recovery ? await this.#transport.load(input.recovery.id) : await this.#transport.create(client, input.snapshot);
        else {
          const summary = await this.#transport.summary(view.id);
          if (summary.version !== view.version) view = await this.#transport.load(view.id);
        }
        // Poll permissions/version every time; unchanged drafts need no repeated graph review.
        checked = JSON.stringify([input.snapshot, input.canApplyRemote, view.version, epoch, basis.revision, checkpoint.revision, repository]);
        if (!choices && this.#checked.get(client) === checked) return;
        const files = mergeWorkspaceSources(input.snapshot.name, basis.files, input.snapshot.files, view.draft.files, choices);
        const revision = await sourceRevision(files);
        const localCheckpointChanged = !sameSourceValue(input.snapshot.repository, repository) || await sourceRevision(input.snapshot.baseline) !== checkpoint.revision;
        const remoteCheckpointChanged = !sameSourceValue(view.repository, repository) || view.baseline.revision !== checkpoint.revision;
        const checkpointUnchanged = sameSourceValue(input.snapshot.repository, view.repository) && await sourceRevision(input.snapshot.baseline) === view.baseline.revision;
        if (superseded()) return;
        if (localCheckpointChanged && remoteCheckpointChanged && !checkpointUnchanged) throw new Error('The repository checkpoint changed in another client. Retain your draft and review the latest repository revision.');
        if (revision !== view.draft.revision || !checkpointUnchanged) {
          this.#set(client, { phase: 'saving', view, accepted: basis, checkpoint, ...(repository ? { repository } : {}) });
          const pin = localCheckpointChanged ? input.snapshot.repository : view.repository;
          view = await this.#transport.save(view.id, view.draft.revision, { name: view.name, files,
            baseline: localCheckpointChanged ? input.snapshot.baseline : view.baseline.files, ...(pin ? { repository: pin } : {}) });
        }
        if (superseded()) return;
        const latest = context.current();
        if (latest.client !== client) { this.#set(client, { phase: 'saved', view, accepted: view.draft, checkpoint: view.baseline, ...(view.repository ? { repository: view.repository } : {}) }); return undefined; }
        const unchanged = sameSourceValue(input.snapshot, latest.snapshot);
        const differs = view.name !== input.snapshot.name || !sameSourceValue(view.draft.files, input.snapshot.files) || !sameSourceValue(view.baseline.files, input.snapshot.baseline) || !sameSourceValue(view.repository, input.snapshot.repository);
        if (unchanged && differs && !latest.canApplyRemote && choices === undefined) {
          this.#set(client, { phase: 'updates', view, accepted: basis, checkpoint, ...(repository ? { repository } : {}) }); return undefined;
        }
        if (unchanged && differs) context.replace(view);
        // A response to an earlier edit never replaces a newer local edit.
        context.remember({ id: view.id, origin: input.origin, accepted: view.draft, checkpoint: view.baseline, ...(view.repository ? { repository: view.repository } : {}) });
        this.#set(client, { phase: unchanged ? 'saved' : 'saving', view, accepted: view.draft, checkpoint: view.baseline, ...(view.repository ? { repository: view.repository } : {}) });
      } catch (error) {
        if (superseded()) return;
        this.#set(client, { phase: error instanceof RepositoryConflicts ? 'conflict' : error instanceof WorkspaceMergeInvalid || error instanceof SharedWorkspaceError && error.status === 422 ? 'invalid' : 'offline', ...(view ? { view } : {}),
          ...(this.get(client).accepted ? { accepted: this.get(client).accepted } : {}),
          problem: error instanceof Error ? error.message : 'The shared workspace is unavailable. Your local draft is retained.',
          ...(error instanceof RepositoryConflicts || error instanceof WorkspaceMergeInvalid ? { conflicts: error.conflicts } : {}) });
      } finally {
        if (!superseded()) {
          if (checked && !['saving', 'offline'].includes(this.get(client).phase)) this.#checked.set(client, checked);
          else this.#checked.delete(client);
        }
      }
      return undefined;
  }
  adopt(client: string, view: WorkspaceView, context: WorkspaceClientContext): void {
    if (context.current().client !== client) return;
    this.#epochs.set(client, (this.#epochs.get(client) ?? 0) + 1);
    this.#checked.delete(client);
    context.replace(view); context.remember({ id: view.id, origin: context.current().origin, accepted: view.draft, checkpoint: view.baseline, ...(view.repository ? { repository: view.repository } : {}) });
    this.#set(client, { phase: 'saved', view, accepted: view.draft, checkpoint: view.baseline, ...(view.repository ? { repository: view.repository } : {}) });
  }
}
