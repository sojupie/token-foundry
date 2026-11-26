import { useSyncExternalStore } from 'react';
import { Link2, Link2Off, RefreshCw } from 'lucide-react';
import type { WorkspaceClientState } from '../integrations/workspace/session.ts';
import type { RecoveryStatus } from './workspace-recovery.tsx';

function subscribeNetwork(changed: () => void) {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

const onlineSnapshot = () => navigator.onLine;

export function WorkspaceFooterStatus({ phase, connected, loading, localState }: {
  phase: WorkspaceClientState['phase']; connected: boolean; loading: boolean;
  localState: RecoveryStatus['state'] | undefined;
}) {
  const online = useSyncExternalStore(subscribeNetwork, onlineSnapshot);
  const offline = !online || phase === 'offline';
  const connecting = !offline && (loading || !connected && phase === 'saving');
  const connectionLabel = offline ? 'Offline' : connecting ? 'Connecting…' : connected ? 'Connected to workspace' : 'Local workspace; not connected';
  const connectionState = connecting ? 'pending' : connected && !offline ? 'good' : 'bad';
  const localLabel = localState === 'saved' ? 'Saved locally' : localState === 'saving' ? 'Saving locally…' : localState === 'failed' ? 'Recovery needs attention' : 'Local draft';
  const syncLabel = loading ? 'Opening workspace…' : offline ? (connected ? 'Workspace sync unavailable' : localLabel) :
    phase === 'saved' ? 'Saved to workspace' : phase === 'saving' ? 'Saving to workspace…' :
      phase === 'conflict' ? 'Conflicts need review' : phase === 'invalid' ? 'Draft needs attention' : phase === 'updates' ? 'Updates available' : localLabel;
  const syncState = loading ? 'pending' : offline && connected ? 'bad' : phase === 'saved' ? 'good' :
    phase === 'saving' ? 'pending' : ['conflict', 'invalid', 'updates'].includes(phase) || localState === 'failed' ? 'bad' :
      localState === 'saved' ? 'good' : 'pending';
  return <>
    <span className="workspace-save-state copy-small" aria-live="polite">{syncLabel}</span>
    <div className="workspace-status-indicators">
      <span className="workspace-status-indicator" data-workspace-status="connection" title={'Workspace connection: ' + connectionLabel}>
        <span className="sr-only">Workspace connection: {connectionLabel}</span>
        {connectionState === 'good' ? <Link2 aria-hidden="true" /> : <Link2Off aria-hidden="true" />}
        <span className="workspace-status-light" data-status={connectionState} aria-hidden="true" />
      </span>
      <span className="workspace-status-indicator" data-workspace-status="sync" title={'Workspace sync: ' + syncLabel}>
        <span className="sr-only">Workspace sync: {syncLabel}</span>
        <RefreshCw aria-hidden="true" />
        <span className="workspace-status-light" data-status={syncState} aria-hidden="true" />
      </span>
    </div>
  </>;
}
