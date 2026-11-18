import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChipSelect, Button, IconButton, SearchBar, TextField, Select, SelectOption } from '@token-catalog/forge-react';
import { ArrowDown, ArrowRightLeft, ArrowUp, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { ActionDialog } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, isJsonObject, parseJson } from '../lib/json.ts';
import type { JsonObject, JsonValue } from '../lib/json.ts';
import { compareContexts, isResolverFile, resolvedSnapshot, winningOrigins } from '../lib/resolver.ts';
import type { ResolverModel, ResolverOrigin, ResolverResolution } from '../lib/resolver.ts';
import { serializeTokenPointer, tokenPointer } from '../lib/token-path.ts';
import { reviewResolverValue, reviewSetPath } from '../lib/workspace.ts';
import type { ResolverEditScope, Review, Workspace } from '../lib/workspace.ts';
import { CommandMenu } from './command-bar.tsx';
import { download } from './lib/sources.ts';
import type { SourceLocation } from './source-dialog.tsx';
import { ResolverSourceFields, sourceValues, useResolverSourceDraft } from './resolver-source-fields.tsx';
import type { ResolverSourceOption } from './resolver-source-fields.tsx';
import { TokenValue } from './token-value.tsx';
import type { RenderData } from './lib/render-data.ts';
import { compareVariantsInWorker } from './lib/workspace-review.ts';

export type Inputs = Readonly<Record<string, string>>;
type Authoring = 'set' | 'modifier' | 'entry';

export function labelOrigin(origin: ResolverOrigin) {
  return [origin.file, origin.set, origin.modifier && origin.modifier + ' / ' + origin.context].filter(Boolean).join(' · ');
}

export function originName(origin: ResolverOrigin) {
  return origin.set ?? origin.context ?? origin.file;
}

export function ContextInputs({ model, label, inputs, update, disabled }: {
  model: ResolverModel; label: string; inputs: Inputs; update: (inputs: Inputs) => void; disabled: boolean;
}) {
  const id = useId();
  return <fieldset disabled={disabled} aria-label={label} className="variant-inputs">
      {[...model.modifiers].map(([name, modifier], index) => {
        const idValue = id + '-' + index;
        const value = Object.hasOwn(inputs, name) ? inputs[name] ?? '' : modifier.defaultContext ?? '';
        return <div key={name} className="variant-field">
          <ChipSelect id={idValue} label={name}
            selectedLabel={(model.modifiers.size === 1 ? label : name) + ' · ' + (modifier.contexts.has(value) ? value : 'Choose…')}
            disabled={disabled} value={modifier.contexts.has(value) ? value : ''} onChange={event => {
            const next = { ...inputs };
            if (event.target.value) Object.defineProperty(next, name, { value: event.target.value, enumerable: true });
            else delete next[name];
            update(next);
          }}>
            <SelectOption value="">Choose…</SelectOption>
            {[...modifier.contexts.keys()].map(context => <SelectOption key={context} value={context}>{context}</SelectOption>)}
          </ChipSelect>
        </div>;
      })}
  </fieldset>;
}

type AuthorTarget = { kind: Authoring; name?: string; index?: number };

