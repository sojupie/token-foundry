import type { Review } from '../lib/workspace.ts';
import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, List } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { describeTokenValue, TokenValue } from './token-value.tsx';

function diffClass(line: string) {
  if (line.startsWith('@@')) return 'text-muted-foreground';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100';
  if (line.startsWith('-') && !line.startsWith('---')) return 'bg-red-50 text-red-950 dark:bg-red-950 dark:text-red-100';
  return '';
}

function count(value: number, noun: string) {
  return value.toLocaleString('en') + ' ' + noun + (value === 1 ? '' : 's');
}

const FileDiff = memo(function FileDiff({ review }: { review: Review }) {
  return <section aria-label="File changes" className="max-h-[55dvh] min-w-0 overflow-auto rounded-md border bg-muted/30 py-2 text-xs leading-6">
    <pre>
      {Array.from(review.diff.split('\n').entries(), ([lineNumber, line]) =>
        <span className={'block w-max min-w-full px-3 ' + diffClass(line)} key={lineNumber}>{line || ' '}</span>)}
    </pre>
  </section>;
});

function ReviewDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="rounded-md border p-3 text-xs" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer">{label}</summary>
    {open && children}
  </details>;
}

function LinkImpact({ impact }: { impact: Review['impact'] }) {
  return <div className="mt-2 max-h-40 overflow-auto"><List className="space-y-2">
    {impact.map(({ path, before, after }) => <li className="wrap-anywhere font-mono" key={path}>
      <div className="font-medium">{path}</div>
      <div className="flex gap-2"><span className="text-muted-foreground">Before</span><TokenValue value={before} swatch wrap /></div>
      <div className="flex gap-2"><span className="text-muted-foreground">After</span><TokenValue value={after} swatch wrap /></div>
    </li>)}
  </List></div>;
}

