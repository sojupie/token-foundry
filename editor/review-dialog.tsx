import type { Review } from '../lib/workspace.ts';
import { memo, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, List } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '../lib/json.ts';
import type { RenderData } from './lib/render-data.ts';
import { reviewDiffInWorker } from './lib/workspace-review.ts';
import { describeTokenValue, TokenValue } from './token-value.tsx';

function diffClass(line: string) {
  if (line.startsWith('@@')) return 'tone-supporting';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-added';
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-removed';
  return '';
}

function count(value: number, noun: string) {
  return value.toLocaleString('en') + ' ' + noun + (value === 1 ? '' : 's');
}

const FileDiff = memo(function FileDiff({ data }: { data: RenderData<Review | null> }) {
  const review = data.value;
  const [result, setResult] = useState<{ lines: string[] } | { error: string }>();
  useEffect(() => {
    if (!review) return undefined;
    const controller = new AbortController();
    async function load() {
      if (!review) return;
      try {
        const diff = await reviewDiffInWorker(review, controller.signal);
        if (!controller.signal.aborted) setResult({ lines: diff.split('\n') });
      } catch (failure) {
        if (!controller.signal.aborted) setResult({ error: errorMessage(failure) });
      }
    }
    void load();
    return () => controller.abort();
  }, [review]);
  if (!result) return <output>Preparing file changes…</output>;
  if ('error' in result) return <Alert variant="destructive"><AlertDescription>{result.error}</AlertDescription></Alert>;
  return <ReviewPage items={result.lines} pageSize={250} label="file changes" render={(lines, offset) =>
    <section aria-label="File changes" className="max-h-[55dvh] min-w-0 overflow-auto rounded-md border muted-surface-subtle py-2 copy-small diff-line-spacing">
      <pre>
        {Array.from(lines.entries(), ([lineNumber, line]) =>
          <span className={'block w-max min-w-full px-3 ' + diffClass(line)} key={offset + lineNumber}>{line || ' '}</span>)}
      </pre>
    </section>} />;
});

function ReviewPage<T>({ items, label, pageSize = 50, render }: {
  items: readonly T[];
  label: string;
  pageSize?: number;
  render: (items: readonly T[], offset: number) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(items.length / pageSize) - 1);
  const shown = Math.min(page, last);
  const offset = shown * pageSize;
  return <>
    {render(items.slice(offset, offset + pageSize), offset)}
    {last > 0 && <div className="mt-2 flex items-center justify-end gap-1 copy-small">
      <Button size="xsmall" variant="text" aria-label={'Previous ' + label} disabled={!shown}
        onClick={() => setPage(shown - 1)}>Previous</Button>
      <span>{(offset + 1).toLocaleString()}–{Math.min(offset + pageSize, items.length).toLocaleString()} of {items.length.toLocaleString()}</span>
      <Button size="xsmall" variant="text" aria-label={'Next ' + label} disabled={shown === last}
        onClick={() => setPage(shown + 1)}>Next</Button>
    </div>}
  </>;
}

function ReviewDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="rounded-md border p-3 copy-small" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer">{label}</summary>
    {open && children}
  </details>;
}

function LinkImpact({ impact }: { impact: readonly (Review['impact'][number] & { afterProblem?: string | undefined })[] }) {
  return <ReviewPage items={impact} label="affected tokens" render={entries =>
    <div className="mt-2 max-h-40 overflow-auto"><List className="space-y-2">
      {entries.map(({ path, before, after, afterProblem }) => <li className="wrap-anywhere code-text" key={path}>
        <div className="copy-emphasis">{path}</div>
        <div className="flex gap-2"><span className="tone-supporting">Before</span><TokenValue value={before} swatch wrap /></div>
        <div className="flex gap-2"><span className="tone-supporting">After</span>
          {afterProblem ? <span className="tone-error">{afterProblem}</span> : <TokenValue value={after} swatch wrap />}
        </div>
      </li>)}
    </List></div>} />;
}