function AuthorDialog({ target, tree, file, files, author, close, reviewing, checking }: {
  target: AuthorTarget; tree: JsonObject; file: string; files: Workspace['files']; reviewing: boolean; checking: boolean;
  author: (file: string, path: string[], value: JsonValue, insert?: boolean) => Promise<void>; close: () => void;
}) {
  const { kind, name: originalName } = target;
  const section = kind === 'modifier' ? 'modifiers' : 'sets';
  const collection = tree[section];
  const member = isJsonObject(collection) && originalName !== undefined ? collection[originalName] : undefined;
  const initial = isJsonObject(member) ? member : undefined;
  const [name, setName] = useState(originalName ?? '');
  const [defaultContext, setDefault] = useState(() => {
    const value = initial?.['default'];
    return typeof value === 'string' && isJsonObject(initial?.['contexts']) ? Object.keys(initial['contexts']).indexOf(value) : -1;
  });
  const { sources, setSources, contexts, setContexts } = useResolverSourceDraft(initial);
  const existingOrder = Array.isArray(tree['resolutionOrder']) && target.index !== undefined ? tree['resolutionOrder'][target.index] : undefined;
  const [json, setJson] = useState(JSON.stringify(existingOrder ?? { name: '', type: 'set', sources: [] }, null, 2));
  const [reference, setReference] = useState(isJsonObject(existingOrder) && typeof existingOrder['$ref'] === 'string' ? existingOrder['$ref'] : '');
  const [error, setError] = useState('');
  const options = ['sets', 'modifiers'].flatMap(collectionKey => {
    const object = tree[collectionKey];
    return isJsonObject(object) ? Object.keys(object).map(key => ({
      label: (collectionKey === 'sets' ? 'Set · ' : 'Dimension · ') + key,
      reference: serializeTokenPointer(file, file, [collectionKey, key]),
    })) : [];
  });
  const fragments = useMemo(() => files.flatMap(source => {
    if (source.parseIssue || isResolverFile(source)) return [];
    const result: ResolverSourceOption[] = [];
    function groups(node: JsonObject, parts: readonly string[]) {
      for (const [key, child] of Object.entries(node)) {
        if (key.startsWith('$') || !isJsonObject(child) || Object.hasOwn(child, '$value') ||
          Object.hasOwn(child, '$ref') && !Object.keys(child).some(childKey => !childKey.startsWith('$'))) continue;
        const path = [...parts, key];
        result.push({ label: path.join(' › ') + ' · ' + source.path, reference: serializeTokenPointer(file, source.path, path) });
        groups(child, path);
      }
    }
    groups(source.tree, []);
    return result;
  }), [file, files]);
  const sourceOptions: ResolverSourceOption[] = [
    ...files.filter(source => !source.parseIssue && !isResolverFile(source)).map(source => ({
      label: source.path, reference: serializeTokenPointer(file, source.path, []).slice(0, -1),
    })),
    ...fragments,
    ...options.filter(option => option.reference.startsWith('#/sets/') &&
      option.reference !== serializeTokenPointer(file, file, ['sets', originalName ?? ''])),
  ];
  const id = useId();
  const addContext = useRef<HTMLButtonElement>(null);
  const report = (failure: unknown) => setError(errorMessage(failure));
  const title = kind === 'entry' ? target.index === undefined ? 'Add to override order' : 'Edit override order entry' : (originalName ? 'Edit ' : 'New ') + (kind === 'set' ? 'token set' : 'variant dimension');
  return <ActionDialog open={!reviewing} busy={checking} onKeyDown={event => { if (checking && event.key === 'Escape') event.preventDefault(); }} title={title} description={originalName} onOpenChange={open => { if (!open && !checking) close(); }}>
    <form className="grid min-w-0 gap-3" onSubmit={event => {
      event.preventDefault();
      if (checking) return;
      setError('');
      try {
        if (kind === 'entry') {
          const order = tree['resolutionOrder'];
          if (!Array.isArray(order)) throw new Error('Repair the resolution order before adding an entry.');
          const existingReference = isJsonObject(existingOrder) && existingOrder['$ref'] === reference ? existingOrder : undefined;
          const next = reference ? existingReference ?? { $ref: reference } : parseJson(json);
          void author(file, ['resolutionOrder', String(target.index ?? order.length)], next, target.index === undefined).catch(report);
          return;
        }
        const label = name.trim();
        if (!label || !originalName && isJsonObject(collection) && Object.hasOwn(collection, label)) {
          throw new Error('Choose a unique name.');
        }
        if (kind === 'set') {
          void author(file, [section, label], { ...initial, sources: sourceValues(sources) }).catch(report);
          return;
        }
        const names = contexts.map(context => context.name.trim());
        if (!names.length || names.some(value => !value) || new Set(names.map(value => value.toLowerCase())).size !== names.length) {
          throw new Error('Give every context a unique name.');
        }
        const value: JsonObject = { ...initial, contexts: Object.fromEntries(contexts.map(context => [
          context.name.trim(), sourceValues(context.sources),
        ] as const)) };
        const preferred = contexts.find(context => context.id === defaultContext);
        if (preferred) value['default'] = preferred.name.trim();
        else delete value['default'];
        void author(file, [section, label], value).catch(report);
      } catch (failure) { setError(errorMessage(failure)); }
    }}>
      {kind !== 'entry' && !originalName && <TextField label={kind === 'set' ? 'Set name' : 'Variant name'} data-initial-focus required value={name}
        onChange={event => setName(event.target.value)} />}
      {kind === 'entry' && <div className="grid gap-1 copy-body">
        <label htmlFor={id + '-entry'}>Entry</label>
        <Select id={id + '-entry'} value={reference} onChange={event => setReference(event.target.value)}>
          <SelectOption value="">Inline entry (advanced)</SelectOption>
          {reference && !options.some(option => option.reference === reference) &&
            <SelectOption value={reference}>{orderEntryLabel({ $ref: reference }, file, target.index ?? 0)}</SelectOption>}
          {options.map(option => <SelectOption key={option.reference} value={option.reference}>{option.label}</SelectOption>)}
        </Select>
      </div>}
      {kind === 'entry' && !reference && <label htmlFor={id} className="grid gap-1 copy-body">Inline entry JSON
        <Textarea id={id} rows={6} value={json} spellCheck={false} className="code-editor" onChange={event => setJson(event.target.value)} />
      </label>}
      {kind === 'set' && <ResolverSourceFields {...{ sources, setSources, file }} options={sourceOptions} />}
      {kind === 'modifier' && <>
        {contexts.map((context, index) => (
          <section key={context.id} aria-label={'Option ' + (index + 1)} className="grid gap-2 rounded-lg border p-3">
            <TextField required label={'Option ' + (index + 1) + ' name'} value={context.name}
              onChange={event => setContexts(contexts.map(item => item.id === context.id ? { ...item, name: event.target.value } : item))}
              trailing={<IconButton type="button" size="xsmall" label={'Remove option ' + (index + 1)}
                onClick={() => {
                  addContext.current?.focus();
                  if (defaultContext === context.id) setDefault(-1);
                  setContexts(contexts.filter(item => item.id !== context.id));
                }}><Trash2 aria-hidden="true" /></IconButton>} />
            <details className="grid gap-2">
              <summary className="cursor-pointer copy-body">{context.sources.length} {context.sources.length === 1 ? 'source' : 'sources'}</summary>
              <ResolverSourceFields sources={context.sources} options={sourceOptions} file={file}
                setSources={next => setContexts(contexts.map(item => item.id === context.id ? { ...item, sources: next } : item))} />
            </details>
          </section>
        ))}
        <Button ref={addContext} type="button" size="small" variant="tonal" className="justify-self-start" onClick={() => {
          const contextId = 1 + Math.max(-1, ...contexts.map(context => context.id));
          setContexts([...contexts, { id: contextId, name: '', sources: [] }]);
        }}>Add option</Button>
        {!!contexts.length && <div className="grid gap-1 copy-body">
          <label htmlFor={id + '-default'}>Default option</label>
          <Select id={id + '-default'} value={String(defaultContext)} onChange={event => setDefault(Number(event.target.value))}>
            <SelectOption value="-1">No default</SelectOption>
            {contexts.map((context, index) => <SelectOption key={context.id} value={String(context.id)}>
              {context.name || 'Option ' + (index + 1)}
            </SelectOption>)}
          </Select>
        </div>}
      </>}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="text" disabled={checking} data-dialog-close="">Cancel</Button>
        <Button type="submit" disabled={checking}>{checking ? 'Checking contexts…' : 'Review changes'}</Button>
      </div>
    </form>
  </ActionDialog>;
}

