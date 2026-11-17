import { useState } from 'react';
import { Button, TextField } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { errorMessage } from '../lib/json.ts';
import { isResolverFile } from '../lib/resolver.ts';
import { reviewCreateSource, reviewSourcePath } from '../lib/workspace.ts';
import type { Review, Workspace } from '../lib/workspace.ts';

export type SourceFileAction = { kind: 'create' } | { kind: 'relocate' | 'remove'; file: string };

export function SourceFileDialog({ action, workspace, root, reviewing, close, review }: {
  action: SourceFileAction;
  workspace: Workspace;
  root: string;
  reviewing: boolean;
  close: () => void;
  review: (next: Review) => void;
}) {
  const prefix = root ? root + '/' : '';
  const [path, setPath] = useState(action.kind === 'create' ? '' : action.file.slice(prefix.length));
  const [error, setError] = useState('');
  const title = action.kind === 'create' ? 'New source file' : action.kind === 'relocate' ? 'Rename or move source file' : 'Remove source file';
  return <ActionDialog open={!reviewing} title={title} description={action.kind === 'create' ? undefined : action.file}
    onOpenChange={open => { if (!open) close(); }}>
    <form className="grid gap-3" onSubmit={event => {
      event.preventDefault();
      try {
        if (action.kind === 'remove') {
          review(reviewSourcePath(workspace, action.file));
          return;
        }
        const relative = path.trim();
        if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..' ||
          (/[\\:*?"<>|]/u.test(part) || Array.from(part).some(char => char.charCodeAt(0) < 32)))) throw new Error('Enter a valid relative file path.');
        if (root && relative.split('/').some(part => !/^[a-z\d_-][a-z\d_.-]*$/iu.test(part))) {
          throw new Error('Repository paths use letters, numbers, dots, hyphens or underscores.');
        }
        const destination = prefix + relative;
        if (action.kind === 'create') {
          if (!/(?:^|\/)(?:tokens\.json|[^/]+\.tokens(?:\.json)?)$/iu.test(relative)) {
            throw new Error('Name the file tokens.json or use a .tokens.json suffix.');
          }
          review(reviewCreateSource(workspace, destination, '{}\n'));
        } else {
          const pattern = /(?:^|\/)(?:tokens\.json|[^/]+\.tokens(?:\.json)?)$|\.resolver\.json$/iu;
          if (!pattern.test(relative) && !(relative.toLowerCase().endsWith('.json') && workspace.files.some(isResolverFile))) {
            throw new Error('Choose a token or Resolver file name.');
          }
          if (/\.resolver\.json$/iu.test(action.file) !== /\.resolver\.json$/iu.test(relative)) {
            throw new Error('Keep the file’s Resolver or token document format.');
          }
          review(reviewSourcePath(workspace, action.file, destination));
        }
      } catch (failure) {
        setError(errorMessage(failure));
      }
    }}>
      {action.kind !== 'remove' && <TextField label="File path" required data-initial-focus value={path}
        placeholder="colors/brand.tokens.json" supporting={root ? 'Relative to ' + root : undefined}
        onChange={event => { setPath(event.target.value); setError(''); }} />}
      {action.kind === 'remove' && <p className="text-sm">Review the file removal and any references affected by it.</p>}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" data-initial-focus={action.kind === 'remove' ? '' : undefined} data-dialog-close="" variant="text">Cancel</Button>
        <Button type="submit">{action.kind === 'remove' ? 'Review removal' : 'Review file change'}</Button>
      </div>
    </form>
  </ActionDialog>;
}
