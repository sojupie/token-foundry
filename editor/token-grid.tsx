import { Fragment, useEffect, useRef } from 'react';
import { AlertCircle, ArrowRight, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { inputFormat } from './lib/token-input';

import type { ChangeEvent, KeyboardEvent } from 'react';
import { isJsonObject } from '../lib/json.ts';
import type { JsonValue } from '../lib/json.ts';
import { colorHex } from '../lib/color.ts';
import { isColor, isDimension, isTypography } from '../lib/token-types.ts';
import type { DocumentGraph, TokenEntry } from '../lib/document.ts';
import type { Draft } from './lib/draft.ts';

const cell = 'overflow-hidden px-3 py-1.5 whitespace-normal';
export const types = ['color', 'dimension', 'fontFamily', 'fontWeight', 'duration', 'cubicBezier', 'number',
  'strokeStyle', 'border', 'transition', 'shadow', 'gradient', 'typography'];

function describe(value: JsonValue | undefined): string {
  if (value === undefined) return '—';
  if (isDimension(value)) return value.value + ' ' + value.unit;
  if (isTypography(value)) return describe(value.fontSize) + ' · ' + value.fontFamily;
  if (isJsonObject(value) && typeof value['$ref'] === 'string') return value['$ref'];
  if (isColor(value) && value.colorSpace === 'srgb') return colorHex(value);
  if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join(', ');
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function Value({ value, swatch = false }: { value: JsonValue | undefined; swatch?: boolean }) {
  const text = describe(value);
  const alpha = isColor(value) ? value.alpha ?? 1 : 1;
  return <span className="flex min-w-0 items-center gap-2 font-mono text-xs" title={text}>
    {swatch && /^#[0-9A-F]{6}$/iu.test(text) && <span aria-hidden="true" className="size-3.5 shrink-0 rounded-sm border"
      style={{ backgroundColor: text, opacity: alpha }} />}
    <span className="truncate">{text}{swatch && alpha < 1 ? ' · ' + Math.round(alpha * 100) + '%' : ''}</span>
  </span>;
}

interface DraftProps {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  typeOptions: readonly string[];
  busy: boolean;
  group: string;
  destinations: readonly string[];
}

function EditCells({ draft, setDraft, typeOptions, onKeyDown, inheritedType, busy, group, resolved, destinations, references }: DraftProps & {
  resolved: JsonValue | undefined; inheritedType: string | undefined; references: string[]; onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => void;
}) {
  const name = useRef<HTMLInputElement>(null);
  const value = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => {
    const focus = draft.create ? name.current : value.current;
    focus?.focus();
    focus?.select();
  }, [draft.create]);
  const set = (key: 'name' | 'file' | 'type' | 'value' | 'description') => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    if ((key === 'name' || key === 'file') && !draft.create) return;
    setDraft({ ...draft, [key]: event.target.value });
  };
  const format = inputFormat(draft.type || inheritedType, draft.original);
  const color = /^#[0-9a-f]{6}$/iu.test(draft.value) ? draft.value :
    isColor(resolved) && resolved.colorSpace === 'srgb' ? colorHex(resolved) : '#000000';
  return <TableRow data-state="selected" onKeyDown={onKeyDown}>
    <TableCell className={cell}>{draft.create ? <div className="grid gap-2">
      <Input ref={name} disabled={busy} aria-label={draft.groupOnly ? 'Group name' : 'Token name'} value={draft.name} onChange={set('name')} />
      {destinations.length > 1 && <NativeSelect size="sm" disabled={busy} className="max-w-full"
        aria-label="Destination file" value={draft.file} onChange={set('file')}>
        <NativeSelectOption value="">Choose destination file</NativeSelectOption>
        {destinations.map((file) => <NativeSelectOption key={file} value={file}>{file}</NativeSelectOption>)}
      </NativeSelect>}
    </div> : <span className="font-mono text-xs" title={draft.path}>{group ? draft.path.slice(group.length + 1) : draft.path}</span>}</TableCell>
    <TableCell className={cell}>{!draft.groupOnly && <div className="grid gap-2">
      {format === 'json' ?
        <Textarea ref={(element) => { value.current = element; }} aria-label="Token value" placeholder="JSON or token reference" rows={2} spellCheck={false}
          disabled={busy} className="min-h-9 resize-y font-mono text-xs" value={draft.value} onChange={set('value')} /> :
        <div className="flex items-center gap-2">
          {format === 'hex' && <Input type="color" aria-label="Pick color" value={color} onChange={set('value')} disabled={busy} className="h-8 w-8 shrink-0 p-1" />}
          <Input ref={(element) => { value.current = element; }} aria-label="Token value" placeholder={format === 'hex' ? '#336699' : undefined} spellCheck={false}
            disabled={busy} className="font-mono text-xs" value={draft.value} onChange={set('value')} />
        </div>}
      {references.length > 0 && <NativeSelect size="sm" aria-label="Choose token reference" value={references.find((path) => draft.value === '{' + path + '}') ?? ''}
        onChange={(event) => { if (event.target.value) setDraft({ ...draft, value: '{' + event.target.value + '}' }); }} disabled={busy} className="max-w-full">
        <NativeSelectOption value="">Choose reference</NativeSelectOption>
        {references.map((path) => <NativeSelectOption key={path} value={path}>{path}</NativeSelectOption>)}
      </NativeSelect>}
    </div>}</TableCell>
    <TableCell className={cell}>
      <span aria-label="Last saved resolved value"><Value value={resolved} swatch={draft.type === 'color'} /></span>
    </TableCell>
    <TableCell className={cell}>{draft.create && !draft.groupOnly ?
      <NativeSelect size="sm" disabled={busy} aria-label="Token type" value={draft.type ?? ''} onChange={set('type')}>
        {typeOptions.map((type) => <NativeSelectOption key={type} value={type}>{type || 'Inherit'}</NativeSelectOption>)}
      </NativeSelect> : draft.type}</TableCell>
    <TableCell className={cell}>
      <Input disabled={busy} aria-label="Description" value={draft.description} onChange={set('description')} />
    </TableCell>
  </TableRow>;
}

