import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { leafName, parentPath } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { errorMessage, requireValue } from '../lib/json.ts';
import type { Move } from '../lib/structure.ts';
import { FolderTree } from './folder-tree.tsx';

export function MoveDialog({ paths, rename, graph, close, review }: {
  paths: readonly string[]; rename: boolean; graph: DocumentGraph; close: () => void; review: (moves: Move[]) => void;
}) {
  const single = paths.length === 1 ? paths[0] : undefined;
  const [destination, setDestination] = useState(single ? parentPath(single) : '');
  const [name, setName] = useState(single ? leafName(single) : '');
  const [error, setError] = useState('');
  const allowed = new Set([...graph.groups.keys()].filter((group) =>
    !paths.some((path) => group === path || group.startsWith(path + '.'))));
  const title = rename ? 'Rename group' : single ? 'Move ' + (graph.groups.has(single) ? 'group' : 'token') : 'Move selected tokens';

  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="wrap-anywhere">{single ?? paths.length + ' tokens selected'}</DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={(event) => {
        event.preventDefault();
        try {
          if (rename && (!name.trim() || /[.{}]/u.test(name))) throw new Error('Enter a name without periods or braces.');
          const group = requireValue(graph.groups.get(destination), 'destination group');
          const moves = paths.flatMap((path) => {
            const leaf = rename ? name.trim() : leafName(path);
            const to = destination ? destination + '.' + leaf : leaf;
            if (to === path) return [];
            const source = graph.tokens.get(path)?.file ?? graph.groups.get(path)?.files.keys().next().value;
            const file = source && group.files.has(source) ? source : group.files.size === 1 ? group.files.keys().next().value : undefined;
            if (!file) throw new Error('Choose a more specific destination group.');
            return [{ path, to, file }];
          });
          review(moves);
          close();
        } catch (failure) { setError(errorMessage(failure)); }
      }}>
        {rename ? <div className="grid gap-2">
          <Label htmlFor="group-name">Group name</Label>
          <Input id="group-name" value={name} onChange={(event) => setName(event.target.value)} required />
        </div> : <div className="grid gap-2">
          <p className="text-sm font-medium">Destination group</p>
          <div className="max-h-[45vh] overflow-auto rounded-md border">
            <FolderTree {...{ graph, allowed }} current={destination} select={setDestination} label="Destination group" rootLabel="Top level" />
          </div>
          <p className="wrap-anywhere text-xs text-muted-foreground">{destination || 'Top level'}</p>
        </div>}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>Cancel</Button>
          <Button type="submit" disabled={rename ? !name.trim() || name.trim() === leafName(single ?? '') :
            paths.every((path) => destination === parentPath(path))}>{rename ? 'Review rename' : 'Review move'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
