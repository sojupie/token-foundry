import { useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { errorMessage } from '../lib/json.ts';
import type { Move } from '../lib/structure.ts';

export function MoveDialog({ path, originalFile, files, disabled, review }: {
  path: string; originalFile: string; files: readonly string[]; disabled: boolean; review: (move: Move) => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(originalFile);
  const [to, setTo] = useState(path);
  const [error, setError] = useState('');

  return <Dialog open={open} onOpenChange={(next) => {
    if (next) {
      setFile(originalFile);
      setTo(path);
      setError('');
    }
    setOpen(next);
  }}>
    <DialogTrigger asChild>
      <Button type="button" size="sm" variant="ghost" disabled={disabled}><ArrowRightLeft aria-hidden="true" /> Move or rename</Button>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Move or rename</DialogTitle>
        <DialogDescription className="wrap-anywhere font-mono">{path}</DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={(event) => {
        event.preventDefault();
        try {
          review({ path, to: to.trim(), file });
          setOpen(false);
        } catch (failure) {
          setError(errorMessage(failure));
        }
      }}>
        <div className="grid gap-2">
          <Label htmlFor="move-file">Destination file</Label>
          <NativeSelect id="move-file" value={file} onChange={(event) => setFile(event.target.value)}>
            {files.map((entry) => <NativeSelectOption key={entry} value={entry}>{entry}</NativeSelectOption>)}
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="move-path">New path</Label>
          <Input id="move-path" value={to} onChange={(event) => setTo(event.target.value)} required />
        </div>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" disabled={!to.trim() || (to.trim() === path && file === originalFile)}>Review move</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