function hasStructuredSources(member: JsonValue | undefined, section: 'sets' | 'modifiers') {
  if (!isJsonObject(member) || Object.hasOwn(member, '$ref')) return false;
  if (section === 'sets') return Array.isArray(member['sources']);
  const contexts = member['contexts'];
  return isJsonObject(contexts) && Object.values(contexts).every(Array.isArray);
}

type SetPathAction = { kind: 'rename' | 'move' | 'remove'; name: string };

function SetPathDialog({ action, destinations, reviewing, checking, close, submit }: {
  action: SetPathAction; destinations: readonly string[]; reviewing: boolean; checking: boolean;
  close: () => void; submit: (name?: string, destination?: string) => Promise<void>;
}) {
  const [name, setName] = useState(action.name);
  const [target, setTarget] = useState(destinations.length === 1 ? destinations[0] ?? '' : '');
  const [error, setError] = useState('');
  const id = useId();
  const moving = action.kind === 'move';
  const removing = action.kind === 'remove';
  return <ActionDialog open={!reviewing} busy={checking} onKeyDown={event => { if (checking && event.key === 'Escape') event.preventDefault(); }} title={moving ? 'Move set' : removing ? 'Remove set' : 'Rename set'} description={action.name}
    onOpenChange={open => { if (!open && !reviewing && !checking) close(); }}>
    <form className="grid gap-3" onSubmit={event => {
      event.preventDefault();
      if (checking) return;
      setError('');
      try { void submit(removing ? undefined : name, moving ? target : undefined).catch((failure: unknown) => setError(errorMessage(failure))); }
      catch (failure) { setError(errorMessage(failure)); }
    }}>
      {moving && <div className="grid gap-1 copy-body">
        <label htmlFor={id}>Destination Resolver</label>
        <Select id={id} required data-initial-focus value={target} onChange={event => {
          setTarget(event.target.value); setError('');
        }}>
          <SelectOption value="">Choose a Resolver…</SelectOption>
          {destinations.map(file => <SelectOption key={file} value={file}>{file}</SelectOption>)}
        </Select>
      </div>}
      {!removing && <TextField label="Set name" required data-initial-focus={!moving ? '' : undefined} value={name}
        onChange={event => { setName(event.target.value); setError(''); }} />}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="text" type="button" disabled={checking} data-dialog-close="" data-initial-focus={removing ? '' : undefined}>Cancel</Button>
        <Button type="submit" disabled={checking}>{checking ? 'Checking contexts…' : moving ? 'Review move' : removing ? 'Review removal' : 'Review rename'}</Button>
      </div>
    </form>
  </ActionDialog>;
}

