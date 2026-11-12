import { useCallback, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { AlertCircle, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DocumentGraph, TokenEntry } from '../lib/document.ts';
import type { CellPosition, Draft, EditableColumn, GridColumn } from './lib/draft.ts';
import { dtcgTypes } from '../lib/token-types.ts';
import { inputFormat } from './lib/token-input.ts';
import { TokenEditForm } from './token-edit-form.tsx';
import { TokenValue } from './token-value.tsx';

const columns = ['name', 'value', 'resolved', 'type', 'description'] as const;
const editableColumns = ['name', 'value', 'type', 'description'] as const;
type CellDraft = Extract<Draft, { create: false }>;
const labels = { name: 'Name', value: 'Value', resolved: 'Resolved value', type: 'Type', description: 'Description' };
const selectWidth = '2.5rem';
const defaultWidths = {
  name: 'clamp(13.5rem, 32cqw, 32rem)',
  value: 'clamp(10.75rem, 23cqw, 22.5rem)',
  resolved: 'clamp(7.5rem, 12cqw, 11rem)',
  type: '6rem',
  description: '7rem',
};
const minimumWidths = { name: 144, value: 120, resolved: 120, type: 80, description: 112 };

interface ColumnDrag {
  field: GridColumn;
  pointer: number;
  startX: number;
  startWidth: number;
}

interface Props {
  rows: readonly [string, TokenEntry][];
  graph: DocumentGraph;
  group: string;
  selected: string;
  checked: ReadonlySet<string>;
  toggle: (paths: readonly string[], checked: boolean) => void;
  toggleRow: (path: string, previous: string) => void;
  selectRows: (paths: readonly string[], activePath: string) => void;
  select: (path: string, replace?: boolean) => void;
  edit: (path: string, column: EditableColumn, link?: boolean) => void;
  draft: Draft | null;
  setDraft: (draft: Draft) => void;
  commit: (pending?: Draft, after?: CellPosition | null) => boolean;
  cancel: (restore?: boolean) => void;
  error: string;
  busy: boolean;
}

function focusInlineField(field: HTMLInputElement | HTMLSelectElement | null) {
  field?.focus({ preventScroll: true });
  if (field instanceof HTMLInputElement) field.select();
}

function InlineCell({ draft, entry, setDraft, commit, cancel, after, error }: {
  draft: CellDraft; entry: TokenEntry; setDraft: Props['setDraft']; commit: Props['commit']; cancel: Props['cancel'];
  after: (key: string, backward: boolean) => CellPosition | undefined; error: string;
}) {
  function keydown(event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && event.currentTarget instanceof HTMLInputElement)) {
      event.preventDefault();
      commit(draft, after(event.key, event.shiftKey));
    }
  }

  const invalid = !!error;
  const hex = draft.column === 'value' && inputFormat(entry.type, entry.value) === 'hex';
  const field = draft.column === 'description' ? 'Description' : 'Token ' + draft.column;
  const inputStyle = 'h-9 w-full min-w-0 bg-background px-2 text-xs ring-2 ring-inset ring-blue-500 outline-none aria-invalid:ring-destructive';

  return <div className="flex h-9 min-w-0 items-center" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget) && !commit(draft, null)) {
      const control = event.currentTarget.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
      requestAnimationFrame(() => { if (control?.isConnected) control.focus(); });
    }
  }}>
    {draft.column === 'type' ? <select ref={focusInlineField} className={inputStyle} aria-label={field} aria-invalid={invalid}
      aria-errormessage={invalid ? 'inline-edit-error' : undefined} value={draft.type ?? ''} onKeyDown={keydown}
      onChange={(event) => {
        const next = { ...draft, type: event.target.value };
        if (!commit(next)) setDraft({ ...next, mode: 'details' });
      }}>
      <option value="">Automatic</option>
      {[...new Set([...dtcgTypes, ...(entry.node.$type ? [entry.node.$type] : [])])].map((type) =>
        <option key={type} value={type}>{type}</option>)}
    </select> : <>
      <input ref={focusInlineField} aria-label={field} aria-invalid={invalid} aria-errormessage={invalid ? 'inline-edit-error' : undefined}
        autoComplete="off" spellCheck={false} value={draft[draft.column]}
        className={inputStyle + (draft.column === 'description' ? '' : ' font-mono') + (draft.column === 'value' ? hex ? ' pe-14' : ' pe-8' : '')}
        onKeyDown={keydown} onChange={(event) => {
          const value = event.target.value;
          if (draft.column === 'value' && value.startsWith('{')) setDraft({ ...draft, value, mode: 'link' });
          else setDraft({ ...draft, [draft.column]: value });
        }} />
      {hex && <input type="color" aria-label="Pick color" className="absolute end-8 size-5 cursor-pointer border-0 bg-transparent p-0"
        value={/^#[0-9a-f]{6}$/iu.test(draft.value) ? draft.value : '#000000'}
        onChange={(event) => setDraft({ ...draft, value: event.target.value })} />}
      {draft.column === 'value' && <Button type="button" size="icon-xs" variant="ghost" aria-label="Link token"
        className="absolute end-1" onPointerDown={(event) => event.preventDefault()}
        onClick={() => setDraft({ ...draft, mode: 'link' })}><Link2 aria-hidden="true" /></Button>}
    </>}
  </div>;
}

