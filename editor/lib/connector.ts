import type { FileChange, Workspace } from '../../lib/workspace.ts';

export type SubmitWorkspace = (changes: FileChange[]) => Promise<string>;

export interface WorkspaceConnectorProps {
  disabled: boolean;
  canReplace: () => boolean;
  connect: (workspace: Workspace, submit: SubmitWorkspace) => void;
}
