import type { Review } from '../lib/workspace.ts';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

function diffClass(line: string) {
  if (line.startsWith('@@')) return 'text-muted-foreground';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100';
  if (line.startsWith('-') && !line.startsWith('---')) return 'bg-red-50 text-red-950 dark:bg-red-950 dark:text-red-100';
  return '';
}

export function ReviewChanges({ review, busy, error, notice, close, save, confirm = 'Apply changes' }: {
  review: Review | null; busy: boolean; error: string; notice?: string; close: () => void; save: () => void; confirm?: string;
}) {
  return <Dialog open={Boolean(review)} onOpenChange={(open) => { if (!open && !busy) close(); }}>
    {review && <DialogContent showCloseButton={!busy} className="max-h-[calc(100dvh-2rem)] overflow-auto sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Review changes</DialogTitle>
        <DialogDescription className="wrap-anywhere font-mono">{review.file}</DialogDescription>
      </DialogHeader>
      {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
      <section aria-label="Proposed file diff" className="max-h-[55dvh] min-w-0 overflow-auto rounded-md border bg-muted/30 py-2 text-xs leading-6">
        <pre>
        {Array.from(review.diff.split('\n').entries(), ([lineNumber, line]) =>
          <span className={'block w-max min-w-full px-3 ' + diffClass(line)} key={lineNumber}>{line || ' '}</span>)}
        </pre>
      </section>
      <details className="rounded-md border p-3 text-xs">
        <summary className="cursor-pointer">{review.impact.length} resolved {review.impact.length === 1 ? 'value' : 'values'} changed</summary>
        {review.impact.length > 0 && <ul className="mt-2 max-h-40 space-y-2 overflow-auto">
          {review.impact.map(({ path, before, after }) => <li className="wrap-anywhere font-mono" key={path}>
            <div className="font-medium">{path}</div>
            <div><span className="text-muted-foreground">Before </span>{JSON.stringify(before) ?? '—'}</div>
            <div><span className="text-muted-foreground">After </span>{JSON.stringify(after) ?? '—'}</div>
          </li>)}
        </ul>}
      </details>
      {error && <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription></Alert>}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={close}>Back to edit</Button>
        <Button type="button" disabled={busy} onClick={save}>{busy ? 'Working…' : confirm}</Button>
      </DialogFooter>
    </DialogContent>}
  </Dialog>;
}