function orderEntryLabel(item: JsonValue, file: string, index: number) {
  if (!isJsonObject(item)) return 'Entry ' + (index + 1);
  if (typeof item['$ref'] === 'string') {
    try {
      const target = tokenPointer(item['$ref'], file);
      const [section, name] = target.parts;
      if (name && (section === 'modifiers' || section === 'sets')) {
        return (section === 'sets' ? 'Set · ' : 'Dimension · ') + name + (target.file === file ? '' : ' · ' + target.file);
      }
      return target.file === file && target.parts.length ? target.parts.join(' › ') : target.file;
    } catch { return item['$ref']; }
  }
  return typeof item['name'] === 'string' ? item['name'] : 'Inline entry ' + (index + 1);
}

export function variantLabel(resolution: ResolverResolution) {
  return [...resolution.contexts.values()].join(' · ') || 'Shared values';
}

export async function downloadEditableSources(workspace: Workspace, model: ResolverModel) {
  const { strToU8, zipSync } = await import('fflate');
  const sources = workspace.files.filter(source => model.sourceFiles.has(source.path));
  const bytes = zipSync(Object.fromEntries(sources.map(source => [source.path, strToU8(source.text)])));
  download(model.file.split('/').at(-1)?.replace(/\.json$/u, '.zip') ?? 'sources.zip', Uint8Array.from(bytes).buffer, 'application/zip');
}

