import { useId, useMemo, useState } from 'react';
import { Button, TextField } from '@token-catalog/forge-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ActionDialog } from '@/components/ui/dialog';
import { FieldRow } from '@/components/ui/field-row';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { nodeAt, referenceLabel } from '../lib/document.ts';
import { errorMessage, isJsonObject, parseJson, requireValue } from '../lib/json.ts';
import { serializeTokenPointer } from '../lib/token-path.ts';
import { dtcgTypes } from '../lib/token-types.ts';
import type { MetadataChange, Review, Workspace } from '../lib/workspace.ts';

export interface MetadataLocation { kind: 'token' | 'group'; path: string }

interface Fields {
  description: string;
  type: string;
  base: string;
  deprecation: string;
  reason: string;
  extensions: string;
}

function formattedMetadata(workspace: Workspace, file: string, path: string): Fields {
  const source = requireValue(workspace.files.find(entry => entry.path === file), 'metadata source');
  const data = nodeAt(source.tree, path);
  const node = isJsonObject(data) ? data : {};
  const deprecation = node['$deprecated'];
  const extension = node['$extends'] ?? node['$ref'];
  return {
    description: typeof node['$description'] === 'string' ? node['$description'] : '',
    type: typeof node['$type'] === 'string' ? node['$type'] : '',
    base: typeof extension === 'string' ? extension : referenceLabel(extension) ?? '',
    deprecation: typeof deprecation === 'string' ? 'reason' : typeof deprecation === 'boolean' ? String(deprecation) : '',
    reason: typeof deprecation === 'string' ? deprecation : '',
    extensions: node['$extensions'] === undefined ? '' : JSON.stringify(node['$extensions'], null, 2),
  };
}

function metadataPatch(initial: Fields, draft: Fields): MetadataChange {
  const patch: MetadataChange = {};
  if (draft.description !== initial.description) patch.$description = draft.description || undefined;
  if (draft.type !== initial.type) patch.$type = draft.type || undefined;
  if (draft.base !== initial.base) {
    patch.$extends = draft.base.startsWith('{') ? draft.base : undefined;
    patch.$ref = draft.base && !draft.base.startsWith('{') ? draft.base : undefined;
  }
  if (draft.deprecation !== initial.deprecation || draft.deprecation === 'reason' && draft.reason !== initial.reason) {
    patch.$deprecated = draft.deprecation === 'reason' ? draft.reason :
      draft.deprecation ? draft.deprecation === 'true' : undefined;
  }
  if (draft.extensions !== initial.extensions) patch.$extensions = draft.extensions.trim() ? parseJson(draft.extensions) : undefined;
  return patch;
}

