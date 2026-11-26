import { winningOrigins } from '../lib/resolver.ts';
import type { ResolverResolution } from '../lib/resolver.ts';
import { originName } from './resolver-pane.tsx';
import { tokenDisplayName } from './lib/value-shape.ts';
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FocusEvent, KeyboardEvent, MouseEvent, ReactNode, RefObject } from 'react';
import { GridColumnResizer, useGridWidths } from './grid-columns.tsx';
import type { GridSelection } from './lib/grid-selection.ts';
import type { RenderData } from './lib/render-data.ts';
import { AlertCircle, ArrowRightLeft, Copy, Ellipsis, Link2, Pencil, Settings2, TextCursorInput, Trash2, Undo2 } from 'lucide-react';
import { IconButton, Select, SelectOption } from '@token-catalog/forge-react';
import { EditorPopover } from '@/components/ui/popover';
import { SelectionCheckbox } from '@/components/ui/selection-checkbox';
import type { DocumentGraph, TokenEntry } from '../lib/document.ts';
import type { CellPosition, Draft, EditableColumn, GridColumn } from './lib/draft.ts';
import { dtcgTypes } from '../lib/token-types.ts';
import { inputFormat } from './lib/token-input.ts';
import { TokenEditForm, TokenReferenceDialog } from './token-edit-form.tsx';
import { TokenValue } from './token-value.tsx';
import { RowCommandMenu } from './command-bar.tsx';
import type { RowMenuHandle } from './command-bar.tsx';

// ARIA in HTML permits a native table to expose the grid role when its
// controls implement grid keyboard navigation.
const gridSemantics = { role: 'grid', tabIndex: -1, 'aria-label': 'Tokens', 'aria-multiselectable': true };
const columns = ['name', 'value', 'resolved', 'type', 'description'] as const;
const narrowColumns = ['name', 'value'] as const;
const editableColumns = ['name', 'value', 'type', 'description'] as const;
type CellDraft = Extract<Draft, { create: false }>;
const labels = { name: 'Name', value: 'Value', resolved: 'Resolved value', type: 'Type', description: 'Description' };

export interface GridData {
  rows: readonly [string, TokenEntry][];
  graph: DocumentGraph;
  activeValueGraph: DocumentGraph | undefined;
  resolution: ResolverResolution | undefined;
  definition: ResolverResolution | undefined;
}

