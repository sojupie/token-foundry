import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Cell, Column, ColumnResizer, ResizableTableContainer, Row, Table, TableBody, TableHeader } from 'react-aria-components';
import { AlertCircle, ArrowRightLeft, Copy, Ellipsis, Link2, Settings2, SquarePen, Trash2, Undo2 } from 'lucide-react';
import { IconButton } from '@token-catalog/forge-react';
import { EditorPopover } from '@/components/ui/popover';
import { SelectionCheckbox } from '@/components/ui/selection-checkbox';
import type { DocumentGraph, TokenEntry } from '../lib/document.ts';
import type { CellPosition, Draft, EditableColumn, GridColumn } from './lib/draft.ts';
import { dtcgTypes } from '../lib/token-types.ts';
import { inputFormat } from './lib/token-input.ts';
import { TokenEditForm, TokenReferenceDialog } from './token-edit-form.tsx';
import { TokenValue } from './token-value.tsx';
import { CommandMenu } from './command-bar.tsx';

const columns = ['name', 'value', 'resolved', 'type', 'description'] as const;
const editableColumns = ['name', 'value', 'type', 'description'] as const;
type CellDraft = Extract<Draft, { create: false }>;
const labels = { name: 'Name', value: 'Value', resolved: 'Resolved value', type: 'Type', description: 'Description' };
const defaultWidths = { name: '3fr', value: '2.5fr', resolved: '1.5fr', type: 100, description: '2fr' } as const;
const minimumWidths = { name: 144, value: 144, resolved: 120, type: 80, description: 112 };

interface Props {
  narrow: boolean;
  variant: boolean;
  rows: readonly [string, TokenEntry][];
  graph: DocumentGraph;
  group: string;
  selected: string;
  activeColumn: GridColumn;
  checked: ReadonlySet<string>;
  setChecked: (update: (current: ReadonlySet<string>) => Set<string>) => void;
  select: (path: string, column?: GridColumn) => void;
  edit: (path: string, column: EditableColumn, link?: boolean) => void;
  inspect: (path: string) => void;
  metadata: (path: string) => void;
  move: (path: string) => void;
  duplicate: (path: string) => void;
  copy: (path: string) => void;
  remove: (path: string) => void;
  restoreInherited: (path: string) => void;
  draft: Draft | null;
  setDraft: (draft: Draft) => void;
  commit: (pending: Draft, after?: CellPosition | null) => boolean;
  cancel: (restore?: boolean) => void;
  error: string;
  busy: boolean;
}

function focusInlineField(field: HTMLInputElement | HTMLSelectElement | null) {
  field?.focus({ preventScroll: true });
  if (field instanceof HTMLInputElement) field.select();
}

function openRowMenu(cell: HTMLElement) {
  const trigger = cell.closest('tr')?.querySelector<HTMLButtonElement>('.token-row-actions');
  if (!trigger || trigger.disabled) return false;
  trigger.focus({ preventScroll: true });
  trigger.click();
  return true;
}

function InlineCell({ draft: initialDraft, entry, setDraft, commit, cancel, after, error }: {
  draft: CellDraft; entry: TokenEntry; setDraft: Props['setDraft']; commit: Props['commit']; cancel: Props['cancel'];
  after: (key: string, backward: boolean) => CellPosition | undefined; error: string;
}) {
  const [draft, updateDraft] = useState(initialDraft);
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
            setDraft({ ...draft, type: entry.node.$type, value, mode: 'link' });
          }
          else updateDraft({ ...draft, [draft.column]: value });
        }} />
      {hex && <input type="color" aria-label="Pick color" className="absolute end-8 size-5 cursor-pointer border-0 bg-transparent p-0"
        value={/^#[0-9a-f]{6}$/iu.test(draft.value) ? draft.value : '#000000'}
        onChange={(event) => updateDraft({ ...draft, value: event.target.value })} />}
      {draft.column === 'value' && <IconButton size="xsmall" label="Link token" aria-haspopup="dialog"
        className="cell-action end-1" onPointerDown={(event) => event.preventDefault()}
        onClick={() => { openingPopover.current = true; setDraft({ ...draft, type: entry.node.$type, mode: 'link' }); }}><Link2 aria-hidden="true" /></IconButton>}
    </>}
  </div>;
}

