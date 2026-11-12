import type { Review } from '../lib/workspace.ts';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { describeTokenValue, TokenValue } from './token-value.tsx';

function diffClass(line: string) {
  if (line.startsWith('@@')) return 'text-muted-foreground';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100';
  if (line.startsWith('-') && !line.startsWith('---')) return 'bg-red-50 text-red-950 dark:bg-red-950 dark:text-red-100';
  return '';
}

export function ReviewChanges({ review, busy, error, notice, close, save, confirm = 'Apply changes' }: {
  review: Review | null; busy: boolean; error: string; notice?: string; close: () => void; save: () => void; confirm?: string;
}) {
  const importedValues = review?.importedValues;
  const fileChanges = review && <section aria-label="File changes" className="max-h-[55dvh] min-w-0 overflow-auto rounded-md border bg-muted/30 py-2 text-xs leading-6">
    <pre>
      {Array.from(review.diff.split('\n').entries(), ([lineNumber, line]) =>
        <span className={'block w-max min-w-full px-3 ' + diffClass(line)} key={lineNumber}>{line || ' '}</span>)}
    </pre>
  </section>;
  return <Dialog open={Boolean(review)} onOpenChange={(open) => { if (!open && !busy) close(); }}>
    {review && <DialogContent showCloseButton={!busy} className="max-h-[calc(100dvh-2rem)] overflow-auto sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{importedValues ? 'Review value changes' : 'Review changes'}</DialogTitle>
        <DialogDescription className="wrap-anywhere">{importedValues
          ? 'Applying these values keeps your other edits. To save or download, use Review changes.'
          : review.file}</DialogDescription>
      </DialogHeader>
      {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
      {importedValues ? <>
        <div className="max-h-[40dvh] overflow-auto rounded-md border">
          <Table aria-label="Token value changes" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="w-1/2">Token</TableHead>
                <TableHead scope="col" className="w-1/4">Before</TableHead>
                <TableHead scope="col" className="w-1/4">After</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {importedValues.map(({ path, before, after }) => {
                const showFullValues = describeTokenValue(before) === describeTokenValue(after);
                return <TableRow key={path}>
                  <TableCell className="font-mono text-xs wrap-anywhere whitespace-normal">{path}</TableCell>
                  {([['before', before], ['after', after]] as const).map(([side, value]) => <TableCell key={side}>
                    {showFullValues
                      ? <pre className="font-mono text-xs wrap-anywhere whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>
                      : <TokenValue value={value} authored swatch wrap />}
                  </TableCell>)}
                </TableRow>;
              })}
            </TableBody>
          </Table>
        </div>
        <details className="rounded-md border p-3 text-xs">
          <summary className="cursor-pointer">Show file changes</summary>
          <div className="mt-2">{fileChanges}</div>
        </details>
      </> : fileChanges}
      <details className="rounded-md border p-3 text-xs">
        <summary className="cursor-pointer">Values that change after following links ({review.impact.length})</summary>
        {review.impact.length > 0 && <ul className="mt-2 max-h-40 space-y-2 overflow-auto">
          {review.impact.map(({ path, before, after }) => <li className="wrap-anywhere font-mono" key={path}>
            <div className="font-medium">{path}</div>
            <div className="flex gap-2"><span className="text-muted-foreground">Before</span><TokenValue value={before} swatch wrap /></div>
            <div className="flex gap-2"><span className="text-muted-foreground">After</span><TokenValue value={after} swatch wrap /></div>
          </li>)}
        </ul>}
      </details>
      {error && <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription></Alert>}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={close}>{importedValues ? 'Cancel' : 'Back to edit'}</Button>
        <Button type="button" disabled={busy} onClick={save}>{busy ? 'Working…' : confirm}</Button>
      </DialogFooter>
    </DialogContent>}
  </Dialog>;
}