export function MetadataDialog({ workspace, location, reviewing, close, prepare, review }: {
  workspace: Workspace;
  location: MetadataLocation;
  reviewing: boolean;
  close: () => void;
  prepare: (changes: ReadonlyMap<string, MetadataChange>) => Review;
  review: (next: Review) => void;
}) {
  const { kind, path } = location;
  const id = useId();
  const graph = workspace.graph;
  const group = kind === 'group' ? graph.groups.get(path) : undefined;
  const token = kind === 'token' ? graph.tokens.get(path) : undefined;
  const files = token ? [token.file] : [...group?.definitions.keys() ?? []];
  const [file, setFile] = useState(() => files[0] ?? '');
  const [drafts, setDrafts] = useState(() => new Map<string, Fields>());
  const [error, setError] = useState('');
  const [namespace, setNamespace] = useState('');
  const initial = useMemo(() => formattedMetadata(workspace, file, path), [workspace, file, path]);
  const draft = drafts.get(file) ?? initial;
  const definition = group?.definitions.get(file);
  const effectiveMetadata = token?.node ?? definition?.node;
  const inheritedDescription = !initial.description && typeof effectiveMetadata?.['$description'] === 'string'
    ? effectiveMetadata['$description'] : undefined;
  const effectiveExtensions = effectiveMetadata?.['$extensions'];
  const inheritedExtensions = useMemo(() => effectiveExtensions === undefined ? '' : JSON.stringify(effectiveExtensions, null, 2), [effectiveExtensions]);
  const showInheritedExtensions = inheritedExtensions && inheritedExtensions !== initial.extensions;
  const currentType = token?.type ?? definition?.type;
  const currentDeprecation = token?.deprecated ?? definition?.deprecated;

  const targets = useMemo(() => kind === 'group' ? [...graph.groups].flatMap(([target, candidate]) => {
    if (!target) return [];
    return [...candidate.definitions.keys()].filter(source => source !== file ||
      (target !== path && !target.startsWith(path + '.') && !path.startsWith(target + '.'))).map(source => ({
      label: target + ' · ' + source, value: serializeTokenPointer(file, source, target.split('.')),
    }));
  }) : [], [file, graph.groups, kind, path]);
  const hasBase = targets.some(target => target.value === draft.base);
  const changedFiles = [...drafts].filter(([source, fields]) => {
    const original = formattedMetadata(workspace, source, path);
    return (['description', 'type', 'base', 'deprecation', 'reason', 'extensions'] as const).some(field => fields[field] !== original[field]);
  });
  const extensions = useMemo(() => {
    try {
      const value = draft.extensions.trim() ? parseJson(draft.extensions) : {};
      return isJsonObject(value) ? value : undefined;
    } catch { return undefined; }
  }, [draft.extensions]);

  function update<K extends keyof Fields>(field: K, value: Fields[K]) {
    setDrafts(previous => new Map(previous).set(file, { ...draft, [field]: value }));
    setError('');
  }

  return <ActionDialog title={kind === 'group' ? 'Group metadata' : 'Token metadata'} description={path || 'All tokens'}
    open={!reviewing} onOpenChange={open => { if (!open && !reviewing) close(); }}>
    <form className="grid min-w-0 gap-4" onSubmit={event => {
      event.preventDefault();
      try {
        const patches = new Map(changedFiles.map(([source, fields]) => [source, metadataPatch(formattedMetadata(workspace, source, path), fields)]));
        for (const [source, patch] of patches) if (!Object.keys(patch).length) patches.delete(source);
        if (patches.size) review(prepare(patches));
      } catch (failure) {
        setError(errorMessage(failure));
      }
    }}>
      {files.length > 1 ? <label htmlFor={id + "-file"} className="grid gap-1 text-sm">Source file
        <NativeSelect id={id + "-file"} value={file} onChange={event => { setFile(event.currentTarget.value); setNamespace(''); setError(''); }}>
          {files.map(source => <NativeSelectOption value={source} key={source}>{source}</NativeSelectOption>)}
        </NativeSelect>
      </label> : <p className="wrap-anywhere text-xs">{file}</p>}
      {files.length > 1 && <p className="text-xs text-muted-foreground">
        {changedFiles.length ? changedFiles.map(([source]) => source).join(', ') + ' will be reviewed together.' :
          'Each source has its own definition of this group.'}
      </p>}
      {definition && !definition.authored && <p className="wrap-anywhere text-xs">
        Inherited from {definition.source.path} · {definition.source.file}. Saving creates a local group.
      </p>}
      {definition?.extends && <p className="wrap-anywhere text-xs">
        Extends {definition.extends.path || 'All tokens'} · {definition.extends.file}
      </p>}
      <TextField label="Description" data-initial-focus value={draft.description}
        onChange={event => update('description', event.currentTarget.value)} />
      {inheritedDescription && <p className="wrap-anywhere text-xs text-muted-foreground">Inherited description · {inheritedDescription}</p>}
      {kind === 'group' && <FieldRow>
        <label htmlFor={id + "-type"} className="grid gap-1 text-sm">Default type
          <NativeSelect id={id + "-type"} value={draft.type} onChange={event => update('type', event.currentTarget.value)}>
            <NativeSelectOption value="">Inherited{currentType && !initial.type ? ' · ' + currentType : ''}</NativeSelectOption>
            {!dtcgTypes.some(type => type === draft.type) && draft.type && <NativeSelectOption value={draft.type}>{draft.type}</NativeSelectOption>}
            {dtcgTypes.map(type => <NativeSelectOption value={type} key={type}>{type}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        <label htmlFor={id + "-base"} className="grid gap-1 text-sm">Inherit from group
          <NativeSelect id={id + "-base"} value={draft.base} onChange={event => update('base', event.currentTarget.value)}>
            <NativeSelectOption value="">None</NativeSelectOption>
            {draft.base && !hasBase && <NativeSelectOption value={draft.base}>{draft.base}</NativeSelectOption>}
            {targets.map(target => <NativeSelectOption value={target.value} key={target.value}>{target.label}</NativeSelectOption>)}
          </NativeSelect>
        </label>
      </FieldRow>}
      <label htmlFor={id + "-status"} className="grid gap-1 text-sm">Deprecation
        <NativeSelect id={id + "-status"} value={draft.deprecation} onChange={event => update('deprecation', event.currentTarget.value)}>
          <NativeSelectOption value="">Inherited</NativeSelectOption>
          <NativeSelectOption value="false">Mark as not deprecated</NativeSelectOption>
          <NativeSelectOption value="true">Deprecated</NativeSelectOption>
          <NativeSelectOption value="reason">Deprecated with explanation</NativeSelectOption>
        </NativeSelect>
      </label>
      {draft.deprecation === 'reason' ? <TextField label="Explanation" value={draft.reason}
        onChange={event => update('reason', event.currentTarget.value)} /> :
        !draft.deprecation && currentDeprecation && <p className="text-xs">Inherited deprecation{typeof currentDeprecation === 'string' ? ' · ' + currentDeprecation : ''}</p>}
      <details className="grid gap-2"><summary className="cursor-pointer text-sm">Advanced metadata</summary>
        {extensions && <div className="grid gap-2 py-2">
          {Object.keys(extensions).map(key => <div key={key} className="flex items-center justify-between gap-2 text-sm">
            <span className="wrap-anywhere">{key}</span>
            <Button type="button" size="xsmall" variant="text" aria-label={'Remove namespace ' + key} onClick={() => {
              const next = { ...extensions };
              delete next[key];
              update('extensions', Object.keys(next).length ? JSON.stringify(next, null, 2) : '');
            }}>Remove</Button>
          </div>)}
          <div className="flex flex-wrap items-center gap-2">
            <TextField label="Vendor namespace" value={namespace} containerClassName="min-w-0 flex-1"
              onChange={event => setNamespace(event.target.value)} />
            <Button type="button" size="xsmall" variant="text" disabled={!namespace.trim() || Object.hasOwn(extensions, namespace.trim())}
              onClick={() => {
                update('extensions', JSON.stringify({ ...extensions, [namespace.trim()]: {} }, null, 2)); setNamespace('');
              }}>Add namespace</Button>
          </div>
        </div>}
        <label htmlFor={id + "-extensions"} className="grid gap-1 text-sm">Vendor extensions JSON
          <Textarea id={id + "-extensions"} value={draft.extensions} onChange={event => update('extensions', event.currentTarget.value)}
            rows={4} spellCheck={false} className="font-mono text-xs" placeholder='{"vendor.namespace": {}}' />
        </label>
        {showInheritedExtensions && <details className="min-w-0 text-xs">
          <summary className="cursor-pointer">Effective vendor extensions</summary>
          <pre className="mt-2 max-h-40 overflow-auto rounded border p-2 font-mono">{inheritedExtensions}</pre>
        </details>}
      </details>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="text" data-dialog-close="">Cancel</Button>
        <Button type="submit" disabled={!changedFiles.length}>Review metadata changes</Button>
      </div>
    </form>
  </ActionDialog>;
}