export function downloadVariant(resolution: ResolverResolution) {
  const label = variantLabel(resolution).replace(/[^a-z0-9]+/giu, '-').toLowerCase();
  download('resolved-' + label + '.tokens.json', JSON.stringify(resolvedSnapshot(resolution), null, 2) + '\n', 'application/json');
}

export function ResolverPane({ workspace: workspaceData, file, model: modelData, current: currentData, alternative: alternativeData,
  scope, disabled, prepareReview, review, editSource, reviewing }: {
  prepareReview: (draft: Review, scope: ResolverEditScope) => Promise<Review>;
  workspace: RenderData<Workspace>; file: string; disabled: boolean; reviewing: boolean;
  model: RenderData<ResolverModel>; current: RenderData<ResolverResolution>; alternative: RenderData<ResolverResolution> | undefined; scope: ResolverEditScope;
  review: (next: Review, onApply?: () => void, focusAfterApply?: HTMLElement | null) => void;
  editSource: (source: SourceLocation) => void;
}) {
  const workspace = workspaceData.value;
  const model = modelData.value;
  const current = currentData.value;
  const alternative = alternativeData?.value;
  const authored = workspace.files.find(source => source.path === file);
  const [setPath, setSetPath] = useState<SetPathAction>();
  const destinations = useMemo(() => workspace.files.filter(source => source.path !== file && !source.parseIssue && isResolverFile(source))
    .map(source => source.path).toSorted(), [workspace.files, file]);
  const setsHeading = useRef<HTMLHeadingElement>(null);
  const [authoring, setAuthoring] = useState<AuthorTarget>();
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  if (!authored) return null;
  const tree = authored.tree;
  const order = Array.isArray(tree['resolutionOrder']) ? tree['resolutionOrder'] : [];
  const seenEntries = new Map<string, number>();
  const orderRows = order.map((item, index) => {
    const name = orderEntryLabel(item, file, index);
    const observed = seenEntries.get(name) ?? 0;
    seenEntries.set(name, observed + 1);
    return { name, id: JSON.stringify([name, observed]) };
  });
  const errors = [...new Set([...current.errors, ...(alternative?.errors ?? [])])];
  const issueCount = model.issues.length + errors.length;
  const contextDiagnostics = [
    { resolution: current, label: alternative ? 'Active variant' : '' },
    ...(alternative ? [{ resolution: alternative, label: 'Compared variant' }] : []),
  ].flatMap(({ resolution, label }) => resolution.graph.documentDiagnostics.map(issue => {
    const path = issue.path ? issue.path.split('.') : [];
    const fieldPath = issue.sourcePath ?? (issue.field ? [issue.field] : []);
    const origin = winningOrigins(resolution, issue.path).at(-1);
    return { label, issue, source: origin ? { file: origin.file, path: [...origin.parts, ...fieldPath] } : { file, path } };
  }));

  async function check(draft: Review, onApply?: () => void, focusAfterApply?: HTMLElement | null) {
    setChecking(true);
    try {
      review(await prepareReview(draft, scope), onApply, focusAfterApply);
    } finally {
      setChecking(false);
    }
  }

  async function author(target: string, location: string[], next: JsonValue, insert = false, onApply?: () => void) {
    await check(reviewResolverValue(workspace, target, location, next, insert), onApply);
  }

  function reorder(from: number, to: number) {
    const entries = order.slice();
    const [item] = entries.splice(from, 1);
    if (to >= 0 && item !== undefined) entries.splice(to, 0, item);
    setError('');
    void author(file, ['resolutionOrder'], entries).catch((failure: unknown) => setError(errorMessage(failure)));
  }

  const sharedSets = model.order.flatMap(entry => entry.kind === 'set' ? [entry.name] : []);

  return <div className="resolver-workspace">
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="wrap-anywhere copy-body copy-emphasis">{typeof tree['name'] === 'string' && tree['name'] ? tree['name'] : file}</p>
      <Button className="ms-auto" size="xsmall" variant="text" disabled={disabled}
        onClick={() => editSource({ file, path: [], resolver: scope })}><Pencil aria-hidden="true" /> Edit resolver JSON</Button>
    </div>
    <div className="resolver-sections">
      {(['sets', 'modifiers'] as const).map(section => {
        const members = tree[section];
        return <section key={section} aria-label={section === 'sets' ? 'Token sets' : 'Variant dimensions'} className="resolver-section">
          <h3 tabIndex={section === 'sets' ? -1 : undefined} ref={section === 'sets' ? setsHeading : undefined}>{section === 'sets' ? 'Token sets' : 'Variant dimensions'}</h3>
          <p className="copy-body tone-supporting">{section === 'sets'
            ? 'Collect shared tokens from files or add them here.'
            : 'Define the choices people can preview, such as Light and Dark.'}</p>
          {section === 'modifiers' && sharedSets.length > 0 && <p className="wrap-anywhere copy-body">Shared sets: {sharedSets.join(', ')}</p>}
          <ul>{(section === 'sets' ? [...model.sets.keys()] : [...model.modifiers.keys()]).map(name => <li key={name} className="min-w-0">
            <div className="flex items-center gap-1">
            <Button size="xsmall" variant="text" disabled={disabled} onClick={() => {
              if (isJsonObject(members) && Object.hasOwn(members, name)) {
                if (hasStructuredSources(members[name], section)) setAuthoring({ kind: section === 'sets' ? 'set' : 'modifier', name });
                else editSource({ file, path: [section, name], resolver: scope });
              } else {
                const index = orderRows.findIndex(row => row.name === name ||
                  row.name === (section === 'sets' ? 'Set · ' : 'Dimension · ') + name);
                if (index >= 0) setAuthoring({ kind: 'entry', index });
                else editSource({ file, path: [], resolver: scope });
              }
            }}>
              <Pencil aria-hidden="true" /> {name}
            </Button>
            {section === 'sets' && isJsonObject(members) && Object.hasOwn(members, name) && <CommandMenu label={'Actions for set ' + name} icon={<MoreHorizontal aria-hidden="true" />} disabled={disabled}
              sections={[[{ label: 'Rename set…', icon: <Pencil aria-hidden="true" />, run: () => setSetPath({ kind: 'rename', name }) },
                { label: 'Move set…', icon: <ArrowRightLeft aria-hidden="true" />, disabled: !destinations.length,
                  run: () => setSetPath({ kind: 'move', name }) }],
                [{ label: 'Remove set…', icon: <Trash2 aria-hidden="true" />, destructive: true, run: () => setSetPath({ kind: 'remove', name }) }]]} />}
            </div>
            {section === 'modifiers' && <dl className="mb-2 ms-3 grid gap-1 copy-body">
              {[...model.modifiers.get(name)?.contexts ?? []].map(([option, contributions]) => {
                const names = [...new Set(contributions.map(({ origin }) => origin.set ?? origin.file))];
                return <div key={option} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
                  <dt className="wrap-anywhere">{option}{model.modifiers.get(name)?.defaultContext === option && <span className="ms-2 copy-small tone-supporting">Default</span>}</dt>
                  <dd className="wrap-anywhere tone-supporting">{names.length ? names.join(', ') : 'Shared sets only'}</dd>
                </div>;
              })}
            </dl>}
          </li>)}</ul>
          <Button size="xsmall" variant="text" disabled={disabled} onClick={() => setAuthoring({ kind: section === 'sets' ? 'set' : 'modifier' })}>
            <Plus aria-hidden="true" /> {section === 'sets' ? 'New token set' : 'New variant dimension'}
          </Button>
        </section>;
      })}
    </div>
    <section aria-label="Order of overrides" className="resolver-section">
      <h3>Order of overrides</h3>
      <p className="copy-body tone-supporting">Add sets and dimensions here to include them in the preview. If two entries define the same token, the last one wins.</p>
      <ol className="grid gap-1">{orderRows.map(({ name, id }, index) => {
        return <li key={id} className="flex min-w-0 items-center justify-between gap-1">
          <span className="wrap-anywhere copy-body">{name}</span>
          <div className="flex shrink-0">
            <IconButton size="xsmall" label={'Edit ' + name} disabled={disabled}
              onClick={() => setAuthoring({ kind: 'entry', index })}><Pencil aria-hidden="true" /></IconButton>
            <IconButton size="xsmall" label={'Move ' + name + ' up'} disabled={disabled || index === 0} onClick={() => reorder(index, index - 1)}><ArrowUp aria-hidden="true" /></IconButton>
            <IconButton size="xsmall" label={'Move ' + name + ' down'} disabled={disabled || index + 1 === order.length}
              onClick={() => reorder(index, index + 1)}><ArrowDown aria-hidden="true" /></IconButton>
            <IconButton size="xsmall" label={'Remove ' + name} disabled={disabled} onClick={() => reorder(index, -1)}><Trash2 aria-hidden="true" /></IconButton>
          </div>
        </li>;
      })}</ol>
      <Button size="xsmall" variant="text" disabled={disabled} onClick={() => setAuthoring({ kind: 'entry' })}><Plus aria-hidden="true" /> Add to override order</Button>
    </section>
    {(issueCount > 0 || contextDiagnostics.length > 0) && <section aria-label="Variant issues" className="resolver-section">
      <h3>Variant issues</h3>
      {!!issueCount && <ul className="grid gap-1 copy-body" aria-label="Resolver diagnostics">
        {model.issues.map(issue => <li key={JSON.stringify([issue.file, issue.parts, issue.message])}>
          <Button size="xsmall" variant="text" disabled={disabled} onClick={() => editSource({ file: issue.file, path: issue.parts, resolver: scope })}>
            {issue.parts.join(' / ')} · {issue.message}
          </Button>
        </li>)}
        {errors.map(message => <li key={message}>{message}</li>)}
      </ul>}
      {contextDiagnostics.length > 0 && <details className="rounded-lg border px-3 py-2 copy-body">
        <summary className="cursor-pointer">Context source diagnostics ({contextDiagnostics.length})</summary>
        <ul className="mt-1 grid gap-1">
          {contextDiagnostics.map(({ label, issue, source }) => <li key={JSON.stringify([label, issue.path, issue.field, issue.message])} className="min-w-0">
            <Button size="xsmall" variant="text" disabled={disabled} onClick={() => editSource({ ...source, resolver: scope })}>
              <span className="wrap-anywhere text-start">{[label, issue.path, issue.field, issue.message].filter(Boolean).join(' · ')}</span>
            </Button>
          </li>)}
        </ul>
      </details>}
    </section>}
    {authoring && <AuthorDialog target={authoring} files={workspace.files} {...{ tree, file, reviewing, checking }} author={(target, path, next, insert) => author(target, path, next, insert, () => setAuthoring(undefined))} close={() => setAuthoring(undefined)} />}
    {setPath && <SetPathDialog action={setPath} destinations={destinations} reviewing={reviewing} checking={checking} close={() => setSetPath(undefined)}
      submit={(name, destination = file) => {
        const next = reviewSetPath(workspace, file, setPath.name, name, destination);
        return check(next, () => setSetPath(undefined), setsHeading.current);
      }} />}
  </div>;
}

