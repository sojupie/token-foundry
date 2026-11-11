import type { FileChange, Workspace } from '../../lib/workspace.ts';

export interface WorkspaceConnection {
  workspace: Workspace;
  submit: (changes: FileChange[]) => Promise<{ status: 'submitted'; url: string } | { status: 'stale' }>;
  refresh: () => Promise<WorkspaceConnection>;
}

export interface WorkspaceConnectorProps {
  disabled: boolean;
  canReplace: () => boolean;
  connect: (connection: WorkspaceConnection) => void;
}
