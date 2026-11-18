import { useId, useMemo, useState } from 'react';
import { Button, TextField, Select, SelectOption } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { leafName } from '../lib/document.ts';
import { errorMessage } from '../lib/json.ts';
import type { ClipboardEntry } from '../lib/structure.ts';
import { reviewPaste } from '../lib/workspace.ts';
import type { Review, Workspace } from '../lib/workspace.ts';
import { FolderTree } from './folder-tree.tsx';

export function PasteDialog({ workspace, entries, group, reviewing, close, review }: {
  workspace: Workspace;
  entries: readonly ClipboardEntry[];
  group: string;
  reviewing: boolean;
  close: () => void;
  review: (next: Review) => void;
}) {
  const { graph } = workspace;
  const allowed = useMemo(() => new Set([...graph.groups].filter(([, item]) => item.files.size).map(([path]) => path)), [graph]);
  const [destination, setDestination] = useState(allowed.has(group) ? group : '');
  const [chosenFile, setFile] = useState('');
  const [named, setNamed] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const id = useId();
  const files = [...graph.groups.get(destination)?.files.keys() ?? []];
  const shared = entries[0]?.fragments[0]?.file;
  const file = files.includes(chosenFile) ? chosenFile : shared && files.includes(shared) ? shared : files[0] ?? '';
  const used = new Set<string>();
  const inGroup = (name: string) => destination ? destination + '.' + name : name;
  const defaults = entries.map((entry, index) => {
    const base = leafName(entry.path);
    const alternate = (base === '$root' ? 'root' : base) + '-copy';
    let suffix = 2;
    let name = base === '$root' && !destination ? 'root' : base;
    const manual = named[index];
    if (manual !== undefined) {
      used.add(inGroup(manual.trim()));
      return manual;
    }
    while (used.has(inGroup(name)) || graph.tokens.has(inGroup(name)) || graph.groups.has(inGroup(name))) {
      name = suffix === 2 && name !== alternate ? alternate : alternate + '-' + suffix++;
    }
    used.add(inGroup(name));
    return name;
  });
  return <ActionDialog open={!reviewing} title="Paste tokens or groups"
    description={entries.length + (entries.length === 1 ? ' copied entry' : ' copied entries')}
    onOpenChange={open => { if (!open && !reviewing) close(); }}>
    <form className="grid gap-3" onSubmit={event => {
      event.preventDefault();
      try {
        const moves = entries.map((entry, index) => {
          const name = defaults[index]?.trim();
          if (!name || /[.{}]/u.test(name)) throw new Error('Enter valid destination names.');
          return { path: entry.path, to: inGroup(name), file };
        });
        review(reviewPaste(workspace, entries, moves));
      } catch (failure) {
        setError(errorMessage(failure));
      }
    }}>
      <div className="grid gap-1.5">
        <p className="copy-body copy-emphasis">Destination group</p>
        <div className="max-h-[30vh] overflow-auto rounded-md border">
          <FolderTree groups={graph.groups} allowed={allowed} current={destination} select={path => {
            setDestination(path); setFile(''); setError('');
          }} label="Paste destination group" rootLabel="Top level" />
        </div>
      </div>
      {files.length > 1 && <div className="grid gap-1 copy-body">
        <label htmlFor={id + '-file'}>Destination file</label>
        <Select id={id + '-file'} value={file} onChange={event => setFile(event.target.value)}>
          {files.map(path => <SelectOption key={path} value={path}>{path}</SelectOption>)}
        </Select>
        {entries.some(entry => entry.fragments.length > 1 && entry.fragments.every(fragment => files.includes(fragment.file))) &&
          <p className="copy-small tone-supporting">Groups that span these files keep their file boundaries.</p>}
      </div>}
      <ul className="grid max-h-[32vh] gap-2 overflow-auto py-1">
        {entries.map((entry, index) => <li key={entry.path}>
          <TextField label={entries.length === 1 ? entry.group ? 'Group name' : 'Token name' : 'Name for ' + entry.path}
            data-initial-focus={index === 0 ? '' : undefined} required value={defaults[index] ?? ''}
            supporting={entry.path} onChange={event => { setNamed({ ...named, [index]: event.target.value }); setError(''); }} />
        </li>)}
      </ul>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" data-dialog-close="" variant="text">Cancel</Button>
        <Button type="submit" disabled={!file}>Review paste</Button>
      </div>
    </form>
  </ActionDialog>;
}