interface Props {
  narrow: boolean;
  variant: boolean;
  canStructure: (path: string) => boolean;
  rename: (path: string) => void;
  data: RenderData<GridData>;
  previewLabel: string | undefined;
  resolvedHeading: string;
  group: string;
  gridSelection: GridSelection;
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

function focusInlineField(field: HTMLInputElement | null) {
  field?.focus({ preventScroll: true });
  if (field && !field.readOnly) field.select();
}

function focusGridControl(control: HTMLElement | null | undefined) {
  control?.focus();
}

function InlineCell({ draft: initialDraft, entry, setDraft, commit, cancel, after, error }: {
  draft: CellDraft; entry: TokenEntry; setDraft: Props['setDraft']; commit: Props['commit']; cancel: Props['cancel'];
  after: (key: string, backward: boolean) => CellPosition | undefined; error: string;
}) {
  const [draft, updateDraft] = useState(initialDraft);
  const openingPopover = useRef(false);

  function keydown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.currentTarget.readOnly)) {
      event.preventDefault();
      commit(draft, after(event.key, event.shiftKey));
    }
  }

  const invalid = !!error;
  const hex = draft.column === 'value' && inputFormat(entry.type, entry.value) === 'hex';
  const field = draft.column === 'description' ? 'Description' : 'Token ' + draft.column;
  return <div className="grid-inline-editor" data-invalid={invalid || undefined} onBlur={(event) => {
    if (!openingPopover.current && !event.currentTarget.contains(event.relatedTarget) && !commit(draft, null)) {
      const control = event.currentTarget.querySelector<HTMLInputElement>('input');
      requestAnimationFrame(() => { if (control?.isConnected) control.focus(); });
    }
  }}>
    {draft.column === 'type' ? <Select ref={focusInlineField} className="w-full" aria-label={field} aria-invalid={invalid}
      aria-errormessage={invalid ? 'inline-edit-error' : undefined} value={draft.type ?? ''} onKeyDown={keydown}
      onChange={(event) => {
        const next = { ...draft, type: event.target.value };
        if (!commit(next)) { openingPopover.current = true; setDraft({ ...next, mode: 'details' }); }
      }}>
      <SelectOption value="">Automatic</SelectOption>
      {[...new Set([...dtcgTypes, ...(entry.node.$type ? [entry.node.$type] : [])])].map((type) =>
        <SelectOption key={type} value={type}>{type}</SelectOption>)}
    </Select> : <>
      <input ref={focusInlineField} aria-label={field} aria-invalid={invalid} aria-errormessage={invalid ? 'inline-edit-error' : undefined}
        autoComplete="off" spellCheck={false} value={draft[draft.column]}
        className={'grid-inline-input' + (draft.column === 'description' ? '' : ' code-text')}
        onKeyDown={keydown} onChange={(event) => {
          const value = event.target.value;
          if (draft.column === 'value' && value.startsWith('{')) {
            openingPopover.current = true;
            setDraft({ ...draft, type: entry.node.$type, value, mode: 'link' });
          }
          else updateDraft({ ...draft, [draft.column]: value });
        }} />
      {draft.column === 'value' && <div className="grid-inline-actions">
        {hex && <input type="color" aria-label="Pick color" className="workspace-color-picker"
          value={/^#[0-9a-f]{6}$/iu.test(draft.value) ? draft.value : '#000000'}
          onChange={(event) => updateDraft({ ...draft, value: event.target.value })} />}
        <IconButton size="xsmall" label="Link token" aria-haspopup="dialog"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => { openingPopover.current = true; setDraft({ ...draft, type: entry.node.$type, mode: 'link' }); }}>
          <Link2 aria-hidden="true" />
        </IconButton>
      </div>}
    </>}
  </div>;
}

interface GridActions {
  select: Props['select'];
  edit: Props['edit'];
  inspect: Props['inspect'];
  setDraft: Props['setDraft'];
  commit: Props['commit'];
  cancel: Props['cancel'];
  openRowMenu: (cell: HTMLElement, path: string) => boolean;
  selectRange: (to: string) => void;
  selectRow: (path: string, toggle: boolean) => void;
  anchorRow: (path: string) => void;
  focusCell: (button: HTMLButtonElement, path: string, field: GridColumn) => void;
  pointerDown: (button: HTMLButtonElement) => void;
  clearPointer: () => void;
  afterEdit: (index: number, field: EditableColumn, key: string, backward: boolean) => CellPosition | undefined;
}

function RowSelection({ gridSelection, path, disabled, actions }: {
  gridSelection: GridSelection; path: string; disabled: boolean; actions: RefObject<GridActions>;
}) {
  const subscribe = useCallback((listener: () => void) => gridSelection.subscribeRow(path, listener), [gridSelection, path]);
  const selected = useSyncExternalStore(subscribe, () => gridSelection.getSnapshot().checked.has(path));
  const markRow = useCallback((label: HTMLLabelElement | null) => {
    const row = label?.closest('tr');
    row?.setAttribute('aria-selected', String(selected));
    row?.toggleAttribute('data-selected', selected);
  }, [selected]);
  return <SelectionCheckbox rowRef={markRow} tabIndex={-1} label={'Select row Name for ' + path} {...{ selected, disabled }}
    change={next => {
      actions.current.anchorRow(path);
      gridSelection.setChecked(previous => {
        const checked = new Set(previous);
        if (next) checked.add(path);
        else checked.delete(path);
        return checked;
      });
    }} />;
}

