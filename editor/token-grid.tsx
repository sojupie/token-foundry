import { useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Cell, Column, ColumnResizer, ResizableTableContainer, Row, Table, TableBody, TableHeader } from 'react-aria-components';
import { AlertCircle, Link2 } from 'lucide-react';
import { IconButton } from '@token-catalog/forge-react';
import { EditorPopover } from '@/components/ui/popover';
import { SelectionCheckbox } from '@/components/ui/selection-checkbox';
import type { DocumentGraph, TokenEntry } from '../lib/document.ts';
import type { CellPosition, Draft, EditableColumn } from './lib/draft.ts';
import { dtcgTypes } from '../lib/token-types.ts';
import { inputFormat } from './lib/token-input.ts';
import { TokenEditForm } from './token-edit-form.tsx';
import { TokenValue } from './token-value.tsx';

const columns = ['name', 'value', 'resolved', 'type', 'description'] as const;
const editableColumns = ['name', 'value', 'type', 'description'] as const;
type CellDraft = Extract<Draft, { create: false }>;
const labels = { name: 'Name', value: 'Value', resolved: 'Resolved value', type: 'Type', description: 'Description' };
const defaultWidths = { name: '3fr', value: '2.5fr', resolved: '1.5fr', type: 100, description: '2fr' } as const;
const minimumWidths = { name: 144, value: 144, resolved: 120, type: 80, description: 112 };

interface Props {
  rows: readonly [string, TokenEntry][];
  graph: DocumentGraph;
  group: string;
  selected: string;
  checked: ReadonlySet<string>;
  setChecked: (update: (current: ReadonlySet<string>) => Set<string>) => void;
  select: (path: string) => void;
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
  const openingPopover = useRef(false);