export function TokenGrid({ rows, graph, group, selected, checked, toggle, toggleRow, selectRows, select, edit, draft, setDraft, commit, cancel,
  busy, error }: Props) {
  const [column, setColumn] = useState<GridColumn>('name');
  const [columnWidths, setColumnWidths] = useState<Partial<Record<GridColumn, number>>>({});
  const resizeHelp = useId();
  const drag = useRef<ColumnDrag | null>(null);
  const selectionAnchor = useRef('');
  const selectionBeforeClick = useRef<string | null>(null);
  const visiblePaths = rows.map(([path]) => path);
  const checkedCount = visiblePaths.reduce((count, path) => count + Number(checked.has(path)), 0);
  const editing = draft && !draft.create ? draft : null;
  const popover = editing && editing.mode !== 'inline' ? editing : null;
  const widths = columns.map((field) => columnWidths[field] === undefined ? defaultWidths[field] : columnWidths[field] + 'px');
  const descriptionResized = columnWidths.description !== undefined;
  const partiallyChecked = checkedCount > 0 && checkedCount < rows.length;
  const setSelectAll = useCallback((input: HTMLInputElement | null) => {
    if (input) input.indeterminate = partiallyChecked;
  }, [partiallyChecked]);

  function resizeColumn(field: GridColumn, width: number) {
    const next = Math.max(minimumWidths[field], Math.round(width));
    setColumnWidths((previous) => previous[field] === next ? previous : { ...previous, [field]: next });
  }

  function resetColumn(field: GridColumn) {
    setColumnWidths((previous) => {
      const next = { ...previous };
      delete next[field];
      return next;
    });
  }

  function startResize(event: PointerEvent<HTMLButtonElement>, field: GridColumn) {
    const handle = event.currentTarget;
    const header = handle.closest('th');
    if (event.button !== 0 || drag.current || !header) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    drag.current = { field, pointer: event.pointerId, startX: event.clientX, startWidth: header.getBoundingClientRect().width };
  }

  function moveResize(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) return;
    const offset = event.clientX - current.startX;
    if (offset || columnWidths[current.field] !== undefined) resizeColumn(current.field, current.startWidth + offset);
  }

  function extendSelection(path: string, previous: string) {
    const start = visiblePaths.indexOf(checked.size ? selectionAnchor.current || previous : previous);
    const end = visiblePaths.indexOf(path);
    const first = start < 0 ? end : start;
    selectionAnchor.current = visiblePaths[first] ?? path;
    selectRows(visiblePaths.slice(Math.min(first, end), Math.max(first, end) + 1), path);
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number, field: GridColumn) {
    if (draft || busy || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'F2', ' '].includes(event.key)) return;
    const key = event.key;
    event.preventDefault();
    if (key === ' ' || key === 'F2') {
      const path = rows[index]?.[0];
      if (path && key === ' ' && event.shiftKey) toggle([path], !checked.has(path));
      else if (path && field !== 'resolved') edit(path, field);
      return;
    }
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End';
    const rowIndex = horizontal ? index : Math.max(0, Math.min(rows.length - 1, index + (key === 'ArrowDown' ? 1 : -1)));
    const fieldIndex = columns.indexOf(field);
    const next = horizontal ? columns[key === 'Home' ? 0 : key === 'End' ? columns.length - 1 :
      Math.max(0, Math.min(columns.length - 1, fieldIndex + (key === 'ArrowRight' ? 1 : -1)))] : field;
    const row = event.currentTarget.closest('tbody')?.querySelectorAll<HTMLTableRowElement>('[data-token-row]')[rowIndex];
    const nextPath = visiblePaths[rowIndex];
    if (nextPath && !horizontal) {
      if (event.shiftKey) extendSelection(nextPath, visiblePaths[index] ?? '');
      else selectionAnchor.current = nextPath;
    }
    row?.querySelector<HTMLButtonElement>('[data-edit-column="' + next + '"]')?.focus();
  }

  function afterEdit(index: number, field: EditableColumn, key: string, backward: boolean): CellPosition | undefined {
    const step = backward ? -1 : 1;
    if (key === 'Enter') {
      const path = rows[index + step]?.[0];
      return path ? { path, column: field } : undefined;
    }
    const position = index * editableColumns.length + editableColumns.indexOf(field) + step;
    const path = rows[Math.floor(position / editableColumns.length)]?.[0];
    const nextColumn = editableColumns[position % editableColumns.length];
    return path && nextColumn ? { path, column: nextColumn } : undefined;
  }

  const focusedPath = visiblePaths.includes(selected) ? selected : visiblePaths[0];
  return <Popover open={!!popover} onOpenChange={(open) => { if (!open) cancel(); }}>
    <span id={resizeHelp} className="sr-only">Use the left and right arrow keys to resize. Press Enter to reset.</span>
    <Table aria-label="Tokens" className="table-fixed [&_tbody_tr:last-child]:border-b [&_th]:border-e [&_td]:border-e"
      style={{ width: 'max(100%, calc(' + [selectWidth, ...widths].join(' + ') + '))' }}>
      <colgroup>
        <col style={{ width: selectWidth }} />
        {columns.map((field, index) => <col key={field} style={{ width: field === 'description' && !descriptionResized ? undefined : widths[index] }} />)}
        {descriptionResized && <col />}
      </colgroup>
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow className="hover:bg-background">
          <TableHead scope="col" className="text-center"><input ref={setSelectAll} type="checkbox" className="size-3.5"
            aria-label="Select all visible tokens" checked={rows.length > 0 && checkedCount === rows.length}
            disabled={!rows.length || !!draft || busy} onChange={(event) => toggle(visiblePaths, event.target.checked)} /></TableHead>
          {columns.map((field) => <TableHead key={field} scope="col" aria-label={labels[field]} className="relative px-2 pe-4">
            {labels[field]}
            <button type="button" aria-label={'Resize ' + labels[field] + ' column'}
              aria-describedby={resizeHelp}
              title="Drag to resize. Double-click to reset."
              className={'absolute inset-y-0 end-0 z-10 w-3 cursor-col-resize touch-none select-none outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring' +
                (field === 'description' ? '' : ' translate-x-1/2 rtl:-translate-x-1/2')}
              onPointerDown={(event) => startResize(event, field)}
              onPointerMove={moveResize}
              onLostPointerCapture={(event) => { if (drag.current?.pointer === event.pointerId) drag.current = null; }}
              onDoubleClick={() => resetColumn(field)}
              onClick={(event) => { if (event.detail === 0) resetColumn(field); }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                const header = event.currentTarget.closest('th');
                if (!header) return;
                event.preventDefault();
                resizeColumn(field, header.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 16 : -16));
              }} />
          </TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([path, entry], index) => {
          const { node, type, value } = entry;
          const name = group ? path.slice(group.length + 1) : path;
          const issue = graph.issues.get(path);
          const origin = node.$type ? 'Declared on token' : entry.referenceType ? 'Inferred from reference' :
            type ? 'Inherited from group' : 'Type unavailable';
          const values = {
            name: <span className="truncate font-mono text-xs" title={path}>{name}</span>,
            value: <TokenValue value={value} authored containsReferences={!!graph.dependencies.get(path)?.size} />,
            resolved: issue ? <span title={issue} className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" /> Unresolved</span> :
              <TokenValue value={graph.resolved.get(path)} swatch={type === 'color'} />,
            type: <span className="truncate text-xs" title={origin}>{type ?? '—'}</span>,
            description: <span className="truncate text-xs text-muted-foreground" title={node.$description}>{node.$description}</span>,
          };
          return <TableRow key={path} data-token-row={path} data-state={checked.has(path) ? 'selected' : undefined}
            data-current={path === selected ? '' : undefined}
            onPointerDownCapture={(event) => {
              selectionBeforeClick.current = event.button === 0 && (event.shiftKey || event.ctrlKey || event.metaKey) ? selected : null;
            }}
            onClickCapture={(event) => {
              if (draft || busy || event.button !== 0 || (!event.shiftKey && !event.ctrlKey && !event.metaKey) ||
                !(event.target instanceof Element) || event.target.closest('input')) return;
              event.preventDefault();
              event.stopPropagation();
              const previous = selectionBeforeClick.current ?? selected;
              if (event.shiftKey) extendSelection(path, previous);
              else {
                toggleRow(path, previous);
                selectionAnchor.current = path;
              }
              selectionBeforeClick.current = null;
            }}>
            <TableCell className="text-center"><input type="checkbox" className="size-3.5" aria-label={'Select ' + path}
              tabIndex={path === focusedPath ? 0 : -1}
              checked={checked.has(path)} disabled={!!draft || busy} onClick={(event) => {
                const anchor = visiblePaths.indexOf(checked.size ? selectionAnchor.current : selected);
                if (event.shiftKey && anchor >= 0) {
                  toggle(visiblePaths.slice(Math.min(anchor, index), Math.max(anchor, index) + 1), event.currentTarget.checked);
                } else selectionAnchor.current = path;
              }}
              onChange={(event) => toggle([path], event.target.checked)} /></TableCell>
            {columns.map((field) => {
              const active = path === selected && field === column;
              const showLink = active && field === 'value' && !draft && !busy;
              const control = <button type="button" data-edit-column={field} aria-label={labels[field] + ' for ' + path}
                tabIndex={path === focusedPath && field === column ? 0 : -1}
                data-active={active ? '' : undefined} aria-current={active ? 'true' : undefined}
                className={'flex h-9 w-full min-w-0 items-center px-2 text-start outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-active:bg-blue-50 data-active:ring-1 data-active:ring-inset data-active:ring-blue-500 dark:data-active:bg-blue-950 ' +
                  (showLink ? 'pe-8' : '')}
                onFocus={() => { if (!editing) { select(path); setColumn(field); } }}
                onClick={() => { if (!editing) { selectionAnchor.current = path; select(path, true); setColumn(field); } }}
                onDoubleClick={(event) => { if (field !== 'resolved' && !event.shiftKey && !event.ctrlKey && !event.metaKey) edit(path, field); }}
                onKeyDown={(event) => navigate(event, index, field)}>{values[field]}</button>;
              const currentEdit = editing?.path === path && editing.column === field ? editing : null;
              return <TableCell key={field} className="min-w-0 p-0">
                <div className="relative min-w-0">
                  {currentEdit?.mode === 'inline' ? <InlineCell draft={currentEdit} {...{ entry, setDraft, commit, cancel, error }}
                    after={(key, backward) => afterEdit(index, currentEdit.column, key, backward)} /> :
                    currentEdit ? <PopoverAnchor asChild>{control}</PopoverAnchor> : control}
                  {showLink && <Button type="button" size="icon-xs" variant="ghost" aria-label={'Link reference for ' + path}
                    onClick={() => { setColumn('value'); edit(path, 'value', true); }}
                    className="absolute end-0.5 top-1/2 -translate-y-1/2">
                    <Link2 aria-hidden="true" />
                  </Button>}
                </div>
              </TableCell>;
            })}
          </TableRow>;
        })}
        {!rows.length && <TableRow><TableCell colSpan={6} className="p-8 text-center text-sm text-muted-foreground">No matching tokens.</TableCell></TableRow>}
      </TableBody>
    </Table>
    {popover && <PopoverContent aria-label={'Edit ' + labels[popover.column].toLowerCase()} className="w-[38rem]"
      onOpenAutoFocus={(event) => {
        const container = event.currentTarget;
        if (!(container instanceof HTMLElement)) return;
        const input = container.querySelector<HTMLElement>('[data-reference-search], [data-primary-editor]');
        if (input) {
          event.preventDefault();
          input.focus();
          if (input instanceof HTMLInputElement && input.type !== 'search') input.select();
        }
      }}
      onInteractOutside={(event) => {
        event.preventDefault();
        cancel(false);
      }}
      onCloseAutoFocus={(event) => event.preventDefault()}>
      <TokenEditForm draft={popover} {...{ graph, setDraft, cancel, error, busy }} commit={() => { commit(); }} />
    </PopoverContent>}
  </Popover>;
}