function setPageChecked(gridSelection: GridSelection, rows: GridData['rows'], selected: boolean) {
  gridSelection.setChecked(previous => {
    const checked = new Set(previous);
    for (const [path] of rows) {
      if (selected) checked.add(path);
      else checked.delete(path);
    }
    return checked;
  });
}

function PageSelection({ gridSelection, rows, disabled }: {
  gridSelection: GridSelection; rows: GridData['rows']; disabled: boolean;
}) {
  const count = useSyncExternalStore(gridSelection.subscribeChecked, () => {
    const { checked } = gridSelection.getSnapshot();
    return rows.reduce((total, [path]) => total + Number(checked.has(path)), 0);
  });
  const selected = rows.length > 0 && count === rows.length;
  return <SelectionCheckbox tabIndex={-1} label="Select all visible tokens" {...{ selected, disabled }} indeterminate={count > 0 && !selected}
    change={next => setPageChecked(gridSelection, rows, next)} />;
}

function GridCell({ path, field, entry, index, gridSelection, actions, variant, draft, disabled, stacked, error, children }: {
  path: string; field: GridColumn; entry: TokenEntry; index: number;
  gridSelection: GridSelection; actions: RefObject<GridActions>;
  variant: boolean; draft: CellDraft | null; disabled: boolean; stacked: boolean; error: string; children: ReactNode;
}) {
  const subscribe = useCallback((listener: () => void) => gridSelection.subscribeRow(path, listener), [gridSelection, path]);
  const active = useSyncExternalStore(subscribe, () => {
    const { selected, activeColumn } = gridSelection.getSnapshot();
    if (path !== selected) return 0;
    if (field === activeColumn) return 2;
    return field === 'value' ? 1 : 0;
  });
  const showLink = !variant && active > 0 && field === 'value' && !disabled;
  const showActions = field === 'name' && !disabled;
  return <div className="relative min-w-0">
    {draft?.mode === 'inline' ? <InlineCell {...{ draft, entry, error }}
      setDraft={next => actions.current.setDraft(next)}
      commit={(pending, after) => actions.current.commit(pending, after)}
      cancel={restore => actions.current.cancel(restore)}
      after={(key, backward) => actions.current.afterEdit(index, draft.column, key, backward)} /> :
      <button type="button" tabIndex={-1} data-stacked={stacked ? '' : undefined} data-edit-column={field}
        data-active-cell={active === 2 ? '' : undefined} aria-label={labels[field] + ' for ' + path}
        className={'grid-cell-button' + (field === 'name' || !variant && field === 'value' ? ' pad-end-space400' : '')}
        onFocus={event => actions.current.focusCell(event.currentTarget, path, field)}
        onPointerDown={event => {
          event.stopPropagation();
          if (event.isPrimary && event.button === 0) actions.current.pointerDown(event.currentTarget);
        }}
        onPointerUp={() => actions.current.clearPointer()}
        onPointerCancel={() => actions.current.clearPointer()}
        onPointerLeave={() => actions.current.clearPointer()}
        onClick={event => {
          event.stopPropagation();
          if (disabled) return;
          if (event.shiftKey) actions.current.selectRange(path);
          else actions.current.selectRow(path, event.ctrlKey || event.metaKey);
          actions.current.select(path, field);
          focusGridControl(event.currentTarget);
        }}
        onDoubleClick={event => { if (field !== 'resolved' && !event.shiftKey && !event.ctrlKey && !event.metaKey) actions.current.edit(path, field); }}
        onKeyDown={event => {
          if (!disabled && field !== 'resolved' && (event.key === 'F2' || event.key === 'Enter')) {
            event.preventDefault();
            event.stopPropagation();
            actions.current.edit(path, field);
          }
        }}>{children}</button>}
    {showLink && <IconButton tabIndex={-1} size="xsmall" label={'Link reference for ' + path} aria-haspopup="dialog"
      onClick={() => actions.current.edit(path, 'value', true)} className="cell-action cell-action-end -translate-y-1/2">
      <Link2 aria-hidden="true" />
    </IconButton>}
    {showActions && <IconButton tabIndex={-1} size="xsmall" label={'Token actions for ' + path} aria-haspopup="menu" aria-expanded="false"
      className="cell-action token-row-actions cell-action-end -translate-y-1/2"
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowDown') return;
        event.preventDefault(); event.stopPropagation();
        actions.current.openRowMenu(event.currentTarget, path);
      }}
      onPointerDown={event => event.stopPropagation()} onClick={event => {
        event.stopPropagation();
        actions.current.openRowMenu(event.currentTarget, path);
      }}><Ellipsis aria-hidden="true" /></IconButton>}
  </div>;
}

