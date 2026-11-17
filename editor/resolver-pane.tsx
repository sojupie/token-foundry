import { useId, useMemo, useRef, useState } from 'react';
import { Button, IconButton, TextField } from '@token-catalog/forge-react';
import { ArrowDown, ArrowRightLeft, ArrowUp, Download, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { ActionDialog } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FieldRow } from '@/components/ui/field-row';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, isJsonObject, parseJson } from '../lib/json.ts';
import type { JsonObject, JsonValue } from '../lib/json.ts';
import { compareContexts, isResolverFile, resolvedSnapshot, winningOrigins } from '../lib/resolver.ts';
import type { ResolverModel, ResolverOrigin, ResolverResolution } from '../lib/resolver.ts';
import { serializeTokenPointer } from '../lib/token-path.ts';
import { reviewResolverValue, reviewSetPath } from '../lib/workspace.ts';
import type { ResolverEditScope, Review, Workspace } from '../lib/workspace.ts';
import { CommandMenu } from './command-bar.tsx';
import { download } from './lib/sources.ts';
import type { SourceLocation } from './source-dialog.tsx';
import { ResolverSourceFields, sourceValues, useResolverSourceDraft } from './resolver-source-fields.tsx';
import type { ResolverSourceOption } from './resolver-source-fields.tsx';
import { TokenValue } from './token-value.tsx';

export type Inputs = Readonly<Record<string, string>>;
type Authoring = 'set' | 'modifier' | 'entry';

export function labelOrigin(origin: ResolverOrigin) {
  return [origin.file, origin.set, origin.modifier && origin.modifier + ' / ' + origin.context].filter(Boolean).join(' · ');
}

function ContextInputs({ model, label, inputs, update, disabled }: {
  model: ResolverModel; label: string; inputs: Inputs; update: (inputs: Inputs) => void; disabled: boolean;
}) {
  const id = useId();
  return <fieldset disabled={disabled} className="min-w-0 rounded-lg border p-2">
    <legend className="mx-1 px-1 text-xs font-medium">{label}</legend>
    <FieldRow>
      {[...model.modifiers].map(([name, modifier], index) => {
        const idValue = id + '-' + index;
        const value = Object.hasOwn(inputs, name) ? inputs[name] ?? '' : modifier.defaultContext ?? '';
        return <div key={name} className="grid min-w-0 gap-1">
          <label htmlFor={idValue} className="text-xs">{name}</label>
          <NativeSelect id={idValue} value={modifier.contexts.has(value) ? value : ''} onChange={event => {
            const next = { ...inputs };
            if (event.target.value) Object.defineProperty(next, name, { value: event.target.value, enumerable: true });
            else delete next[name];
            update(next);
          }}>
            <NativeSelectOption value="">Choose…</NativeSelectOption>
            {[...modifier.contexts.keys()].map(context => <NativeSelectOption key={context} value={context}>{context}</NativeSelectOption>)}
          </NativeSelect>
        </div>;
      })}
    </FieldRow>
    {!model.modifiers.size && <span className="text-sm text-muted-foreground">No variant options yet.</span>}
  </fieldset>;
}

