import { useId, useRef, useState } from 'react';
import { Button, IconButton, TextField } from '@token-catalog/forge-react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { isJsonObject, parseJson } from '../lib/json.ts';
import type { JsonObject, JsonValue } from '../lib/json.ts';

export type ResolverSourceOption = { label: string; reference: string };
type Draft = { id: number; text: string; inline: boolean };
export type ContextDraft = { id: number; name: string; sources: Draft[] };

function draftSources(value: JsonValue | undefined): Draft[] {
  if (!Array.isArray(value)) return [];
  return value.map((source: JsonValue, id) => {
    if (isJsonObject(source) && typeof source['$ref'] === 'string' && Object.keys(source).length === 1) {
      return { id, inline: false, text: source['$ref'] };
    }
    return { id, inline: true, text: JSON.stringify(source, null, 2) };
  });
}

export function sourceValues(sources: Draft[]): JsonObject[] {
  return sources.map(({ text, inline }, index) => {
    if (!inline) {
      if (!text.trim()) throw new Error('Enter a reference for source ' + (index + 1) + '.');
      return { $ref: text };
    }
    const object = parseJson(text);
    if (!isJsonObject(object)) throw new Error('Source ' + (index + 1) + ' must be an object.');
    return object;
  });
}

export function useResolverSourceDraft(initial: JsonObject | undefined) {
  const [sources, setSources] = useState(() => draftSources(initial?.['sources']));
  const [contexts, setContexts] = useState<ContextDraft[]>(() => {
    const values = initial?.['contexts'];
    return isJsonObject(values) ? Object.entries(values).map(([name, source], id) => ({ id, name, sources: draftSources(source) })) : [];
  });
  return { sources, setSources, contexts, setContexts };
}

export function ResolverSourceFields({ sources, setSources, options }: {
  sources: Draft[]; setSources: (next: Draft[]) => void; options: ResolverSourceOption[];
}) {
  const id = useId();
  const [picked, setPicked] = useState('');
  const addReference = useRef<HTMLButtonElement>(null);
  function add(inline: boolean, text: string) {
    setSources([...sources, { id: 1 + Math.max(-1, ...sources.map(source => source.id)), inline, text }]);
  }
  function move(index: number, delta: number) {
    const next = sources.slice();
    const [source] = next.splice(index, 1);
    if (source) next.splice(index + delta, 0, source);
    setSources(next);
  }
  return <fieldset className="grid gap-2">
    <legend className="text-sm font-medium">Ordered sources</legend>
    {!sources.length && <p className="text-xs text-muted-foreground">No sources</p>}
    <ol className="grid gap-2">{sources.map((source, index) => {
      const label = 'Source ' + (index + 1);
      const field = id + '-source-' + source.id;
      const update = (text: string) => setSources(sources.map(item => item.id === source.id ? { ...item, text } : item));
      return <li key={source.id} className="grid gap-1 rounded-lg border p-2">
        <div className="flex items-center justify-between gap-2">
          {source.inline ? <label htmlFor={field} className="text-xs font-medium">{label} · Inline tokens</label> :
            <span className="text-xs font-medium">{label}</span>}
          <span className="flex shrink-0">
            <IconButton type="button" size="xsmall" label={'Move source ' + (index + 1) + ' up'} disabled={!index} onClick={() => move(index, -1)}><ArrowUp aria-hidden="true" /></IconButton>
            <IconButton type="button" size="xsmall" label={'Move source ' + (index + 1) + ' down'} disabled={index + 1 === sources.length} onClick={() => move(index, 1)}><ArrowDown aria-hidden="true" /></IconButton>
            <IconButton type="button" size="xsmall" label={'Remove source ' + (index + 1)} onClick={() => {
              addReference.current?.focus();
              setSources(sources.filter(item => item.id !== source.id));
            }}><Trash2 aria-hidden="true" /></IconButton>
          </span>
        </div>
        {source.inline ? <Textarea id={field} rows={4} value={source.text} spellCheck={false} className="font-mono text-xs" onChange={event => update(event.target.value)} /> :
          <TextField id={field} label={label + ' reference'} value={source.text} onChange={event => update(event.target.value)} />}
      </li>;
    })}</ol>
    {!!options.length && <div className="flex flex-wrap items-end gap-2">
      <div className="flex min-w-[min(100%,12rem)] flex-1 flex-col gap-1">
        <label className="text-xs" htmlFor={id + '-open'}>Open file or set</label>
        <NativeSelect id={id + '-open'} value={picked} onChange={event => setPicked(event.target.value)}>
          <NativeSelectOption value="">Choose…</NativeSelectOption>
          {options.map(option => <NativeSelectOption key={option.reference} value={option.reference}>{option.label}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      <Button type="button" size="small" variant="tonal" disabled={!picked} onClick={() => { add(false, picked); setPicked(''); }}>Add source</Button>
    </div>}
    <div className="flex flex-wrap gap-2">
      <Button ref={addReference} type="button" size="small" variant="text" onClick={() => add(false, '')}>Add reference</Button>
      <Button type="button" size="small" variant="text" onClick={() => add(true, '{}')}>Add inline tokens</Button>
    </div>
  </fieldset>;
}