export function TokenGrid({ narrow, variant, canStructure, rename, data, previewLabel, resolvedHeading, group, gridSelection, select, edit, draft, setDraft, commit, cancel,
  inspect, metadata, move, duplicate, copy, remove, restoreInherited, busy, error }: Props) {
  const { rows, graph, activeValueGraph, resolution, definition } = data.value;
  const valueGraph = activeValueGraph ?? graph;
  const anchor = useRef<HTMLTableCellElement>(null);
  const pointerAnchor = useRef<string | undefined>(undefined);
  const range = useRef<{ rows: GridData['rows']; start: number; end: number; baseline: ReadonlySet<string>; checked: Set<string> } | null>(null);
  const pointerCell = useRef<HTMLButtonElement | null>(null);
  const rowMenu = useRef<RowMenuHandle>(null);
  function openRowMenu(cell: HTMLElement, path: string) {
    const button = cell.closest('tr')?.querySelector<HTMLButtonElement>('.token-row-actions');
    const entry = graph.tokens.get(path);
    if (!button || button.disabled || !entry || !rowMenu.current) return false;
    const returnCell = cell === button ? cell.closest('td')?.querySelector<HTMLElement>('[data-edit-column]') ?? cell : cell;
    focusGridControl(returnCell);
    rowMenu.current.open(button, {
      label: 'Token actions for ' + path,
      heading: tokenDisplayName(path),
      restore: () => {
        if (returnCell.isConnected && (document.activeElement === document.body || document.activeElement === button)) {
          focusGridControl(returnCell);
        }
      },
      sections: [[{ label: 'Edit token', icon: <Pencil aria-hidden="true" />, run: () => inspect(path) },
        { label: 'References', icon: <Link2 aria-hidden="true" />, run: () => inspect(path) },
        ...(!variant ? [{ label: 'Edit token metadata', icon: <Settings2 aria-hidden="true" />, run: () => metadata(path) },
          { label: 'Copy token', icon: <Copy aria-hidden="true" />, run: () => copy(path) }] : []),
        { label: 'Rename token', icon: <TextCursorInput aria-hidden="true" />, disabled: !!entry.inheritedFrom || !canStructure(path), run: () => rename(path) },
        { label: 'Move token', icon: <ArrowRightLeft aria-hidden="true" />, disabled: !!entry.inheritedFrom || !canStructure(path), run: () => move(path) },
        { label: 'Duplicate token', icon: <Copy aria-hidden="true" />, disabled: !canStructure(path), run: () => duplicate(path) },
        !variant && entry.overrides && !entry.inheritedFrom
          ? { label: 'Use inherited value', icon: <Undo2 aria-hidden="true" />, run: () => restoreInherited(path) }
          : { label: 'Delete token', icon: <Trash2 aria-hidden="true" />, disabled: !!entry.inheritedFrom || !canStructure(path), run: () => remove(path), destructive: true }]],
    });
    return true;
  }
  const keyboardHelp = useId();
  const editing = draft && !draft.create && draft.mode !== 'inspector' ? draft : null;
  const popover = editing?.mode === 'details' ? editing : null;
  const linking = editing?.mode === 'link' ? editing : null;
  const visibleColumns = narrow ? narrowColumns : columns;
  const table = useRef<HTMLTableElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const { widths, resize, checkboxWidth } = useGridWidths(visibleColumns, container);
  const tabStop = useRef<HTMLElement | null>(null);
  const rememberedCell = useRef({ row: 0, selector: '[data-edit-column="name"]' });
  useLayoutEffect(() => {
    if (tabStop.current?.isConnected) return;
    tabStop.current = gridEntryControl() ?? null;
    tabStop.current?.setAttribute('tabindex', '0');
  });

  function gridEntryControl() {
    if (tabStop.current?.isConnected) return tabStop.current;
    const displayed = table.current?.tBodies[0]?.rows;
    const { row, selector } = rememberedCell.current;
    const nearest = displayed?.[Math.min(row, displayed.length - 1)];
    return nearest?.querySelector<HTMLElement>(selector) ??
      nearest?.querySelector<HTMLElement>('[data-edit-column="name"]');
  }

  function rememberFocus(event: FocusEvent<HTMLTableElement>) {
    const target = event.target;
    if (target === event.currentTarget && rows.length) {
      focusGridControl(gridEntryControl());
      return;
    }
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest<HTMLTableRowElement>('[data-token-row]');
    if (!row || !target.matches('[data-edit-column], input[type="checkbox"]')) return;
    const column = target.dataset['editColumn'];
    rememberedCell.current = { row: row.sectionRowIndex, selector: column ? '[data-edit-column="' + column + '"]' : 'input[type="checkbox"]' };
    if (tabStop.current !== target) tabStop.current?.setAttribute('tabindex', '-1');
    tabStop.current = target;
    target.tabIndex = 0;
  }
  const editOrder: readonly EditableColumn[] = narrow ? narrowColumns : editableColumns;

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

  function selectRange(to: string, focused?: string) {
    const { checked, selected } = gridSelection.getSnapshot();
    const from = rows.findIndex(([path]) => path === (focused ?? selected));
    const end = rows.findIndex(([path]) => path === to);
    if (end < 0) return;
    // A new checked set or page means another action ended the range.
    const previous = range.current;
    const continuing = previous?.rows === rows && previous.checked === checked && previous.end === from ? previous : null;
    if (continuing?.end === end) return;
    const pointerStart = focused === undefined && checked.size ? rows.findIndex(([path]) => path === pointerAnchor.current) : -1;
    const start = continuing?.start ?? (pointerStart >= 0 ? pointerStart : from >= 0 ? from : end);
    const baseline = continuing?.baseline ?? checked;
    const next = new Set(baseline);
    for (const [path] of rows.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(path);
    range.current = { rows, start, end, baseline, checked: next };
    gridSelection.setChecked(next);
  }

  function anchorRow(path: string) {
    range.current = null;
    pointerAnchor.current = path;
  }

  function selectRow(path: string, toggle: boolean) {
    anchorRow(path);
    gridSelection.setChecked(previous => {
      if (!toggle && previous.size === 1 && previous.has(path)) return previous;
      const next = toggle ? new Set(previous) : new Set<string>();
      if (toggle && next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function openMenuFromGrid(target: Element, keyboard: boolean) {
    const row = target.closest<HTMLElement>('[data-token-row]');
    const nearestCell = target.closest<HTMLElement>('[data-edit-column], input[type="checkbox"]');
    const cell = row ? nearestCell ?? row.querySelector<HTMLElement>('[data-edit-column="name"]') :
      keyboard ? gridEntryControl() : null;
    const path = cell?.closest<HTMLElement>('[data-token-row]')?.dataset['tokenRow'];
    return !!(cell && path && openRowMenu(cell, path));
  }

  function showContextMenu(event: MouseEvent<HTMLDivElement>) {
    if (draft || busy || !(event.target instanceof Element) ||
      event.target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable]')) return;
    if (openMenuFromGrid(event.target, event.button !== 2)) event.preventDefault();
  }

  function moveGridFocus(control: HTMLElement | null | undefined, keepRange = false) {
    const previous = document.activeElement;
    focusGridControl(control);
    if (!keepRange && document.activeElement !== previous) range.current = null;
  }

  function navigateCells(event: KeyboardEvent<HTMLDivElement>) {
    pointerCell.current = null;
    if (event.key === 'Tab') {
      range.current = null;
      if (!draft && event.target instanceof HTMLElement && event.target !== tabStop.current &&
        container.current?.contains(event.target)) {
        gridEntryControl()?.focus({ preventScroll: true });
      }
      return;
    }
    if (draft || busy || event.nativeEvent.isComposing || !(event.target instanceof HTMLElement)) return;
    const command = event.ctrlKey || event.metaKey;
    const menuKey = !command && (event.altKey ? !event.shiftKey && event.key === 'ArrowDown' :
      event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10');
    if (menuKey && openMenuFromGrid(event.target, true)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const cell = event.target.closest<HTMLElement>('[data-edit-column]');
    if (event.altKey) {
      if (cell && !command && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const index = visibleColumns.findIndex(column => column === cell.dataset['editColumn']);
        if (index < 0) return;
        event.preventDefault();
        const rtl = getComputedStyle(cell).direction === 'rtl';
        const step = (event.key === 'ArrowRight') !== rtl ? 8 : -8;
        resize(index, (widths[index] ?? 0) + step);
      }
      return;
    }
    const checkbox = event.target.closest<HTMLInputElement>('input[type="checkbox"]');
    const row = event.target.closest<HTMLElement>('[data-token-row]');
    if (checkbox?.closest('thead') && event.key === 'ArrowDown') {
      event.preventDefault();
      moveGridFocus(table.current?.querySelector<HTMLElement>('tbody input[type="checkbox"]'));
      return;
    }
    const path = row?.dataset['tokenRow'];
    if (!row || !path || !cell && !checkbox) return;
    const location = cell?.dataset['editColumn'];
    if (event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (command && event.shiftKey) return;
      selectRow(path, !event.shiftKey);
      return;
    }
    if (command && event.key.toLowerCase() === 'a') {
      range.current = null;
      event.preventDefault();
      setPageChecked(gridSelection, rows, true);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const end = event.key === 'End';
      const column = end ? visibleColumns.at(-1) : visibleColumns[0];
      const edge = command ? rows.at(end ? -1 : 0)?.[0] : path;
      const target = edge === path ? row : event.currentTarget.querySelector<HTMLElement>('[data-token-row="' + CSS.escape(edge ?? '') + '"]');
      moveGridFocus(target?.querySelector<HTMLElement>('[data-edit-column="' + column + '"]'));
      return;
    }
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    if (!vertical && !horizontal) return;
    event.preventDefault();
    event.stopPropagation();
    if (horizontal) {
      const index = visibleColumns.findIndex(field => field === location);
      const right = event.key === 'ArrowRight';
      const next = command ? right ? visibleColumns.length - 1 : 0 : index + (right ? 1 : -1);
      if (visibleColumns[next]) moveGridFocus(row.querySelector<HTMLElement>('[data-edit-column="' + visibleColumns[next] + '"]'), event.shiftKey);
      else if (next === -1) moveGridFocus(row.querySelector<HTMLInputElement>('input[type="checkbox"]'), event.shiftKey);
      return;
    }
    const up = event.key === 'ArrowUp';
    const index = command ? (up ? 0 : rows.length - 1) : rows.findIndex(([id]) => id === path) + (up ? -1 : 1);
    const to = rows[index]?.[0];
    if (!to) {
      if (checkbox && up && !command && !event.shiftKey) {
        moveGridFocus(table.current?.querySelector<HTMLElement>('thead input[type="checkbox"]'));
      }
      return;
    }
    if (event.shiftKey) selectRange(to, path);
    const control = location ? '[data-edit-column="' + location + '"]' : 'input[type="checkbox"]';
    moveGridFocus(event.currentTarget.querySelector<HTMLElement>('[data-token-row="' + CSS.escape(to) + '"] ' + control), event.shiftKey);
  }

  // Keep event handlers separate from the memoized grid rows. Layout
  // effects publish the latest committed editor actions before browser input.
  const editorActions: GridActions = {
    select, edit, inspect, setDraft, commit, cancel, openRowMenu, selectRange, selectRow, afterEdit,
    anchorRow,
    focusCell: (button, path, field) => {
      if (pointerCell.current !== button && !editing) select(path, field);
    },
    pointerDown: button => { pointerCell.current = button; },
    clearPointer: () => { pointerCell.current = null; },
  };
  const actions = useRef(editorActions);
  useLayoutEffect(() => { actions.current = editorActions; });

  const tableRows = useMemo(() => rows.length ? <>
        {rows.map(([path, entry], index) => {
          const { node, type, value } = entry;
          const name = tokenDisplayName(group ? path.slice(group.length + 1) : path);
          const issue = definition && !activeValueGraph ? undefined : valueGraph.issues.get(path);
          const invalid = valueGraph.validation.get(path)?.join('\n');
          const effectiveValue = valueGraph.resolved.get(path);
          const effectiveToken = activeValueGraph?.tokens.get(path);
          const absent = !!activeValueGraph && !effectiveToken;
          const source = resolution && winningOrigins(resolution, path).at(-1);
          const authoredSource = definition && winningOrigins(definition, path).at(-1);
          const differentDefinition = source && authoredSource && (source.file !== authoredSource.file ||
            source.parts.length !== authoredSource.parts.length || source.parts.some((part, offset) => part !== authoredSource.parts[offset]));
          const resolvedValue = absent ? <span className="copy-small tone-supporting">Not included in {previewLabel}</span> :
            issue || invalid ? <span title={issue ?? invalid} className="flex items-center gap-space50 copy-small tone-error">
              <AlertCircle className="swatch-sm shrink-0" aria-hidden="true" /> {issue ? 'Unresolved' : 'Invalid'}</span> :
            (activeValueGraph || JSON.stringify(value) !== JSON.stringify(effectiveValue)) ? <TokenValue value={effectiveValue} swatch={(effectiveToken?.type ?? type) === 'color'} /> : null;
          const resolved = differentDefinition && source ? <span className="block">
            {resolvedValue}<span className="block truncate copy-small tone-supporting">From {originName(source)}</span>
          </span> : resolvedValue;
          const origin = node.$type ? 'Declared on token' : entry.referenceType ? 'Inferred from reference' :
            type ? 'Inherited from group' : 'Type unavailable';
          const values = {
            name: <><span className="token-name block truncate text-left code-text copy-small" dir={narrow ? undefined : "rtl"} title={entry.inheritedFrom ? 'Inherited from ' + entry.inheritedFrom.path + ' · ' + entry.inheritedFrom.file : path}>
              <bdi>{name}</bdi>{entry.inheritedFrom && <span className="margin-start-space100 copy-proportional tone-supporting">Inherited</span>}
              {!entry.inheritedFrom && entry.overrides && <span className="margin-start-space100 copy-proportional tone-supporting">Override</span>}
            </span>{!definition && source && <span className="block truncate copy-small tone-supporting" title={source.file}>
              {originName(source)}
            </span>}</>,
            value: <><TokenValue value={value} authored containsReferences={!!graph.dependencies.get(path)?.size} />
              {narrow && resolved && (activeValueGraph || issue || invalid || graph.links.has(path)) && <span className="block">{resolved}</span>}</>,
            resolved,
            type: <span className="truncate copy-small" title={origin}>{type ?? '—'}</span>,
            description: <span className="truncate copy-small tone-supporting" title={node.$description}>{node.$description}</span>,
          };
          return <tr key={path} aria-selected="false" data-token-row={path}>
            <td className="p-0 text-center">
              <RowSelection {...{ path, gridSelection, actions }} disabled={!!draft || busy} />
            </td>
            {visibleColumns.map(field => {
              const currentEdit = editing?.path === path && editing.column === field ? editing : null;
              const Tag = field === 'name' ? 'th' : 'td';
              return <Tag key={field} scope={field === 'name' ? 'row' : undefined}
                ref={currentEdit ? anchor : undefined} data-inline-type={field === 'type' && currentEdit?.mode === 'inline' || undefined}
                className="min-w-0 p-0 copy-regular">
                <GridCell {...{ path, field, entry, index, variant, actions, gridSelection }}
                  draft={currentEdit} disabled={!!draft || busy} error={currentEdit ? error : ''}
                  stacked={field === 'name' && !definition && !!source || field === 'value' && narrow && !!resolved}>
                  {values[field]}
                </GridCell>
              </Tag>;
            })}
          </tr>;
        })}
  </> : <tr><td colSpan={visibleColumns.length + 1}><p className="pad-space400 text-center tone-supporting">No matching tokens.</p></td></tr>,
  [actions, activeValueGraph, anchor, busy, definition, draft, editing, error, graph, gridSelection, group, narrow, previewLabel,
    resolution, rows, valueGraph, variant, visibleColumns]);

  return <>
    <p className="sr-only" id={keyboardHelp}>Use arrow keys to navigate. Space toggles the row. Shift with Up or Down adds a range from the focused row. From the first row checkbox, press Up to reach the select-all checkbox.
      {variant && !definition ? ' Enter or F2 opens the token editor.' : ' Enter or F2 edits a cell.'}
      {' Alt+Down or Shift+F10 opens token actions.'} Escape cancels an edit or clears selection.</p>
    <div className="contents" onKeyDownCapture={navigateCells} onContextMenuCapture={showContextMenu}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) range.current = null; }}>
      <div ref={container} tabIndex={-1} data-slot="table-container" className="h-full w-full overflow-auto">
        <table ref={table} id="token-grid" {...gridSemantics} tabIndex={rows.length ? -1 : 0} aria-describedby={keyboardHelp} aria-keyshortcuts="Alt+ArrowDown Shift+F10"
          className="foundry-table w-full table-fixed copy-body [&_th:not(:last-child)]:border-e [&_td:not(:last-child)]:border-e"
          style={{ minWidth: widths.reduce((sum, width) => sum + width, checkboxWidth) }} onFocusCapture={rememberFocus}>
          <colgroup>
            <col style={{ width: checkboxWidth }} />
            {visibleColumns.map((column, index) => <col key={column} style={{ width: widths[index] }} />)}
          </colgroup>
          <thead className="sticky top-0 z-10"><tr>
            <th scope="col" aria-label="Selection" className="text-center">
              <PageSelection {...{ rows, gridSelection }} disabled={!!draft || busy} />
            </th>
            {visibleColumns.map((column, index) => <th key={column} scope="col" aria-label={column === 'resolved' ? resolvedHeading : labels[column]} className="relative table-head-row pad-inline-space100 pad-end-space200 text-start copy-emphasis">
              {column === 'resolved' ? resolvedHeading : labels[column]}
              <GridColumnResizer {...{ index, column, widths, resize }} columns={visibleColumns} label={labels[column]} />
            </th>)}
          </tr></thead>
          <tbody>{tableRows}</tbody>
        </table>
      </div>
    </div>
    <RowCommandMenu ref={rowMenu} />
    {linking && <TokenReferenceDialog draft={linking} graph={graph} type={graph.tokens.get(linking.path)?.type}
      seed={linking.value.startsWith('{') && !linking.value.endsWith('}') ? linking.value.slice(1) : ''}
      choose={value => commit({ ...linking, value })} applyRawValue={commit} close={() => cancel()} error={error} />}
    {popover && <EditorPopover anchor={anchor} label={'Edit ' + labels[popover.column].toLowerCase()} onDismiss={cancel}>
      <TokenEditForm initialDraft={popover} onDraftChange={setDraft} {...{ graph, cancel, error, busy, commit }} />
    </EditorPopover>}
  </>;
}
