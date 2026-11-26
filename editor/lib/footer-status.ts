import type { GitHubSession } from '../../integrations/github/connect.tsx';
import type { WorkspaceView, RepositoryPin } from '../../integrations/workspace/model.ts';
import type { WorkspaceClientState } from '../../integrations/workspace/session.ts';

export interface StatusLight { state: 'good' | 'bad' | 'pending'; label: string }
export interface ServiceStatus { connection: StatusLight; sync: StatusLight }
export interface RepositoryOperation { client: string; phase: 'saving' | 'checking' | 'failed'; problem?: string }
const light = (state: StatusLight['state'], label: string): StatusLight => ({ state, label });

export function githubStatus({ enabled, online, session, error, repository, dirty, stale, interrupted, operation }: {
  enabled: boolean; online: boolean; session: GitHubSession | undefined; error: string | undefined;
  repository: RepositoryPin | undefined; dirty: boolean; stale: boolean; interrupted: boolean;
  operation: RepositoryOperation | undefined;
}): ServiceStatus {
  if (!enabled) return { connection: light('pending', 'Not available in this editor'), sync: light('pending', 'No repository selected') };
  const unavailable = !online ? 'Offline' : error ? 'Connection unavailable' :
    session?.state === 'signed-out' ? 'Sign in to connect' : session?.state === 'forbidden' ? 'Access denied' : undefined;
  if (unavailable) return { connection: light('bad', unavailable), sync: light('pending', repository ? 'Sign in to check for changes' : 'Choose a repository') };
  if (!session || session.state !== 'connected') return { connection: light('pending', 'Checking sign-in…'), sync: light('pending', 'Checking for changes…') };
  if (repository && !session.repositories.includes(repository.repository)) return { connection: light('bad', 'No access to this repository'), sync: light('bad', 'Repository access required') };
  const connection = light('good', 'Signed in as @' + session.login + (repository ? ' · ' + repository.repository : ''));
  const sync = !repository ? light('pending', 'Choose a repository') :
    operation?.phase === 'failed' ? light('bad', 'Save failed. Try again.') :
      operation ? light('pending', operation.phase === 'saving' ? 'Saving changes…' : 'Checking for repository changes…') :
        stale ? light('bad', 'Review the latest repository changes') :
          interrupted ? light('bad', 'Resume the unfinished save') :
            dirty ? light('bad', 'Changes waiting to be saved') :
              light('good', repository.pullRequest ? 'All changes saved to the merge request' : 'No changes since opening the repository');
  return { connection, sync };
}

export function figmaStatus(view: WorkspaceView | undefined, phase: WorkspaceClientState['phase'], online: boolean, now: number): ServiceStatus {
  if (!view) return { connection: light('pending', 'Not connected'), sync: light('pending', 'Start a shared workspace to connect') };
  const connections = view.documents.flatMap(file => file.connections ?? (file.expires ? [{ id: file.id, offered: file.offered, expires: file.expires, baseline: file.baseline, acknowledged: file.acknowledged === true }] : []))
    .filter(connection => connection.expires > now);
  const count = connections.length;
  const paired = `${count} paired ${count === 1 ? 'device' : 'devices'}`;
  if (!online || phase === 'offline') return { connection: light('pending', "Can't check while offline"), sync: light('pending', "Can't check while offline") };
  const connection = light(count ? 'good' : 'bad', count ? paired : 'Reconnect to sync');
  const current = connections.filter(device => device.acknowledged && device.baseline === view.draft.revision).length;
  const sync = view.incoming.length ? light('bad', 'Changes need review') :
    phase === 'conflict' || phase === 'invalid' ? light('bad', 'Review workspace changes to sync') :
      !count ? light('pending', 'No paired devices') :
        phase === 'saving' || phase === 'updates' ? light('pending', 'Waiting for workspace updates') :
          current === count ? light('good', count === 1 ? 'Up to date' : 'Up to date on all devices') :
            light('bad', current ? `${current} of ${count} devices up to date` : 'Waiting for updates');
  return { connection, sync };
}