export function TokenGrid({ narrow, variant, rows, graph, group, selected, activeColumn, checked, setChecked, select, edit, draft, setDraft, commit, cancel,
  inspect, metadata, move, duplicate, copy, remove, restoreInherited, busy, error }: Props) {
  const anchor = useRef<HTMLTableCellElement>(null);
  const rowAnchor = useRef<string | undefined>(undefined);
  const keyboardHelp = useId();
  const editing = draft && !draft.create && draft.mode !== 'inspector' ? draft : null;
  const popover = editing?.mode === 'details' ? editing : null;
  const linking = editing?.mode === 'link' ? editing : null;
  const visibleColumns = narrow ? columns.filter(field => field === 'name' || field === 'value') : columns;
  const editOrder: readonly EditableColumn[] = narrow ? editableColumns.filter(field => field === 'name' || field === 'value') : editableColumns;

  function afterEdit(index: number, field: EditableColumn, key: string, backward: boolean): CellPosition | undefined {
    const step = backward ? -1 : 1;
    if (key === 'Enter') {
      const path = rows[index + step]?.[0];
      return path ? { path, column: field } : undefined;
    }
    const position = index * editOrder.length + editOrder.indexOf(field) + step;
    const path = rows[Math.floor(position / editOrder.length)]?.[0];
    const nextColumn = editOrder[position % editOrder.length];
    return path && nextColumn ? { path, column: nextColumn } : undefined;
  }

  function selectRange(from: string, to: string) {
    const anchorIndex = rows.findIndex(([path]) => path === rowAnchor.current);
    const fromIndex = anchorIndex < 0 || !checked.size ? rows.findIndex(([path]) => path === from) : anchorIndex;
    const toIndex = rows.findIndex(([path]) => path === to);
    if (toIndex < 0) return;
    const start = fromIndex < 0 ? toIndex : fromIndex;
    rowAnchor.current = rows[start]?.[0];
    setChecked(() => new Set(rows.slice(Math.min(start, toIndex), Math.max(start, toIndex) + 1).map(([path]) => path)));
  }

  function selectRow(path: string, toggle: boolean) {
    rowAnchor.current = path;
    setChecked(previous => {
      const next = toggle ? new Set(previous) : new Set<string>();
      if (toggle && next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function extendByKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (variant || draft || busy || !event.shiftKey || !(event.target instanceof HTMLElement)) return;
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    if (!vertical && !horizontal) return;
    const cell = event.target.closest<HTMLElement>('[data-edit-column]');
    const checkbox = event.target.closest<HTMLInputElement>('input[type="checkbox"]');
    if (!cell && !checkbox) return;
    const row = event.target.closest<HTMLElement>('[data-token-row]');
    const from = row?.dataset['tokenRow'];
    if (!from) return;
    event.preventDefault();
    event.stopPropagation();
    const column = cell?.dataset['editColumn'];
    if (horizontal) {
      const index = visibleColumns.findIndex(field => field === column);
      const next = index + (event.key === 'ArrowRight' ? 1 : -1);
      if (visibleColumns[next]) row.querySelector<HTMLElement>('[data-edit-column="' + visibleColumns[next] + '"]')?.focus();
      else if (next === -1) row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
      return;
    }
    const index = rows.findIndex(([path]) => path === from);
    const to = rows[index + (event.key === 'ArrowUp' ? -1 : 1)]?.[0];
    if (!to) return;
    selectRange(from, to);
    const control = column ? '[data-edit-column="' + column + '"]' : 'input[type="checkbox"]';
    event.currentTarget.querySelector<HTMLElement>('[data-token-row="' + CSS.escape(to) + '"] ' + control)?.focus();
  }

  return <>
    <p className="sr-only" id={keyboardHelp}>Use arrow keys to navigate. {variant ? 'Enter or F2 opens the token editor.' :
      'Space toggles the row. Shift with Up or Down extends the row selection. Enter or F2 edits one cell. Shift+F10 opens token actions. Escape cancels an edit or clears selection.'}</p>
    <div className="contents" onKeyDownCapture={extendByKeyboard}>
    <ResizableTableContainer data-slot="table-container" className="h-full w-full overflow-auto">
      <Table aria-label="Tokens" aria-describedby={keyboardHelp} selectionMode={variant ? 'none' : 'multiple'} selectionBehavior="toggle" selectedKeys={checked}
        escapeKeyBehavior="none" className="foundry-table w-full md:min-w-[640px] table-fixed text-sm [&_th:not(:last-child)]:border-e [&_td:not(:last-child)]:border-e"
        onSelectionChange={keys => {
          const next = new Set(checked);
          for (const [path] of rows) {
            if (keys === 'all' || keys.has(path)) next.add(path);
            else next.delete(path);
          }
          const changed = rows.filter(([path]) => next.has(path) !== checked.has(path));
          if (changed.length === 1) rowAnchor.current = changed[0]?.[0];
          setChecked(() => next);
        }}>
        <TableHeader className="sticky top-0 z-10">
          {!variant && <Column id="selection" width={42} minWidth={42} maxWidth={42} className="text-center" aria-label="Selection">
            <SelectionCheckbox label="Select all visible tokens" disabled={variant || !!draft || busy} />
          </Column>}
          {visibleColumns.map(field => <Column key={field} id={field} isRowHeader={field === 'name'} aria-label={labels[field]}
            defaultWidth={defaultWidths[field]} minWidth={narrow ? 96 : minimumWidths[field]} className="relative h-10 px-2 pe-4 text-start font-medium">
            {labels[field]}
            <ColumnResizer aria-label={'Resize ' + labels[field] + ' column'} className="column-resizer" />
          </Column>)}
        </TableHeader>
        <TableBody renderEmptyState={() => <p className="p-8 text-center text-muted-foreground">No matching tokens.</p>}>
        {rows.map(([path, entry], index) => {
          const { node, type, value } = entry;
          const name = group ? path.slice(group.length + 1) : path;
          const issue = graph.issues.get(path);
          const invalid = graph.validation.get(path)?.join('\n');
          const origin = node.$type ? 'Declared on token' : entry.referenceType ? 'Inferred from reference' :
            type ? 'Inherited from group' : 'Type unavailable';
          const values = {
            name: <span className="token-name truncate font-mono text-xs" title={entry.inheritedFrom ? 'Inherited from ' + entry.inheritedFrom.path + ' · ' + entry.inheritedFrom.file : path}>
              {name}{entry.inheritedFrom && <span className="ms-2 font-sans text-muted-foreground">Inherited</span>}
              {!entry.inheritedFrom && entry.overrides && <span className="ms-2 font-sans text-muted-foreground">Override</span>}
            </span>,
            value: <><TokenValue value={value} authored containsReferences={!!graph.dependencies.get(path)?.size} />
              {narrow && (issue || invalid ? <span className="block text-xs text-destructive">{issue ? 'Unresolved' : 'Invalid'}</span> :
                graph.links.has(path) && <span className="block"><TokenValue value={graph.resolved.get(path)} swatch={type === 'color'} /></span>)}</>,
            resolved: issue || invalid ? <span title={issue ?? invalid} className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" /> {issue ? 'Unresolved' : 'Invalid'}</span> :
              JSON.stringify(value) === JSON.stringify(graph.resolved.get(path)) ? null : <TokenValue value={graph.resolved.get(path)} swatch={type === 'color'} />,
            type: <span className="truncate text-xs" title={origin}>{type ?? '—'}</span>,
            description: <span className="truncate text-xs text-muted-foreground" title={node.$description}>{node.$description}</span>,
          };
          return <Row key={path} id={path} data-token-row={path}>
            {!variant && <Cell className="p-0 text-center"><SelectionCheckbox label="Select row" disabled={!!draft || busy} /></Cell>}
            {visibleColumns.map(field => {
              const active = path === selected;
              const showLink = !variant && active && field === 'value' && !draft && !busy;
              const showActions = !variant && field === 'name' && !draft && !busy;
              const currentEdit = editing?.path === path && editing.column === field ? editing : null;
              return <Cell key={field} ref={currentEdit ? anchor : undefined} className="min-w-0 p-0" allowsArrowNavigation={!currentEdit || currentEdit.mode !== 'inline'}>
                <div className="relative min-w-0">
                  {currentEdit?.mode === 'inline' ? <InlineCell draft={currentEdit} {...{ entry, setDraft, commit, cancel, error }}
                    after={(key, backward) => afterEdit(index, currentEdit.column, key, backward)} /> :
                    <button type="button"
                      data-edit-column={field} data-active-cell={active && field === activeColumn ? '' : undefined} aria-label={labels[field] + ' for ' + path}
                      className={'grid-cell-button' + (showLink || showActions ? ' pe-8' : '')}
                      onFocus={() => { if (!editing) select(path, field); }}
                      onPointerDown={event => event.stopPropagation()}
                      onClick={event => {
                        event.stopPropagation();
                        if (draft || busy) return;
                        if (!variant) {
                          if (event.shiftKey) selectRange(selected, path);
                          else selectRow(path, event.ctrlKey || event.metaKey);
                        }
                        select(path, field);
                        if ((narrow || variant) && field === 'name' && !event.shiftKey && !event.ctrlKey && !event.metaKey) inspect(path);
                      }}
                      onDoubleClick={event => { if (field !== 'resolved' && !event.shiftKey && !event.ctrlKey && !event.metaKey) edit(path, field); }}
                      onContextMenu={event => {
                        if (openRowMenu(event.currentTarget)) event.preventDefault();
                      }}
                      onKeyDown={event => {
                        if (!variant && !draft && !busy && event.key === ' ') {
                          event.preventDefault();
                          event.stopPropagation();
                          selectRow(path, true);
                          return;
                        }
                        if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && openRowMenu(event.currentTarget)) {
                          event.preventDefault();
                          event.stopPropagation();
                        }
                        if (field !== 'resolved' && (event.key === 'F2' || event.key === 'Enter')) {
                          event.preventDefault();
                          event.stopPropagation();
                          edit(path, field);
                        }
                      }}>{values[field]}</button>}
                  {showLink && <IconButton size="xsmall" label={'Link reference for ' + path} aria-haspopup="dialog"
                    onClick={() => edit(path, 'value', true)} className="cell-action end-0.5 top-1/2 -translate-y-1/2">
                    <Link2 aria-hidden="true" />
                  </IconButton>}
                  {showActions && <CommandMenu label={'Token actions for ' + path} heading={path}
                    icon={<Ellipsis aria-hidden="true" />} triggerClassName="cell-action token-row-actions end-0.5 top-1/2 -translate-y-1/2"
                    sections={[[{ label: 'Edit token', icon: <SquarePen aria-hidden="true" />, run: () => inspect(path) },
                      { label: 'References', icon: <Link2 aria-hidden="true" />, run: () => inspect(path) },
                      { label: 'Edit token metadata', icon: <Settings2 aria-hidden="true" />, run: () => metadata(path) },
                      { label: 'Move token', icon: <ArrowRightLeft aria-hidden="true" />, disabled: !!entry.inheritedFrom, run: () => move(path) },
                      { label: 'Copy token', icon: <Copy aria-hidden="true" />, run: () => copy(path) },
                      { label: 'Duplicate token', icon: <Copy aria-hidden="true" />, run: () => duplicate(path) },
                      entry.overrides && !entry.inheritedFrom
                        ? { label: 'Use inherited value', icon: <Undo2 aria-hidden="true" />, run: () => restoreInherited(path) }
                        : { label: 'Delete token', icon: <Trash2 aria-hidden="true" />, disabled: !!entry.inheritedFrom, run: () => remove(path), destructive: true }]]} />}
                </div>
              </Cell>;
            })}
          </Row>;
        })}
        </TableBody>
      </Table>
    </ResizableTableContainer>
    </div>
    {linking && <TokenReferenceDialog draft={linking} graph={graph} type={graph.tokens.get(linking.path)?.type}
      seed={linking.value.startsWith('{') && !linking.value.endsWith('}') ? linking.value.slice(1) : ''}
      choose={value => commit({ ...linking, value })} applyRawValue={commit} close={() => cancel()} error={error} />}
    {popover && <EditorPopover anchor={anchor} label={'Edit ' + labels[popover.column].toLowerCase()} onDismiss={cancel}>
      <TokenEditForm initialDraft={popover} {...{ graph, cancel, error, busy, commit }} />
    </EditorPopover>}
  </>;
}
