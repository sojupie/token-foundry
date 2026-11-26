import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ActionDialog } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ChevronLeft, ChevronRight, Folder, Search, X } from 'lucide-react';
import { ChipSelect, SelectOption, Button, IconButton, List, ListItemButton, TextField } from '@token-catalog/forge-react';
import { fieldDependsOn, leafName, parentPath } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import type { JsonValue } from '../lib/json.ts';
import { colorSpace } from '../lib/color.ts';
import { isJsonObject } from '../lib/json.ts';
import { dtcgTypes } from '../lib/token-types.ts';
import { tokenFieldType, validateTokenValue } from '../lib/validate-token.ts';
import { FolderTree } from './folder-tree.tsx';
import { TokenValue } from './token-value.tsx';
import { tokenDisplayName, valueFieldLabel } from './lib/value-shape.ts';

const limit = 50;

function focusFirstField(button: HTMLButtonElement | null) {
  button?.focus({ preventScroll: true });
}

export interface ReferenceChoice {
  path: string;
  field: readonly string[];
}

interface FieldChoice { field: readonly string[]; value: JsonValue; type: string }

function validField(type: string, value: JsonValue, expected: string | undefined): boolean {
  switch (expected) {
    case undefined: break;
    case 'fontName': return type === 'fontFamily' && typeof value === 'string';
    case 'numberOrNone': return type === 'number' && (value === 'none' || typeof value === 'number');
    case 'dimensionUnit': return type === 'string' && (typeof value === 'string' && ['px', 'rem', 'dp', 'sp'].includes(value));
    case 'durationUnit': return type === 'string' && (value === 'ms' || value === 's');
    case 'lineCap': return type === 'string' && (value === 'butt' || value === 'round' || value === 'square');
    case 'colorSpace': return type === 'string' && typeof value === 'string' && !!colorSpace(value);
    case 'hex': return type === 'string' && typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value);
  }
  if (expected && expected !== type) return false;
  switch (type) {
    case 'string': return expected === type && typeof value === 'string';
    case 'boolean': return expected === type && typeof value === 'boolean';
    case 'shadowLayer': return expected === type && isJsonObject(value) && !validateTokenValue('shadow', value);
    case 'gradientStop': return expected === type && isJsonObject(value) && !validateTokenValue('gradient', [value]);
    case 'colorComponents': return expected === type && Array.isArray(value) && value.length === 3;
    case 'dashArray': return expected === type && Array.isArray(value) && value.every(item => !validateTokenValue('dimension', item));
    default: return dtcgTypes.some(known => known === type) && !validateTokenValue(type, value);
  }
}

function wholeTypeMatches(expected: string | undefined, type: string | undefined, value: JsonValue | undefined) {
  return !expected || expected === type || expected === 'shadowLayer' && type === 'shadow' && isJsonObject(value) ||
    expected === 'fontName' && type === 'fontFamily' && typeof value === 'string' ||
    expected === 'numberOrNone' && type === 'number' && typeof value === 'number';
}

function findFields(value: JsonValue | undefined, type: string | undefined): FieldChoice[] {
  const matches: FieldChoice[] = [];
  function visit(node: JsonValue | undefined, parentType: string | undefined, prefix: readonly string[]) {
    if (!isJsonObject(node) && !Array.isArray(node)) return;
    for (const [key, item] of Object.entries(node)) {
      const fieldType = tokenFieldType(parentType, [key]);
      if (item === undefined || fieldType === undefined) continue;
      const field = [...prefix, key];
      matches.push({ field, value: item, type: fieldType });
      visit(item, fieldType, field);
    }
  }
  visit(value, type, []);
  return matches;
}

const fieldIndexes = new WeakMap<DocumentGraph, Map<string, FieldChoice[]>>();

function indexedFields(graph: DocumentGraph, path: string, type: string | undefined, expected: string | undefined) {
  let index = fieldIndexes.get(graph);
  if (!index) {
    index = new Map();
    fieldIndexes.set(graph, index);
  }
  let fields = index.get(path);
  if (!fields) {
    fields = findFields(graph.resolved.get(path), type);
    for (const { field, value } of graph.partialFields.get(path) ?? []) {
      const fieldType = tokenFieldType(type, field);
      if (fieldType) fields.push({ field, value, type: fieldType });
    }
    index.set(path, fields);
  }
  return fields.filter(item => validField(item.type, item.value, expected));
}