export function VariantComparison({ current: currentData, alternative: alternativeData, inspect }: {
  current: RenderData<ResolverResolution>; alternative: RenderData<ResolverResolution>; inspect: (path: string) => void;
}) {
  const current = currentData.value;
  const alternative = alternativeData.value;
  const valid = !current.errors.length && !alternative.errors.length;
  const offThread = valid && Math.max(current.graph.tokens.size, alternative.graph.tokens.size) >= 2000;
  const [result, setResult] = useState<{
    current: RenderData<ResolverResolution>;
    alternative: RenderData<ResolverResolution>;
    differences?: ReturnType<typeof compareContexts>;
    error?: string;
  }>();
  const local = useMemo(() => valid && !offThread ? compareContexts(current, alternative) : [], [alternative, current, offThread, valid]);
  const matching = result?.current === currentData && result?.alternative === alternativeData ? result : undefined;
  const differences = offThread ? matching?.differences ?? local : local;
  const pending = offThread && !matching;
  useEffect(() => {
    if (!offThread) return undefined;
    const controller = new AbortController();
    async function compare() {
      try {
        const changes = await compareVariantsInWorker(current, alternative, controller.signal);
        if (!controller.signal.aborted) setResult({ current: currentData, alternative: alternativeData, differences: changes });
      } catch (failure) {
        if (!controller.signal.aborted) setResult({ current: currentData, alternative: alternativeData, error: errorMessage(failure) });
      }
    }
    void compare();
    return () => controller.abort();
  }, [alternative, alternativeData, current, currentData, offThread]);
  const [query, setQuery] = useState('');
  const search = useDeferredValue(query.trim().toLowerCase());
  const changes = useMemo(() => search ? differences.filter(({ path }) => path.toLowerCase().includes(search)) : differences,
    [differences, search]);
  const [page, setPage] = useState(0);
  const size = 50;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(changes.length / size) - 1));
  return <>
    <SearchBar className="workspace-search comparison-search" label="Search compared tokens" placeholder="Search compared tokens" leading={<Search aria-hidden="true" />}
      value={query} onChange={event => { setQuery(event.currentTarget.value); setPage(0); }} />
    <Table aria-label="Variant comparison" aria-busy={pending}>
    <TableHeader><TableRow><TableHead>Token</TableHead><TableHead>Change</TableHead>
      <TableHead>{variantLabel(current)}</TableHead><TableHead>{variantLabel(alternative)}</TableHead>
    </TableRow></TableHeader>
    <TableBody>{changes.slice(currentPage * size, (currentPage + 1) * size).map(change => <TableRow key={change.path}>
      <TableCell>{current.graph.tokens.has(change.path)
        ? <Button size="xsmall" variant="text" onClick={() => inspect(change.path)}>{change.path}</Button>
        : change.path}</TableCell>
      <TableCell>{change.kind}</TableCell>
      <TableCell>{change.beforeProblem ?? <TokenValue value={change.before} swatch />}</TableCell>
      <TableCell>{change.afterProblem ?? <TokenValue value={change.after} swatch />}</TableCell>
    </TableRow>)}
      {changes.length === 0 && <TableRow><TableCell colSpan={4}>
        {!valid ? 'Choose the options for both variants to compare them.' :
          pending ? <output>Comparing variants…</output> : matching?.error ?? 'No differences in these tokens.'}
      </TableCell></TableRow>}
    </TableBody>
  </Table>
    {changes.length > size && <div className="flex items-center justify-end gap-2 p-2">
      <Button size="xsmall" variant="text" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous differences</Button>
      <span className="copy-small">{currentPage * size + 1}–{Math.min((currentPage + 1) * size, changes.length)} of {changes.length}</span>
      <Button size="xsmall" variant="text" disabled={(currentPage + 1) * size >= changes.length}
        onClick={() => setPage(currentPage + 1)}>Next differences</Button>
    </div>}
  </>;
}