export function ReviewChanges({ data, busy, error, notice, close, save, onClosed, confirm = 'Apply to workspace' }: {
  data: RenderData<Review | null>; busy: boolean; error: string; notice?: string; close: () => void; save: () => void;
  onClosed?: () => void; confirm?: string;
}) {
  // Keep the reviewed diff visible while the native dialog fades out.
  const review = data.value;
  const [exitingReview, setExitingReview] = useState<RenderData<Review | null>>();
  const [recordsPage, setRecordsPage] = useState(0);
  if (review && data !== exitingReview) {
    setExitingReview(data);
    setRecordsPage(0);
  }
  const visibleData = review ? data : exitingReview;
  const visibleReview = visibleData?.value;
  const importedValues = visibleReview?.importedValues;
  const structure = visibleReview?.structure;
  const bulk = visibleReview?.bulk;
  const records = importedValues ?? bulk?.records;
  const pageSize = 50;
  const firstRecord = recordsPage * pageSize;
  return <ActionDialog busy={busy} className="review-dialog" open={Boolean(review)} onOpenChange={(open) => { if (!open && !busy) close(); }}
    onAfterClose={() => { if (!review) setExitingReview(undefined); onClosed?.(); }}
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
          <ul className="mt-1 list-inside list-disc code-text">
            {visibleReview.uninspectedSources.map(file => <li className="wrap-anywhere" key={file}>{file}</li>)}
          </ul>
        </AlertDescription>
      </Alert>}
      {structure && <div className="grid min-w-0 gap-1 copy-body">
        <p>{structure.tokens !== undefined && count(structure.tokens, 'token') + ' · '}{count(structure.files, 'file')} changed
          {structure.referencesUpdated || structure.destination ? ' · ' + count(structure.referencesUpdated ?? 0, 'reference') + ' updated' : ''}</p>
        {structure.destination && <p className="wrap-anywhere">Destination: {structure.destination.set} / {structure.destination.group || 'Top level'}
          <span className="block copy-small tone-supporting">{structure.destination.file}</span>
        </p>}
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
      {!!structure?.references?.length && <ReviewDisclosure label={'References rewritten (' + structure.references.length + ')'}>
        <ReviewPage items={structure.references} label="rewritten references" render={(items, offset) =>
          <ul className="mt-2 max-h-40 space-y-2 overflow-auto">
            {items.map(({ file, before, after }, index) => <li key={JSON.stringify([file, before, after, offset + index])} className="wrap-anywhere">
              <span className="block tone-supporting">{file}</span><code>{before}</code> → <code>{after}</code>
            </li>)}
          </ul>} />
      </ReviewDisclosure>}
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
                  <TableCell className="code-text copy-small wrap-anywhere whitespace-normal">{path}</TableCell>
                  {([['before', before], ['after', after]] as const).map(([side, value]) => <TableCell key={side}>
                    {showFullValues
                      ? <pre className="code-text copy-small wrap-anywhere whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>
                      : <TokenValue value={value} authored swatch wrap />}
                  </TableCell>)}
                </TableRow>;
              })}
            </TableBody>
          </Table>
        </div>
        {records.length > pageSize && <div className="flex items-center justify-end gap-2 copy-body">
          <Button size="xsmall" variant="text" disabled={!recordsPage} onClick={() => setRecordsPage(recordsPage - 1)}>Previous changes</Button>
          <span>{firstRecord + 1}–{Math.min(firstRecord + pageSize, records.length)} of {records.length}</span>
          <Button size="xsmall" variant="text" disabled={firstRecord + pageSize >= records.length} onClick={() => setRecordsPage(recordsPage + 1)}>Next changes</Button>
        </div>}
      </> : null}
      {visibleReview.inheritanceImpact.length > 0 && <ReviewDisclosure label={'Inherited paths affected (' + visibleReview.inheritanceImpact.length + ')'}>
        <List className="mt-2 max-h-40 overflow-auto code-text">
          {visibleReview.inheritanceImpact.map(({ path, change }) => <li key={path} className="wrap-anywhere">{change} · {path}</li>)}
        </List>
      </ReviewDisclosure>}
      {!!visibleReview.validationErrors?.length && <Alert variant="destructive"><AlertDescription>
        <p>Resolve these errors before applying the change.</p>
        <ReviewPage items={[...new Set(visibleReview.validationErrors)]} label="validation errors" render={items =>
          <List className="mt-2 max-h-40 overflow-auto">
            {items.map(problem => <li key={problem} className="wrap-anywhere">{problem}</li>)}
          </List>} />
      </AlertDescription></Alert>}
      {visibleReview.contextImpact?.map(context => <ReviewDisclosure key={context.label}
        label={context.label + ' · ' + count(new Set([...context.changes, ...context.sources ?? []].map(change => change.path)).size, 'token') + ' affected' +
          (context.matching ? ' · +' + count(context.matching.length, 'matching combination') : '')}>
        {context.matching && <ReviewDisclosure label="Matching combinations">
          <List className="mt-2 max-h-40 overflow-auto">
            {context.matching.map(label => <li className="wrap-anywhere" key={label}>{label}</li>)}
          </List>
        </ReviewDisclosure>}
        {context.errors.map(problem => <p key={problem} className="tone-error">{problem}</p>)}
        {!!context.sources?.length && <ul className="mt-2 space-y-1">
          {context.sources.map(({ path, before, after }) =>
            <li className="wrap-anywhere" key={path}><code>{path}</code> · Source {before} → {after}</li>)}
        </ul>}
        <LinkImpact impact={context.changes} />
      </ReviewDisclosure>)}
      {visibleReview.typeImpact.length > 0 && <ReviewDisclosure label={'Effective type changes (' + visibleReview.typeImpact.length + ')'}>
        <List className="mt-2 max-h-40 overflow-auto code-text">
          {visibleReview.typeImpact.map(({ path, before, after }) => <li key={path} className="wrap-anywhere">
            {path} · {before ?? 'No type'} → {after ?? 'No type'}
          </li>)}
        </List>
      </ReviewDisclosure>}
      <ReviewDisclosure label={'Resolved value changes (' + visibleReview.impact.length + ')'}>
        {visibleReview.impact.length > 0 && <LinkImpact impact={visibleReview.impact} />}
      </ReviewDisclosure>
      <ReviewDisclosure label="Show file changes">
        <div className="mt-2">{visibleData && <FileDiff data={visibleData} />}</div>
      </ReviewDisclosure>
      {error && <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription></Alert>}
    </div>}
  </ActionDialog>;
}
