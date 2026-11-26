import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Database, DesktopCloud, FolderOpen, GitBranch } from './icons.tsx';
import { FigmaIcon } from './service-icons.tsx';
import { useGitHubSession } from '../integrations/github/connect.tsx';
import type { RepositoryPin, WorkspaceView } from '../integrations/workspace/model.ts';
import { figmaStatus, githubStatus } from './lib/footer-status.ts';
import type { RepositoryOperation, ServiceStatus } from './lib/footer-status.ts';
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

function ServiceIndicator({ name, kind, icon, status }: { name: string; kind: string; icon: ReactNode; status: ServiceStatus }) {
  const state = status.connection.state !== 'good' ? 'bad' : status.sync.state === 'good' ? 'good' : 'pending';
  const message = status.connection.state === 'good' ? status.sync.label : status.connection.label;
  return <span className="workspace-status-service" data-service={kind} data-connection-status={status.connection.state} data-sync-status={status.sync.state}
    title={`${name}\n${message}`}>
    {icon}<span className="workspace-status-light" data-status={state} aria-hidden="true" />
    <span className="sr-only">{name}. {message}</span>
  </span>;
}

export function WorkspaceFooterStatus({ phase, connected, loading, localState, view, gitEnabled, repository, dirty, stale, operation, folder }: {
  phase: WorkspaceClientState['phase']; connected: boolean; loading: boolean;
  localState: RecoveryStatus['state'] | undefined; view: WorkspaceView | undefined;
  gitEnabled: boolean; repository: RepositoryPin | undefined; dirty: boolean; stale: boolean;
  operation: RepositoryOperation | undefined; folder: 'opened' | 'reconnect' | undefined;
}) {
  const online = useSyncExternalStore(subscribeNetwork, onlineSnapshot);
  const offline = !online || phase === 'offline';
  const connecting = !offline && (loading || !connected && phase === 'saving');
  const connectionLabel = offline ? 'Offline' : connecting ? 'Connecting…' : connected ? 'Connected' : 'Not connected';
  const connectionState = connecting ? 'pending' : connected && !offline ? 'good' : 'bad';
  const localLabel = localState === 'saved' ? 'Saved locally' : localState === 'saving' ? 'Saving locally…' : localState === 'failed' ? 'Recovery needs attention' : 'Local draft';
  const syncLabel = loading ? 'Opening workspace…' : offline ? (connected ? 'Workspace sync unavailable' : localLabel) :
    phase === 'saved' ? 'Saved to workspace' : phase === 'saving' ? 'Saving to workspace…' :
      phase === 'conflict' ? 'Conflicts need review' : phase === 'invalid' ? 'Draft needs attention' : phase === 'updates' ? 'Updates available' : localLabel;
  const syncState = loading ? 'pending' : offline && connected ? 'bad' : phase === 'saved' ? 'good' :
    phase === 'saving' ? 'pending' : ['conflict', 'invalid', 'updates'].includes(phase) || localState === 'failed' ? 'bad' :
      localState === 'saved' ? 'good' : 'pending';
  const session = useGitHubSession(gitEnabled);
  const [now, expire] = useState(Date.now);
  const deadlines = view?.documents.flatMap(file => file.connections?.map(device => device.expires) ?? (file.expires ? [file.expires] : [])) ?? [];
  const nextExpiry = Math.min(...deadlines.filter(deadline => deadline > now));
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return undefined;
    const timer = setTimeout(() => expire(Date.now()), Math.max(0, nextExpiry - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [nextExpiry]);
  const local: ServiceStatus = {
    connection: { state: localState === 'failed' ? 'bad' : localState ? 'good' : 'pending', label: localState === 'failed' ? "Couldn't save the local copy" : localState ? 'Available' : 'Not saved yet' },
    sync: { state: localState === 'failed' ? 'bad' : localState === 'saved' ? 'good' : 'pending', label: localState === 'saved' ? 'Saved' : localState === 'saving' ? 'Saving…' : 'Not saved yet' },
  };
  const git = githubStatus({ enabled: gitEnabled, online, session: session.data, error: session.error?.message, repository, dirty, stale,
    interrupted: !!view?.repositorySave && !view.repositorySave.result, operation });
  const figma = figmaStatus(view, phase, online, now);
  const disk: ServiceStatus = {
    connection: { state: folder === 'opened' ? 'good' : 'bad', label: folder === 'opened' ? 'Folder opened' : 'Reopen the source folder' },
    sync: { state: folder !== 'opened' || dirty ? 'bad' : 'good', label: folder !== 'opened' ? 'Reopen the source folder' : dirty ? 'Changes waiting to be saved' : 'No unsaved changes' },
  };
  return <>
    <span className="workspace-save-state copy-small" aria-live="polite">{syncLabel}</span>
    <div className="workspace-status-indicators">
      <ServiceIndicator name="Browser copy" kind="local" icon={<Database aria-hidden="true" />} status={local} />
      {folder && <ServiceIndicator name="Source folder" kind="folder" icon={<FolderOpen aria-hidden="true" />} status={disk} />}
      <ServiceIndicator name="Workspace" kind="workspace" icon={<DesktopCloud />} status={{ connection: { state: connectionState, label: connectionLabel }, sync: { state: syncState, label: syncLabel } }} />
      <ServiceIndicator name="GitHub" kind="github" icon={<GitBranch aria-hidden="true" />} status={git} />
      <ServiceIndicator name="Figma" kind="figma" icon={<FigmaIcon />} status={figma} />
    </div>
  </>;
}
