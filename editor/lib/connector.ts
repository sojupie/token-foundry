import type { FileChange, Workspace } from '../../lib/workspace.ts';
import type { RepositorySnapshot } from '../../integrations/github/contract.ts';
import type { WorkspaceView } from '../../integrations/workspace/model.ts';

export interface WorkspaceConnection {
  workspace: Workspace;
  root: string;
  branch?: string;
  pullRequest?: string;
  snapshot?: RepositorySnapshot;
  submit: (changes: FileChange[], workspace?: string) => Promise<{ status: 'submitted'; url: string; connection?: WorkspaceConnection; shared?: WorkspaceView } | { status: 'stale' }>;
  refresh: () => Promise<WorkspaceConnection>;
}

export interface WorkspaceConnectorProps {
  presentation?: 'menu' | 'workspace';
  disabled: boolean;
  canReplace: (proceed: () => void, cancel?: () => void) => void;
  connect: (connection: WorkspaceConnection) => void;
}