type AuthorTarget = { kind: Authoring; name?: string };

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
  const [json, setJson] = useState('{\n  "name": "",\n  "type": "set",\n  "sources": []\n}');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const options = ['sets', 'modifiers'].flatMap(collectionKey => {
    const object = tree[collectionKey];
    return isJsonObject(object) ? Object.keys(object).map(key => ({
      label: (collectionKey === 'sets' ? 'Set · ' : 'Modifier · ') + key,
      reference: serializeTokenPointer(file, file, [collectionKey, key]),
    })) : [];
  });
  const sourceOptions: ResolverSourceOption[] = [
    ...files.filter(source => !source.parseIssue && !isResolverFile(source)).map(source => ({
      label: source.path, reference: serializeTokenPointer(file, source.path, []).slice(0, -1),
    })),
    ...options.filter(option => option.reference.startsWith('#/sets/') &&
      option.reference !== serializeTokenPointer(file, file, ['sets', originalName ?? ''])),
  ];
  const id = useId();
  const addContext = useRef<HTMLButtonElement>(null);
  const report = (failure: unknown) => setError(errorMessage(failure));
  const title = kind === 'entry' ? 'Add to override order' : (originalName ? 'Edit ' : 'New ') + (kind === 'set' ? 'token set' : 'variant option');
  return <ActionDialog open={!reviewing} busy={checking} onKeyDown={event => { if (checking && event.key === 'Escape') event.preventDefault(); }} title={title} description={originalName} onOpenChange={open => { if (!open && !checking) close(); }}>
    <form className="grid min-w-0 gap-3" onSubmit={event => {
      event.preventDefault();
      if (checking) return;
      setError('');
      try {
        if (kind === 'entry') {
          const order = tree['resolutionOrder'];
          if (!Array.isArray(order)) throw new Error('Repair the resolution order before adding an entry.');
          void author(file, ['resolutionOrder', String(order.length)], reference ? { $ref: reference } : parseJson(json), true).catch(report);
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
      {kind === 'entry' && <div className="grid gap-1 text-sm">
        <label htmlFor={id + '-entry'}>Entry</label>
        <NativeSelect id={id + '-entry'} value={reference} onChange={event => setReference(event.target.value)}>
          <NativeSelectOption value="">Inline entry</NativeSelectOption>
          {options.map(option => <NativeSelectOption key={option.reference} value={option.reference}>{option.label}</NativeSelectOption>)}
        </NativeSelect>
      </div>}
      {kind === 'entry' && !reference && <label htmlFor={id} className="grid gap-1 text-sm">Inline entry JSON
        <Textarea id={id} rows={6} value={json} spellCheck={false} className="font-mono text-xs" onChange={event => setJson(event.target.value)} />
      </label>}
      {kind === 'set' && <ResolverSourceFields {...{ sources, setSources }} options={sourceOptions} />}
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
              <summary className="cursor-pointer text-sm">{context.sources.length} {context.sources.length === 1 ? 'source' : 'sources'}</summary>
              <ResolverSourceFields sources={context.sources} options={sourceOptions}
                setSources={next => setContexts(contexts.map(item => item.id === context.id ? { ...item, sources: next } : item))} />
            </details>
          </section>
        ))}
        <Button ref={addContext} type="button" size="small" variant="tonal" className="justify-self-start" onClick={() => {
          const contextId = 1 + Math.max(-1, ...contexts.map(context => context.id));
          setContexts([...contexts, { id: contextId, name: '', sources: [] }]);
        }}>Add option</Button>
        {!!contexts.length && <div className="grid gap-1 text-sm">
          <label htmlFor={id + '-default'}>Default option</label>
          <NativeSelect id={id + '-default'} value={String(defaultContext)} onChange={event => setDefault(Number(event.target.value))}>
            <NativeSelectOption value="-1">No default</NativeSelectOption>
            {contexts.map((context, index) => <NativeSelectOption key={context.id} value={String(context.id)}>
              {context.name || 'Option ' + (index + 1)}
            </NativeSelectOption>)}
          </NativeSelect>
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
      {moving && <div className="grid gap-1 text-sm">
        <label htmlFor={id}>Destination Resolver</label>
        <NativeSelect id={id} required data-initial-focus value={target} onChange={event => {
          setTarget(event.target.value); setError('');
        }}>
          <NativeSelectOption value="">Choose a Resolver…</NativeSelectOption>
          {destinations.map(file => <NativeSelectOption key={file} value={file}>{file}</NativeSelectOption>)}
        </NativeSelect>
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

function orderEntryLabel(item: JsonValue, index: number) {
  if (!isJsonObject(item)) return 'Entry ' + (index + 1);
  if (typeof item['$ref'] === 'string') return item['$ref'];
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

export function ResolverPane({ workspace, file, model, current, alternative, primary, secondary, setPrimary, setSecondary,
  definitionOpen, setDefinitionOpen, comparing, setComparing, scope, disabled, prepareReview, review, editSource, reviewing }: {
  prepareReview: (draft: Review, scope: ResolverEditScope) => Promise<Review>;
  workspace: Workspace; file: string; disabled: boolean; reviewing: boolean;
  model: ResolverModel; current: ResolverResolution; alternative: ResolverResolution | undefined;
  primary: Inputs; secondary: Inputs; setPrimary: (value: Inputs) => void; setSecondary: (value: Inputs) => void;
  definitionOpen: boolean; setDefinitionOpen: (open: boolean) => void;
  comparing: boolean; setComparing: (open: boolean) => void; scope: ResolverEditScope;
  review: (next: Review, onApply?: () => void, focusAfterApply?: HTMLElement | null) => void;
  editSource: (source: SourceLocation) => void;
}) {
  const authored = workspace.files.find(source => source.path === file);
  const [setPath, setSetPath] = useState<SetPathAction>();
  const destinations = useMemo(() => workspace.files.filter(source => source.path !== file && !source.parseIssue && isResolverFile(source))
    .map(source => source.path).toSorted(), [workspace.files, file]);
  const definitionButton = useRef<HTMLButtonElement>(null);
  const [authoring, setAuthoring] = useState<AuthorTarget>();
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  if (!authored) return null;
  const tree = authored.tree;
  const order = Array.isArray(tree['resolutionOrder']) ? tree['resolutionOrder'] : [];
  const seenEntries = new Map<string, number>();
  const orderRows = order.map((item, index) => {
    const name = orderEntryLabel(item, index);
    const observed = seenEntries.get(name) ?? 0;
    seenEntries.set(name, observed + 1);
    return { name, id: JSON.stringify([name, observed]) };
  });
  const issueCount = model.issues.length + current.errors.length + (alternative?.errors.length ?? 0);
  const contextDiagnostics = [
    { resolution: current, name: 'Active context' },
    ...(alternative ? [{ resolution: alternative, name: 'Comparison context' }] : []),
  ].flatMap(({ resolution, name }) => resolution.graph.documentDiagnostics.map(issue => {
    const path = issue.path ? issue.path.split('.') : [];
    const fieldPath = issue.sourcePath ?? (issue.field ? [issue.field] : []);
    const origin = winningOrigins(resolution, issue.path).at(-1);
    return { name, issue, source: origin ? { file: origin.file, path: [...origin.parts, ...fieldPath] } : { file, path } };
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

  return <section className="resolver-workspace px-3 py-2" aria-label="Variants">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2>{typeof tree['name'] === 'string' ? tree['name'] : file}</h2>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button ref={definitionButton} size="xsmall" variant={definitionOpen ? 'tonal' : 'text'} pressed={definitionOpen} disabled={disabled}
          onClick={() => setDefinitionOpen(!definitionOpen)}>Manage variants</Button>
        <Button size="xsmall" variant="text" disabled={disabled} onClick={() => { void downloadEditableSources(workspace, model).catch((failure: unknown) => setError(errorMessage(failure))); }}><Download aria-hidden="true" /> Download editable sources (.zip)</Button>
        <Button size="xsmall" variant="text" disabled={disabled || model.issues.some(issue => issue.severity === 'error') || !!current.errors.length}
          onClick={() => {
            try { downloadVariant(current); }
            catch (failure) { setError(errorMessage(failure)); }
          }}><Download aria-hidden="true" /> Download resolved tokens</Button>
      </div>
    </header>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {definitionOpen && <section aria-label="Manage variants" className="grid max-h-[36dvh] gap-3 overflow-auto">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>Manage variants</h3>
        <Button size="xsmall" variant="text" disabled={disabled} onClick={() => editSource({ file, path: [], resolver: scope })}><Pencil aria-hidden="true" /> Edit resolver JSON</Button>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {(['sets', 'modifiers'] as const).map(section => {
          const members = tree[section];
          return <section key={section} aria-label={section === 'sets' ? 'Token sets' : 'Variant options'} className="rounded-lg border p-2">
            <h4 className="text-sm font-medium">{section === 'sets' ? 'Token sets' : 'Variant options'}</h4>
            <ul>{isJsonObject(members) && Object.keys(members).map(name => <li key={name} className="flex items-center gap-1">
              <Button size="xsmall" variant="text" disabled={disabled} onClick={() => {
                if (hasStructuredSources(members[name], section)) setAuthoring({ kind: section === 'sets' ? 'set' : 'modifier', name });
                else editSource({ file, path: [section, name], resolver: scope });
              }}>
                <Pencil aria-hidden="true" /> {name}
              </Button>
              {section === 'sets' && <CommandMenu label={'Actions for set ' + name} icon={<MoreHorizontal aria-hidden="true" />} disabled={disabled}
                sections={[[{ label: 'Rename set…', icon: <Pencil aria-hidden="true" />, run: () => setSetPath({ kind: 'rename', name }) },
                  { label: 'Move set…', icon: <ArrowRightLeft aria-hidden="true" />, disabled: !destinations.length,
                    run: () => setSetPath({ kind: 'move', name }) }],
                  [{ label: 'Remove set…', icon: <Trash2 aria-hidden="true" />, destructive: true, run: () => setSetPath({ kind: 'remove', name }) }]]} />}
            </li>)}</ul>
            <Button size="xsmall" variant="text" disabled={disabled} onClick={() => setAuthoring({ kind: section === 'sets' ? 'set' : 'modifier' })}>
              <Plus aria-hidden="true" /> {section === 'sets' ? 'New token set' : 'New variant option'}
            </Button>
          </section>;
        })}
      </div>
      <section aria-label="Order of overrides" className="rounded-lg border p-2">
        <h4 className="text-sm font-medium">Order of overrides</h4>
        <ol className="grid gap-1">{orderRows.map(({ name, id }, index) => {
          return <li key={id} className="flex min-w-0 items-center justify-between gap-1">
            <code className="wrap-anywhere text-xs">{name}</code>
            <div className="flex shrink-0">
              <IconButton size="xsmall" label={'Edit ' + name} disabled={disabled}
                onClick={() => editSource({ file, path: ['resolutionOrder', String(index)], resolver: scope })}><Pencil aria-hidden="true" /></IconButton>
              <IconButton size="xsmall" label={'Move ' + name + ' up'} disabled={disabled || index === 0} onClick={() => reorder(index, index - 1)}><ArrowUp aria-hidden="true" /></IconButton>
              <IconButton size="xsmall" label={'Move ' + name + ' down'} disabled={disabled || index + 1 === order.length}
                onClick={() => reorder(index, index + 1)}><ArrowDown aria-hidden="true" /></IconButton>
              <IconButton size="xsmall" label={'Remove ' + name} disabled={disabled} onClick={() => reorder(index, -1)}><Trash2 aria-hidden="true" /></IconButton>
            </div>
          </li>;
        })}</ol>
        <Button size="xsmall" variant="text" disabled={disabled} onClick={() => setAuthoring({ kind: 'entry' })}><Plus aria-hidden="true" /> Add to override order</Button>
      </section>
    </section>}
    <section aria-label="Contexts" className="grid gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <ContextInputs model={model} disabled={disabled} label="Active variant" inputs={primary} update={setPrimary} />
        {comparing && <ContextInputs model={model} disabled={disabled} label="Compare with" inputs={secondary} update={setSecondary} />}
        <Button size="xsmall" variant={comparing ? 'tonal' : 'text'} pressed={comparing} disabled={disabled}
          onClick={() => setComparing(!comparing)}>Compare variants</Button>
      </div>
      {!!issueCount && <ul className="grid gap-1 text-sm" aria-label="Resolver diagnostics">
        {model.issues.map(issue => <li key={JSON.stringify([issue.file, issue.parts, issue.message])}>
          <Button size="xsmall" variant="text" disabled={disabled} onClick={() => editSource({ file: issue.file, path: issue.parts, resolver: scope })}>
            {issue.parts.join(' / ')} · {issue.message}
          </Button>
        </li>)}
        {[...new Set([...current.errors, ...(alternative?.errors ?? [])])].map(message => <li key={message}>{message}</li>)}
      </ul>}
      {contextDiagnostics.length > 0 && <details className="rounded-lg border px-3 py-2 text-sm">
        <summary className="cursor-pointer">Context source diagnostics ({contextDiagnostics.length})</summary>
        <ul className="mt-1 grid gap-1">
          {contextDiagnostics.map(({ name, issue, source }) => <li key={JSON.stringify([name, issue.path, issue.field, issue.message])} className="min-w-0">
            <Button size="xsmall" variant="text" disabled={disabled} onClick={() => editSource({ ...source, resolver: scope })}>
              <span className="wrap-anywhere text-start">{[name, issue.path, issue.field, issue.message].filter(Boolean).join(' · ')}</span>
            </Button>
          </li>)}
        </ul>
      </details>}
    </section>
    {authoring && <AuthorDialog target={authoring} files={workspace.files} {...{ tree, file, reviewing, checking }} author={(target, path, next, insert) => author(target, path, next, insert, () => setAuthoring(undefined))} close={() => setAuthoring(undefined)} />}
    {setPath && <SetPathDialog action={setPath} destinations={destinations} reviewing={reviewing} checking={checking} close={() => setSetPath(undefined)}
      submit={(name, destination = file) => {
        const next = reviewSetPath(workspace, file, setPath.name, name, destination);
        return check(next, () => setSetPath(undefined), definitionButton.current);
      }} />}
  </section>;
}

export function VariantComparison({ current, alternative, group, query }: {
  current: ResolverResolution; alternative: ResolverResolution; group: string; query: string;
}) {
  const changes = !current.errors.length && !alternative.errors.length ? compareContexts(alternative, current)
    .filter(({ path }) => (!group || path.startsWith(group + '.')) && path.toLowerCase().includes(query)) : [];
  return <Table aria-label="Variant comparison">
    <TableHeader><TableRow><TableHead>Token</TableHead><TableHead>Change</TableHead>
      <TableHead>{variantLabel(current)}</TableHead><TableHead>{variantLabel(alternative)}</TableHead>
    </TableRow></TableHeader>
    <TableBody>{changes.map(change => <TableRow key={change.path}>
      <TableCell>{change.path}</TableCell><TableCell>{change.kind}</TableCell>
      <TableCell>{change.afterProblem ?? <TokenValue value={change.after} swatch />}</TableCell>
      <TableCell>{change.beforeProblem ?? <TokenValue value={change.before} swatch />}</TableCell>
    </TableRow>)}
      {changes.length === 0 && <TableRow><TableCell colSpan={4}>
        {current.errors.length || alternative.errors.length ? 'Choose the options for both variants to compare them.' : 'No differences in these tokens.'}
      </TableCell></TableRow>}
    </TableBody>
  </Table>;
}