function equalChoice(choice: ReferenceChoice | undefined, path: string, field: readonly string[]): boolean {
  return choice?.path === path && choice.field.length === field.length && field.every((part, index) => choice.field[index] === part);
}

interface ReferenceOptions {
  graph: DocumentGraph; source: string; type: string | undefined; target: ReferenceChoice | undefined;
  seed: string; flexible: boolean; sourceField?: readonly string[]; sourcePaths?: readonly string[] | undefined;
}

export function ReferenceDialog({ choose, close, error, renderRawForm, initialRaw = false, ...options }: ReferenceOptions & {
  choose: (choice: ReferenceChoice) => boolean | void; close: () => void; error?: string;
  initialRaw?: boolean;
  renderRawForm?: (id: string, close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [raw, setRaw] = useState(initialRaw);
  const rawFormId = useId();
  const [target, setTarget] = useState(options.target);
  function apply() {
    if (target && choose(target) !== false) setOpen(false);
  }

  const dialog = <ActionDialog open={open} onOpenChange={setOpen} onAfterClose={close}
    title={raw ? 'Enter a value' : 'Link a token'} className={raw ? 'raw-value-dialog' : 'reference-dialog'} data-component-assets
    onKeyDown={event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }}
    actions={<>
      {renderRawForm && <Button variant="text" className="me-auto" onClick={() => setRaw(!raw)}>
        {raw ? 'Link a token' : 'Enter a value'}
      </Button>}
      {!raw && target && <span className="min-w-0 self-center break-all copy-small tone-supporting" aria-live="polite">
        {tokenDisplayName(target.path)}{target.field.length ? ' / ' + valueFieldLabel(target.field, options.graph.resolved.get(target.path) ??
          options.graph.tokens.get(target.path)?.value, options.graph.tokens.get(target.path)?.type) : ''}
      </span>}
      <Button variant="text" onClick={() => setOpen(false)}>Cancel</Button>
      {raw ? <Button type="submit" form={rawFormId}>Use value</Button> :
        <Button disabled={!target} onClick={apply}>Link token</Button>}
    </>}>
    <div className="reference-dialog-body">
      <ReferencePicker {...options} target={target} choose={setTarget} apply={apply} hidden={raw} />
      {raw && renderRawForm?.(rawFormId, () => setOpen(false))}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    </div>
  </ActionDialog>;
  return createPortal(dialog, document.body);
}

function ReferencePicker({ graph, source, sourceField, sourcePaths, type, target, seed, flexible, choose, apply, hidden }: ReferenceOptions & {
  choose: (choice: ReferenceChoice | undefined) => void; apply: () => void; hidden: boolean;
}) {
  const [group, setGroup] = useState(() => {
    let initial = target?.path ?? parentPath(source);
    while (!graph.groups.has(initial) && initial) initial = parentPath(initial);
    return initial;
  });
  const [fieldToken, setFieldToken] = useState(() => target?.field.length ? target.path : undefined);
  const [query, setQuery] = useState(seed);
  const [page, setPage] = useState(0);
  const [showAllTypes, setShowAllTypes] = useState(false);
  const filterType = showAllTypes ? undefined : type;
  const results = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const { candidates, allowed, tokenFields, blockedTokens } = useMemo(() => {
    const sources = sourcePaths ?? [source];
    const sourceSet = new Set(sources);
    const excluded = new Set(sourceSet);
    for (const path of excluded) {
      for (const consumer of graph.usedBy.get(path) ?? []) excluded.add(consumer);
    }
    const eligible = new Set<string>();
    const blocked = new Set<string>();
    const groups = new Set(['']);
    const fields = new Map<string, FieldChoice[]>();
    for (const [path, token] of graph.rows) {
      if (sourceSet.has(path) && !sourceField?.length) continue;
      const resolved = graph.resolved.get(path);
      const matches = indexedFields(graph, path, token.type, filterType);
      const eligibleFields = excluded.has(path) ? matches.filter(match => !sources.some(from => fieldDependsOn(graph, path, match.field, from, sourceField))) : matches;
      if (eligibleFields.length) fields.set(path, eligibleFields);
      const blocksToken = excluded.has(path) && (!sourceField?.length || sources.some(from => fieldDependsOn(graph, path, [], from, sourceField)));
      if (blocksToken) blocked.add(path);
      if (!eligibleFields.length && (blocksToken || graph.issues.has(path) || graph.validation.has(path) || !wholeTypeMatches(filterType, token.type, resolved))) continue;
      eligible.add(path);
      for (let parent = parentPath(path); !groups.has(parent); parent = parentPath(parent)) groups.add(parent);
    }
    return { candidates: eligible, allowed: groups, tokenFields: fields, blockedTokens: blocked };
  }, [graph, source, filterType, sourceField, sourcePaths]);

  const current = allowed.has(group) ? group : '';
  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/u).filter(Boolean), [query]);
  const matches = useMemo(() => terms.length
    ? [...candidates].filter((path) => terms.every(term => (path + ' ' + tokenDisplayName(path)).toLowerCase().includes(term)))
    : [...(graph.groups.get(current)?.members ?? [])].filter((path) => candidates.has(path)),
  [terms, candidates, graph, current]);
  const first = page * limit;
  const visible = matches.slice(first, first + limit);
  const children = (graph.groups.get(current)?.children ?? []).filter((path) => allowed.has(path));
  const count = matches.length;
  const fields = fieldToken === undefined ? undefined : tokenFields.get(fieldToken);
  const summary = count > limit ? (first + 1) + '–' + (first + visible.length) + ' of ' + count.toLocaleString('en') :
    terms.length ? count.toLocaleString('en') + (count === 1 ? ' match' : ' matches') :
      filterType ? filterType + ' tokens' : 'All token types';

  function canUseToken(path: string) {
    return !blockedTokens.has(path) && !graph.issues.has(path) && !graph.validation.has(path) && wholeTypeMatches(filterType, graph.tokens.get(path)?.type, graph.resolved.get(path));
  }

  function showFields(path: string) {
    if (target?.path !== path || !target.field.length) choose(undefined);
    setFieldToken(path);
    results.current?.parentElement?.scrollTo(0, 0);
  }

  function showPage(next: number) {
    setPage(next);
    results.current?.parentElement?.scrollTo(0, 0);
  }

  const browse = useCallback((path: string) => {
    setGroup(path);
    setFieldToken(undefined);
    setQuery('');
    setPage(0);
    results.current?.parentElement?.scrollTo(0, 0);
  }, []);

  function navigateResults(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = Array.from(results.current?.querySelectorAll('button') ?? []);
    const index = buttons.indexOf(event.currentTarget);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) search.current?.focus();
    else buttons[next]?.focus();
  }

  return <section aria-label="Link a reference" className="reference-picker" hidden={hidden}>
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-space100">
      <TextField
        ref={search}
        type="search"
        containerClassName="search-fill"
        label="Search tokens"
        leading={<Search aria-hidden="true" />}
        trailing={query ? (
          <IconButton size="xsmall" label="Clear token search" onClick={() => { setQuery(''); setFieldToken(undefined); showPage(0); search.current?.focus(); }}>
            <X aria-hidden="true" />
          </IconButton>
        ) : undefined}
        data-reference-search data-initial-focus value={query}
        onChange={(event) => { setQuery(event.target.value); setFieldToken(undefined); showPage(0); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            results.current?.querySelector('button')?.focus();
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.ctrlKey || event.metaKey) apply();
            else if (terms.length && visible[0]) {
              const path = visible[0];
              if (canUseToken(path)) choose({ path, field: [] });
              else showFields(path);
            }
          }
        }}
      />
      {flexible && type && <ChipSelect label="Reference type" selectedLabel={showAllTypes ? 'All types' : 'Compatible types'}
        value={showAllTypes ? 'all' : 'compatible'} onChange={event => { setShowAllTypes(event.target.value === 'all'); showPage(0); }}>
        <SelectOption value="compatible">Compatible types</SelectOption>
        <SelectOption value="all">All types</SelectOption>
      </ChipSelect>}
    </div>
    <div className="reference-picker-browser rounded-md border">
      <div className="reference-picker-groups muted-surface-subtle">
        <FolderTree groups={graph.groups} current={current} select={browse} allowed={allowed} label="Reference groups" />
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-space50 border-b picker-result-heading pad-inline-space100 pad-block-space50">
          {fields && <IconButton size="xsmall" label="Back to token results" onClick={() => { setFieldToken(undefined); search.current?.focus(); }}>
            <ChevronLeft aria-hidden="true" />
          </IconButton>}
          <h3 className="m-0 truncate copy-small copy-emphasis" title={fieldToken ?? current}>
            {fields ? 'Fields in ' + fieldToken : terms.length ? 'Search results' : current || 'All tokens'}
          </h3>
        </div>
        <div className="min-h-0 flex-1 overflow-auto pad-space50">
          <List ref={results} aria-label="Reference results" data-variant="segmented" data-surface="transparent">
            {fields && fieldToken && fields.map(({ field, value, type: fieldType }, index) => <li key={JSON.stringify(field)}>
              <ListItemButton ref={index === 0 ? focusFirstField : undefined} aria-pressed={equalChoice(target, fieldToken, field)}
                trailing={<TokenValue value={value} swatch={fieldType === 'color'} wrap />}
                onClick={() => choose({ path: fieldToken, field })} onKeyDown={navigateResults}>
                <span className="code-text copy-small wrap-anywhere">{valueFieldLabel(field, graph.resolved.get(fieldToken) ?? graph.tokens.get(fieldToken)?.value, graph.tokens.get(fieldToken)?.type)}</span>
              </ListItemButton>
            </li>)}
            {!fields && !terms.length && children.map((path) => <li key={path}>
              <ListItemButton leading={<Folder />}
                trailing={<span className="md-list-trailing-icon"><ChevronRight aria-hidden="true" /></span>}
                onClick={() => browse(path)} onKeyDown={navigateResults}>{leafName(path)}</ListItemButton>
            </li>)}
            {!fields && visible.map((path) => {
              const whole = canUseToken(path);
              const label = 'Browse fields in ' + path;
              const fieldControl = whole && tokenFields.has(path) ? <IconButton width="narrow" size="xsmall" label={label}
                onClick={() => showFields(path)} onKeyDown={navigateResults}><ChevronRight aria-hidden="true" /></IconButton> : undefined;
              return <li key={path}>
              <ListItemButton title={path} aria-label={whole ? tokenDisplayName(path) : label}
                aria-pressed={whole ? equalChoice(target, path, []) : undefined} actions={fieldControl}
                trailing={<TokenValue value={graph.resolved.get(path)} swatch={type === 'color'} wrap />}
                className="reference-value-choice"
                onClick={() => whole ? choose({ path, field: [] }) : showFields(path)} onKeyDown={navigateResults}>
                <span className="code-text copy-small wrap-anywhere">{tokenDisplayName(terms.length ? path : leafName(path))}</span>
              </ListItemButton>
              </li>;
            })}
          </List>
          {!fields && !visible.length && (terms.length > 0 || !children.length) &&
            <p className="pad-space100 copy-small tone-supporting">{terms.length ? 'No matching references.' : 'No compatible tokens in this group.'}</p>}
        </div>
      </div>
    </div>
    <div className="flex items-center justify-between gap-space100">
      <p className="copy-small tone-supporting">{summary}</p>
      {!fields && count > limit && <div className="flex items-center">
        <IconButton size="xsmall" label="Previous references" disabled={page === 0} onClick={() => showPage(page - 1)}>
          <ChevronLeft aria-hidden="true" />
        </IconButton>
        <IconButton size="xsmall" label="Next references" disabled={first + visible.length >= count} onClick={() => showPage(page + 1)}>
          <ChevronRight aria-hidden="true" />
        </IconButton>
      </div>}

    </div>
  </section>;
}
