import { useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, TextField } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import { leafName, parentPath } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { errorMessage, requireValue } from '../lib/json.ts';
import type { Move } from '../lib/structure.ts';
import type { Review } from '../lib/workspace.ts';
import { FolderTree } from './folder-tree.tsx';

export type MoveOperation = 'rename' | 'move' | 'duplicate';

export function MoveDialog({ paths, operation, graph, close, prepare, review, reviewing }: {
  paths: readonly string[]; operation: MoveOperation; graph: DocumentGraph; reviewing: boolean; close: () => void;
  prepare: (moves: Move[]) => Review; review: (pending: Review) => void;
}) {
  const single = paths.length === 1 ? paths[0] : undefined;
  const rename = operation === 'rename';
  const duplicate = operation === 'duplicate';
  const named = rename || duplicate && !!single;
  const label = single && graph.groups.has(single) ? 'Group name' : 'Token name';
  const [destination, setDestination] = useState<string | undefined>(single ? parentPath(single) : duplicate ? undefined : '');
  const [name, setName] = useState(() => {
    if (!single) return '';
    if (!duplicate) return leafName(single);
    const parent = parentPath(single);
    const base = (leafName(single) === '$root' ? 'root' : leafName(single)) + '-copy';
    let candidate = base;
    let suffix = 2;
    while (graph.tokens.has([parent, candidate].filter(Boolean).join('.')) ||
      graph.groups.has([parent, candidate].filter(Boolean).join('.'))) candidate = base + '-' + suffix++;
    return candidate;
  });
  const [error, setError] = useState('');
  const allowed = useMemo(() => new Set(rename ? [] : [...graph.groups.keys()].filter((group) =>
    !paths.some((path) => group === path || group.startsWith(path + '.')))), [graph, paths, rename]);
  const action = rename ? 'Rename' : duplicate ? 'Duplicate' : 'Move';
  const title = action + (single ? graph.groups.has(single) ? ' group' : ' token' : ' selected tokens');

  return <ActionDialog open={!reviewing} onOpenChange={open => { if (!open && !reviewing) close(); }} title={title}
    description={single ?? paths.length + ' tokens selected'}>
      <form noValidate className="grid gap-4" onSubmit={(event) => {
        event.preventDefault();
        try {
          if (named && (!name.trim() || /[.{}]/u.test(name))) throw new Error('Enter a name without periods or braces.');
          const occupied = new Set([...graph.tokens.keys(), ...graph.groups.keys()]);
          const moves = paths.flatMap(path => {
            const target = destination ?? parentPath(path);
            const group = requireValue(graph.groups.get(target), 'destination group');
            const leaf = named ? name.trim() : leafName(path);
            let to = [target, leaf].filter(Boolean).join('.');
            if (duplicate && !single && occupied.has(to)) {
              const base = [target, (leaf === '$root' ? 'root' : leaf) + '-copy'].filter(Boolean).join('.');
              to = base;
              let suffix = 2;
              while (occupied.has(to)) to = base + '-' + suffix++;
            }
            occupied.add(to);
            if (to === path) return [];
            const source = graph.tokens.get(path)?.file ?? graph.groups.get(path)?.files.keys().next().value;
            const file = source && group.files.has(source) ? source : group.files.size === 1 ? group.files.keys().next().value : undefined;
            if (!file) throw new Error('Choose a more specific destination group.');
            return [{ path, to, file }];
          });
          review(prepare(moves));
        } catch (failure) { setError(errorMessage(failure)); }
      }}>
        {named && <TextField label={label} data-initial-focus value={name} onChange={(event) => setName(event.target.value)} required />}
        {!rename && <div className="grid gap-2">
          <p className="text-sm font-medium">Destination group</p>
          <div className="max-h-[45vh] overflow-auto rounded-md border">
            <FolderTree {...{ graph, allowed }} current={destination ?? ''} select={setDestination} label="Destination group" rootLabel="Top level" />
          </div>
          <p className="wrap-anywhere text-xs text-muted-foreground">{destination === undefined ? 'Same groups as the originals' : destination || 'Top level'}</p>
          {duplicate && !single && destination !== undefined && <Button type="button" variant="text" onClick={() => setDestination(undefined)}>
            Use original groups
          </Button>}
        </div>}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="text" data-dialog-close="">Cancel</Button>
          <Button type="submit" disabled={named ? !name.trim() || destination === parentPath(single ?? '') && name.trim() === leafName(single ?? '') :
            !duplicate && paths.every(path => destination === parentPath(path))}>{'Review ' + operation}</Button>
        </div>
      </form>
  </ActionDialog>;
}