interface TokenGridProps extends Omit<DraftProps, 'draft'> {
  rows: readonly [string, TokenEntry][];
  graph: DocumentGraph;
  selected: string;
  select: (path: string) => void;
  edit: (path: string) => void;
  draft: Draft | null;
  onEditKey: (event: KeyboardEvent<HTMLTableRowElement>) => void;
  related: boolean;
  jump: (path: string) => void;
}

export function TokenGrid({ rows, graph, group, selected, select, edit, draft, setDraft, typeOptions, onEditKey, related, jump, busy, destinations }: TokenGridProps) {
  function selectRow(path: string, row?: HTMLTableRowElement) {
    select(path);
    row?.focus({ preventScroll: true });
  }
  function navigate(event: KeyboardEvent<HTMLTableRowElement>, index: number, path: string) {
    if (draft || busy || event.target !== event.currentTarget) return;
    const key = event.key;
    if (key === 'Enter' || key === 'F2') {
      event.preventDefault();
      edit(path);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const next = key === 'Home' ? 0 : key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (key === 'ArrowDown' ? 1 : -1)));
    const table = event.currentTarget.closest('tbody');
    const row = table?.querySelectorAll<HTMLTableRowElement>('[data-token-row]')[next];
    const target = rows[next];
    if (target) selectRow(target[0], row);
    row?.scrollIntoView({ block: 'nearest' });
  }
  const folder = graph.groups.get(group);
  const inheritedType = draft?.create && draft.file ? folder?.files.get(draft.file) : folder?.type;
  const editType = draft?.type || inheritedType;
  const references = draft && !draft.groupOnly && editType ? [...graph.tokens].flatMap(([path, token]) =>
    path !== draft.path && token.type === editType && !graph.issues.has(path) ? [path] : []).toSorted() : [];
  const editor = draft && <EditCells {...{ draft, setDraft, typeOptions, busy, group, destinations, references, inheritedType }}
    resolved={draft.create ? undefined : graph.resolved.get(draft.path)} onKeyDown={onEditKey} />;
  const hasSelection = rows.some(([id]) => id === selected);
  return <Table aria-label="Tokens" className="min-w-[50rem] table-fixed [&_tbody_tr:last-child]:border-b">
    <TableHeader className="sticky top-0 z-10 bg-background">
      <TableRow className="hover:bg-background">
        <TableHead scope="col" className="w-[29%] px-3">Name</TableHead>
        <TableHead scope="col" className="w-[21%] px-3">Value</TableHead>
        <TableHead scope="col" className="w-[19%] px-3">Resolved value</TableHead>
        <TableHead scope="col" className="w-[13%] px-3">Type</TableHead>
        <TableHead scope="col" className="w-[18%] px-3">Description</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {draft?.create && editor}
      {rows.map(([path, entry], index) => {
        const { node, type, value, file } = entry;
        const name = group ? path.slice(group.length + 1) : path;
        const issue = graph.issues.get(path);
        if (draft?.path === path && !draft.create) return <Fragment key={path}>{editor}</Fragment>;
        return <Fragment key={path}>
          <TableRow data-token-row="" data-state={path === selected ? 'selected' : undefined}
            aria-current={path === selected ? 'true' : undefined} tabIndex={path === selected || (!hasSelection && index === 0) ? 0 : -1}
            className="cursor-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            onClick={(event) => { if (!draft) selectRow(path, event.currentTarget); }}
            onDoubleClick={() => edit(path)} onKeyDown={(event) => navigate(event, index, path)}>
            <TableCell className={cell}>
              <span className="flex items-center gap-2 font-mono text-xs">
                <span className="truncate" title={file ? path + '\n' + file : path}>{name}</span>
              </span>
            </TableCell>
            <TableCell className={cell}><Value value={value} /></TableCell>
            <TableCell className={cell}>{issue ?
              <span title={issue} className="flex items-center gap-1.5 text-xs text-destructive"><AlertCircle className="size-3.5 shrink-0" aria-hidden="true" /> Unresolved</span> :
              <Value value={graph.resolved.get(path)} swatch={type === 'color'} />}</TableCell>
            <TableCell className={cell}><span className="text-xs text-muted-foreground">{type ?? '—'}</span></TableCell>
            <TableCell className={cell}><span className="block truncate text-xs text-muted-foreground" title={node.$description}>{node.$description}</span></TableCell>
          </TableRow>
          {related && path === selected && <TableRow><TableCell colSpan={5} className="bg-muted/30 px-3 py-3 whitespace-normal">
            {issue && <p className="mb-2 text-xs text-destructive">{issue}</p>}
            {([['References', graph.dependencies.get(path)], ['Used by', graph.usedBy.get(path)]] as const).map(([label, paths]) =>
              <div className="flex items-baseline gap-2" key={label}>
                <span className="shrink-0 text-xs font-medium">{label}</span>
                <div className="flex flex-wrap items-center gap-x-2">
                  {paths?.size ? [...paths].map((item) => graph.tokens.has(item) ?
                    <Button key={item} size="xs" variant="link" className="font-mono" onClick={() => jump(item)}>
                      <Link2 aria-hidden="true" />{item}<ArrowRight aria-hidden="true" />
                    </Button> : <code key={item} className="text-xs">{item}</code>) : <span className="text-xs text-muted-foreground">None</span>}
                </div>
              </div>)}
          </TableCell></TableRow>}
        </Fragment>;
      })}
      {!rows.length && !draft?.create && <TableRow><TableCell colSpan={5} className="p-8 text-center text-sm text-muted-foreground">No matching tokens.</TableCell></TableRow>}
    </TableBody>
  </Table>;
}