export function ReviewChanges({ review, busy, error, notice, close, save, onClosed, confirm = 'Apply to workspace' }: {
  review: Review | null; busy: boolean; error: string; notice?: string; close: () => void; save: () => void;
  onClosed?: () => void; confirm?: string;
}) {
  // Keep the reviewed diff visible while the native dialog fades out.
  const [exitingReview, setExitingReview] = useState<Review | null>(null);
  const [recordsPage, setRecordsPage] = useState(0);
  if (review && review !== exitingReview) {
    setExitingReview(review);
    setRecordsPage(0);
  }
  const visibleReview = review ?? exitingReview;
  const importedValues = visibleReview?.importedValues;
  const structure = visibleReview?.structure;
  const bulk = visibleReview?.bulk;
  const records = importedValues ?? bulk?.records;
  const pageSize = 50;
  const firstRecord = recordsPage * pageSize;
  return <ActionDialog busy={busy} className="review-dialog" open={Boolean(review)} onOpenChange={(open) => { if (!open && !busy) close(); }}
    onAfterClose={() => { if (!review) setExitingReview(null); onClosed?.(); }}
    style={{ inlineSize: '48rem' }}
    title={structure?.title ?? (importedValues ? 'Review value changes' : bulk ? 'Review selected token edits' : 'Review changes')}
    description={importedValues
      ? 'Applying these values keeps your other edits. To save or download, use Review changes.'
      : bulk ? bulk.label + ' · ' + count(bulk.records.length, 'token') + ' in preview · ' + bulk.selected + ' selected'
        : structure ? undefined : visibleReview?.path || visibleReview?.file}
    actions={visibleReview && <>
      <Button variant="text" disabled={busy} data-dialog-close="">{importedValues ? 'Cancel' : 'Back to edit'}</Button>
      <Button disabled={busy || !!visibleReview.validationErrors?.length} onClick={save}>{busy ? 'Working…' : confirm}</Button>
    </>}>
    {visibleReview && <div className="grid min-w-0 gap-2">
      {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
      {visibleReview.uninspectedSources.length > 0 && <Alert>
        <AlertDescription>
          <p>Foundry needs valid JSON to check references in these files.</p>
          <ul className="mt-1 list-inside list-disc font-mono">
            {visibleReview.uninspectedSources.map(file => <li className="wrap-anywhere" key={file}>{file}</li>)}
          </ul>
        </AlertDescription>
      </Alert>}
      {structure && <div className="grid min-w-0 gap-1 text-sm">
        <p>{structure.tokens !== undefined && count(structure.tokens, 'token') + ' · '}{count(structure.files, 'file')} changed
          {structure.referencesUpdated ? ' · ' + count(structure.referencesUpdated, 'reference') + ' updated' : ''}</p>
        {structure.paths.length === 1 ? structure.paths.map(({ from, to }) =>
          <p key={from} className="wrap-anywhere"><code>{from}</code>{to && <> → <code>{to}</code></>}</p>) :
          <details className="min-w-0">
            <summary className="cursor-pointer">Affected paths</summary>
            <List className="mt-1 max-h-36 overflow-y-auto" aria-label="Affected paths">
              {structure.paths.map(({ from, to }) => <li key={from} className="wrap-anywhere">
                <code>{from}</code>{to && <> → <code>{to}</code></>}
              </li>)}
            </List>
          </details>}
      </div>}
      {records ? <>
        <div className="max-h-[40dvh] overflow-auto rounded-md border">
          <Table aria-label={bulk ? 'Selected token changes' : 'Token value changes'} className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="w-1/2">Token</TableHead>
                <TableHead scope="col" className="w-1/4">Before</TableHead>
                <TableHead scope="col" className="w-1/4">After</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.slice(firstRecord, firstRecord + pageSize).map(({ path, before, after }) => {
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
        {records.length > pageSize && <div className="flex items-center justify-end gap-2 text-sm">
          <Button size="xsmall" variant="text" disabled={!recordsPage} onClick={() => setRecordsPage(recordsPage - 1)}>Previous changes</Button>
          <span>{firstRecord + 1}–{Math.min(firstRecord + pageSize, records.length)} of {records.length}</span>
          <Button size="xsmall" variant="text" disabled={firstRecord + pageSize >= records.length} onClick={() => setRecordsPage(recordsPage + 1)}>Next changes</Button>
        </div>}
      </> : null}
      {visibleReview.inheritanceImpact.length > 0 && <ReviewDisclosure label={'Inherited paths affected (' + visibleReview.inheritanceImpact.length + ')'}>
        <List className="mt-2 max-h-40 overflow-auto font-mono">
          {visibleReview.inheritanceImpact.map(({ path, change }) => <li key={path} className="wrap-anywhere">{change} · {path}</li>)}
        </List>
      </ReviewDisclosure>}
      {!!visibleReview.validationErrors?.length && <Alert variant="destructive"><AlertDescription>
        <p>Resolve these errors before applying the change.</p>
        <List className="mt-2 max-h-40 overflow-auto">
          {[...new Set(visibleReview.validationErrors)].map(problem => <li key={problem} className="wrap-anywhere">{problem}</li>)}
        </List>
      </AlertDescription></Alert>}
      {visibleReview.contextImpact?.map(context => <ReviewDisclosure key={context.label}
        label={context.label + ' · ' + count(context.changes.length, 'token') + ' affected' +
          (context.matching ? ' · +' + count(context.matching.length, 'matching combination') : '')}>
        {context.matching && <ReviewDisclosure label="Matching combinations">
          <List className="mt-2 max-h-40 overflow-auto">
            {context.matching.map(label => <li className="wrap-anywhere" key={label}>{label}</li>)}
          </List>
        </ReviewDisclosure>}
        {context.errors.map(problem => <p key={problem} className="text-destructive">{problem}</p>)}
        {context.changes.map(change => change.afterProblem && <p key={change.path} className="text-destructive">
          {change.path} · {change.afterProblem}
        </p>)}
        <LinkImpact impact={context.changes} />
      </ReviewDisclosure>)}
      {visibleReview.typeImpact.length > 0 && <ReviewDisclosure label={'Effective type changes (' + visibleReview.typeImpact.length + ')'}>
        <List className="mt-2 max-h-40 overflow-auto font-mono">
          {visibleReview.typeImpact.map(({ path, before, after }) => <li key={path} className="wrap-anywhere">
            {path} · {before ?? 'No type'} → {after ?? 'No type'}
          </li>)}
        </List>
      </ReviewDisclosure>}
      <ReviewDisclosure label={'Resolved value changes (' + visibleReview.impact.length + ')'}>
        {visibleReview.impact.length > 0 && <LinkImpact impact={visibleReview.impact} />}
      </ReviewDisclosure>
      <ReviewDisclosure label="Show file changes">
        <div className="mt-2"><FileDiff review={visibleReview} /></div>
      </ReviewDisclosure>
      {error && <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription></Alert>}
    </div>}
  </ActionDialog>;
}