  function keydown(event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    event.stopPropagation();
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
  const inputStyle = 'h-9 w-full min-w-0 bg-background px-2 text-xs ring-2 ring-inset ring-primary outline-none aria-invalid:ring-destructive';

  return <div className="flex h-9 min-w-0 items-center" onBlur={(event) => {
    if (!openingPopover.current && !event.currentTarget.contains(event.relatedTarget) && !commit(draft, null)) {
      const control = event.currentTarget.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
      requestAnimationFrame(() => { if (control?.isConnected) control.focus(); });
    }
  }}>
    {draft.column === 'type' ? <select ref={focusInlineField} className={inputStyle} aria-label={field} aria-invalid={invalid}
      aria-errormessage={invalid ? 'inline-edit-error' : undefined} value={draft.type ?? ''} onKeyDown={keydown}
      onChange={(event) => {
        const next = { ...draft, type: event.target.value };
        if (!commit(next)) { openingPopover.current = true; setDraft({ ...next, mode: 'details' }); }
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
          if (draft.column === 'value' && value.startsWith('{')) {
            openingPopover.current = true;
            setDraft({ ...draft, value, mode: 'link' });
          }
          else setDraft({ ...draft, [draft.column]: value });
        }} />
      {hex && <input type="color" aria-label="Pick color" className="absolute end-8 size-5 cursor-pointer border-0 bg-transparent p-0"
        value={/^#[0-9a-f]{6}$/iu.test(draft.value) ? draft.value : '#000000'}
        onChange={(event) => setDraft({ ...draft, value: event.target.value })} />}
      {draft.column === 'value' && <IconButton size="xsmall" label="Link token"
        className="cell-action end-1" onPointerDown={(event) => event.preventDefault()}
        onClick={() => { openingPopover.current = true; setDraft({ ...draft, mode: 'link' }); }}><Link2 aria-hidden="true" /></IconButton>}
    </>}
  </div>;
}

export function TokenGrid({ rows, graph, group, selected, checked, setChecked, select, edit, draft, setDraft, commit, cancel,
  busy, error }: Props) {
  const anchor = useRef<HTMLTableCellElement>(null);
  const keyboardHelp = useId();
  const editing = draft && !draft.create ? draft : null;
  const popover = editing && editing.mode !== 'inline' ? editing : null;

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

  return <>
    <p className="sr-only" id={keyboardHelp}>Use arrow keys to navigate. Space selects a row. Enter or F2 edits a cell. Escape cancels an edit or clears selection.</p>
    <ResizableTableContainer data-slot="table-container" className="w-full overflow-auto">
      <Table aria-label="Tokens" aria-describedby={keyboardHelp} selectionMode="multiple" selectionBehavior="toggle" selectedKeys={checked}
        escapeKeyBehavior="none" className="foundry-table w-full min-w-[640px] table-fixed text-sm [&_th:not(:last-child)]:border-e [&_td:not(:last-child)]:border-e"
        onSelectionChange={(keys) => setChecked(previous => {
          const next = new Set(previous);
          for (const [path] of rows) {
            if (keys === 'all' || keys.has(path)) next.add(path);
            else next.delete(path);
          }
          return next;
        })}>
        <TableHeader className="sticky top-0 z-10">
          <Column id="selection" width={42} minWidth={42} maxWidth={42} className="text-center" aria-label="Selection">
            <SelectionCheckbox label="Select all visible tokens" disabled={!!draft || busy} />
          </Column>
          {columns.map(field => <Column key={field} id={field} isRowHeader={field === 'name'} aria-label={labels[field]}
            defaultWidth={defaultWidths[field]} minWidth={minimumWidths[field]} className="relative h-10 px-2 pe-4 text-start font-medium">
            {labels[field]}
            <ColumnResizer aria-label={'Resize ' + labels[field] + ' column'} className="column-resizer" />
          </Column>)}
        </TableHeader>
        <TableBody renderEmptyState={() => <p className="p-8 text-center text-muted-foreground">No matching tokens.</p>}>
        {rows.map(([path, entry], index) => {
          const { node, type, value } = entry;
          const name = group ? path.slice(group.length + 1) : path;
          const issue = graph.issues.get(path);
          const origin = node.$type ? 'Declared on token' : entry.referenceType ? 'Inferred from reference' :
            type ? 'Inherited from group' : 'Type unavailable';
          const values = {
            name: <span className="token-name truncate font-mono text-xs" title={path}>{name}</span>,
            value: <TokenValue value={value} authored containsReferences={!!graph.dependencies.get(path)?.size} />,
            resolved: issue ? <span title={issue} className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" /> Unresolved</span> :
              <TokenValue value={graph.resolved.get(path)} swatch={type === 'color'} />,
            type: <span className="truncate text-xs" title={origin}>{type ?? '—'}</span>,
            description: <span className="truncate text-xs text-muted-foreground" title={node.$description}>{node.$description}</span>,
          };
          return <Row key={path} id={path} data-token-row={path} data-current={path === selected ? '' : undefined}>
            <Cell className="p-0 text-center"><SelectionCheckbox label="Select row" disabled={!!draft || busy} /></Cell>
            {columns.map(field => {
              const active = path === selected;
              const showLink = active && field === 'value' && !draft && !busy;
              const currentEdit = editing?.path === path && editing.column === field ? editing : null;
              return <Cell key={field} ref={currentEdit ? anchor : undefined} className="min-w-0 p-0" allowsArrowNavigation={!currentEdit || currentEdit.mode !== 'inline'}>
                <div className="relative min-w-0">
                  {currentEdit?.mode === 'inline' ? <InlineCell draft={currentEdit} {...{ entry, setDraft, commit, cancel, error }}
                    after={(key, backward) => afterEdit(index, currentEdit.column, key, backward)} /> :
                    <button type="button"
                      data-edit-column={field} aria-label={labels[field] + ' for ' + path}
                      className={'grid-cell-button' + (showLink ? ' pe-8' : '')}
                      onFocus={() => { if (!editing) select(path); }}
                      onPointerDown={event => {
                        if (!event.shiftKey && !event.ctrlKey && !event.metaKey) event.stopPropagation();
                      }}
                      onClick={event => {
                        if (event.detail && !event.shiftKey && !event.ctrlKey && !event.metaKey) event.stopPropagation();
                      }}
                      onDoubleClick={event => { if (field !== 'resolved' && !event.shiftKey && !event.ctrlKey && !event.metaKey) edit(path, field); }}
                      onKeyDown={event => {
                        if (field !== 'resolved' && (event.key === 'F2' || event.key === 'Enter')) {
                          event.preventDefault();
                          event.stopPropagation();
                          edit(path, field);
                        }
                      }}>{values[field]}</button>}
                  {showLink && <IconButton size="xsmall" label={'Link reference for ' + path}
                    onClick={() => edit(path, 'value', true)} className="cell-action end-0.5 top-1/2 -translate-y-1/2">
                    <Link2 aria-hidden="true" />
                  </IconButton>}
                </div>
              </Cell>;
            })}
          </Row>;
        })}
        </TableBody>
      </Table>
    </ResizableTableContainer>
    {popover && <EditorPopover anchor={anchor} label={'Edit ' + labels[popover.column].toLowerCase()} onDismiss={cancel}>
      <TokenEditForm draft={popover} {...{ graph, setDraft, cancel, error, busy }} commit={() => { commit(); }} />
    </EditorPopover>}
  </>;
}
