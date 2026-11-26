import { useId, useRef, useState } from 'react';
import { Button, Disclosure, IconButton, TextField, Select, SelectOption } from '@token-catalog/forge-react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { isJsonObject, parseJson } from '../lib/json.ts';
import { InlineSourceEditor } from './inline-source-editor.tsx';
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

export function ResolverSourceFields({ sources, setSources, options, file }: {
  sources: Draft[]; setSources: (next: Draft[]) => void; options: ResolverSourceOption[]; file: string;
}) {
  const id = useId();
  const [picked, setPicked] = useState('');
  const [query, setQuery] = useState('');
  const displayed = options.filter(option => option.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 100);
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
  return <fieldset className="grid gap-space100">
    <legend className="copy-body copy-emphasis">Ordered sources</legend>
    {!sources.length && <p className="copy-small tone-supporting">No sources</p>}
    <ol className="grid gap-space100">{sources.map((source, index) => {
      const label = 'Source ' + (index + 1);
      const field = id + '-source-' + source.id;
      const update = (text: string) => setSources(sources.map(item => item.id === source.id ? { ...item, text } : item));
      return <li key={source.id} className="grid gap-space50 rounded-lg border pad-space100">
        <div className="flex items-center justify-between gap-space100">
          <span className="copy-small copy-emphasis">{label}{source.inline ? ' · Inline tokens' : ''}</span>
          <span className="flex shrink-0">
            <IconButton type="button" size="xsmall" label={'Move source ' + (index + 1) + ' up'} disabled={!index} onClick={() => move(index, -1)}><ArrowUp aria-hidden="true" /></IconButton>
            <IconButton type="button" size="xsmall" label={'Move source ' + (index + 1) + ' down'} disabled={index + 1 === sources.length} onClick={() => move(index, 1)}><ArrowDown aria-hidden="true" /></IconButton>
            <IconButton type="button" size="xsmall" label={'Remove source ' + (index + 1)} onClick={() => {
              addReference.current?.focus();
              setSources(sources.filter(item => item.id !== source.id));
            }}><Trash2 aria-hidden="true" /></IconButton>
          </span>
        </div>
        {source.inline ? <>
          <InlineSourceEditor text={source.text} file={file} write={update} />
          <Disclosure compact label="Inline source JSON">
            <Textarea aria-label={label + ' · Inline tokens'} rows={4} value={source.text} spellCheck={false}
              className="code-editor" onChange={event => update(event.target.value)} />
          </Disclosure>
        </> : <div className="grid gap-space100">
          <Select id={field} label="Source target" value={source.text} onChange={event => update(event.target.value)}>
            {!displayed.some(option => option.reference === source.text) && <SelectOption value={source.text}>{options.find(option => option.reference === source.text)?.label ?? (source.text || 'Choose a source')}</SelectOption>}
            {displayed.map(option => <SelectOption key={option.reference} value={option.reference}>{option.label}</SelectOption>)}
          </Select>
          <Disclosure compact label="Reference path">
            <TextField label={label + ' reference'} value={source.text} onChange={event => update(event.target.value)} />
          </Disclosure>
        </div>}
      </li>;
    })}</ol>
    {options.length > 100 && <TextField label="Filter source targets" value={query} onChange={event => { setQuery(event.target.value); setPicked(''); }} />}
    {!!options.length && <div className="flex flex-wrap items-end gap-space100">
      <div className="resolver-field-min flex flex-1 flex-col">
        <Select id={id + '-open'} label="Open file or set" value={picked} onChange={event => setPicked(event.target.value)}>
          <SelectOption value="">Choose…</SelectOption>
          {displayed.map(option => <SelectOption key={option.reference} value={option.reference}>{option.label}</SelectOption>)}
        </Select>
      </div>
      <Button type="button" size="small" variant="tonal" disabled={!picked} onClick={() => { add(false, picked); setPicked(''); }}>Add source</Button>
    </div>}
    <div className="flex flex-wrap gap-space100">
      <Button ref={addReference} type="button" size="small" variant="text" onClick={() => add(false, '')}>Add reference path</Button>
      <Button type="button" size="small" variant="text" onClick={() => add(true, '{}')}>Add inline tokens</Button>
    </div>
  </fieldset>;
}
