import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { WorkspaceClient } from '../../integrations/workspace/session.ts';
import type { WorkspaceClientContext, WorkspaceClientInput } from '../../integrations/workspace/session.ts';
import type { WorkspaceClientState } from '../../integrations/workspace/session.ts';
import type { RepositoryChoice } from '../../lib/repository-merge.ts';
import type { SharedRecovery, WorkspaceInput, WorkspaceView } from '../../integrations/workspace/model.ts';
import { sameSourceValue } from '../../integrations/figma/contract.ts';

export function useSharedWorkspace({ client, snapshot, recovery, enabled, canApplyRemote, replace, remember }: {
  client: string; snapshot: WorkspaceInput; recovery: SharedRecovery | undefined; enabled: boolean; canApplyRemote: boolean;
  replace: (view: WorkspaceView) => void; remember: (link: SharedRecovery) => void;
}) {
  const [session] = useState(() => new WorkspaceClient());
  const latest = useRef({ client, snapshot, recovery, canApplyRemote, replace, remember });
  useLayoutEffect(() => { latest.current = { client, snapshot, recovery, canApplyRemote, replace, remember }; });
  const context = useMemo<WorkspaceClientContext>(() => ({
    current: (): WorkspaceClientInput => ({ client: latest.current.client, snapshot: latest.current.snapshot, canApplyRemote: latest.current.canApplyRemote,
      origin: window.location.origin, ...(latest.current.recovery ? { recovery: latest.current.recovery } : {}) }),
    replace: view => {
      latest.current = { ...latest.current, snapshot: { name: view.name, files: view.draft.files, baseline: view.baseline.files, ...(view.repository ? { repository: view.repository } : {}) } };
      latest.current.replace(view);
    },
    remember: link => { latest.current = { ...latest.current, recovery: link }; latest.current.remember(link); },
  }), []);
  const getSnapshot = useCallback(() => session.get(client), [client, session]);
  const state = useSyncExternalStore(session.subscribe, getSnapshot);
  const draftSaved = useMemo(() => state.phase === 'saved' && state.view !== undefined &&
    sameSourceValue(state.view.draft.files, snapshot.files) && sameSourceValue(state.view.baseline.files, snapshot.baseline) && sameSourceValue(state.view.repository, snapshot.repository), [snapshot, state.phase, state.view]);
  const phase: WorkspaceClientState['phase'] = state.phase === 'saved' && !draftSaved ? 'saving' : state.phase;
  const hosted = import.meta.env.DEV || import.meta.env.MODE === 'hosted';
  const populated = snapshot.files.length > 0;
  useEffect(() => {
    if (!enabled || !hosted || !populated) return undefined;
    let active = true; let checking = false; let failures = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      if (!active || checking || document.hidden) return;
      checking = true;
      try {
        await session.sync(client, context);
        failures = session.get(client).phase === 'offline' ? Math.min(5, failures + 1) : 0;
      } finally {
        checking = false;
        if (active) { clearTimeout(timer); timer = setTimeout(() => { void check(); }, Math.min(60_000, 3000 * 2 ** failures)); }
      }
    }
    function wake() { if (!document.hidden) { clearTimeout(timer); void check(); } }
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake);
    void check();
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, [client, context, enabled, hosted, populated, session]);
  const lastAttempt = useRef<WorkspaceInput | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !hosted || !populated) return undefined;
    const timer = setTimeout(() => {
      // Recovery acknowledgements can change identity without changing sources.
      if (sameSourceValue(lastAttempt.current, snapshot)) return;
      lastAttempt.current = snapshot; void session.sync(client, context);
    }, 250);
    return () => clearTimeout(timer);
  }, [client, context, enabled, hosted, populated, session, snapshot]);
  return { ...state, phase, draftSaved, hosted, sync: (choices?: RepositoryChoice[]) => session.sync(client, context, choices),
    current: () => session.get(client),
    adopt: (view: WorkspaceView) => session.adopt(client, view, context) };
}
