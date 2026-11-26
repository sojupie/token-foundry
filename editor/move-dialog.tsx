import { useMemo, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, TextField, Select, SelectOption } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import { leafName, parentPath } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { errorMessage, requireValue } from '../lib/json.ts';
import type { Move } from '../lib/structure.ts';
import { emptyLayerSite, resolverLayer } from '../lib/resolver.ts';
import type { TokenFile } from '../lib/token-types.ts';
import type { ResolverModel } from '../lib/resolver.ts';
import { useVariantResolution } from './lib/variant-resolution.ts';
import type { MoveDestination, Review } from '../lib/workspace.ts';
import { FolderTree } from './folder-tree.tsx';

export type MoveOperation = 'rename' | 'move' | 'duplicate';

const defaultInputs = {};

export function MoveDialog({ paths, operation, graph, scopeLabel, model, files, offThread = false, close, prepare, review, reviewing }: {
  scopeLabel?: string | undefined;
  model?: ResolverModel | undefined;
  files?: readonly TokenFile[];
  offThread?: boolean;
  paths: readonly string[]; operation: MoveOperation; graph: DocumentGraph; reviewing: boolean; close: () => void;
  prepare: (moves: Move[], target?: MoveDestination) => Review | Promise<Review>; review: (pending: Review) => void;
}) {
  const single = paths.length === 1 ? paths[0] : undefined;
  const rename = operation === 'rename';
  const duplicate = operation === 'duplicate';
  const named = rename || duplicate && !!single;
  const label = single && graph.groups.has(single) ? 'Group name' : 'Token name';
  const [destination, setDestination] = useState<string | undefined>(single ? parentPath(single) : duplicate ? undefined : '');
  const [setKey, setSetKey] = useState('');
  const [sourceIndex, setSourceIndex] = useState(0);
  const options = useMemo(() => model ? [
    ...[...model.sets.keys()].map(set => ({ label: set, layer: { set } })),
    ...[...model.modifiers].flatMap(([modifier, entry]) => [...entry.contexts.keys()].map(context => ({
      label: modifier + ' / ' + context, layer: { option: { modifier, context } },
    }))),
  ] : [], [model]);
  const layer = options[Number(setKey) - 1]?.layer;
  const destinationModel = useMemo(() => model && layer ? resolverLayer(model, layer) : undefined, [model, layer]);
  const resolved = useVariantResolution(destinationModel, defaultInputs, offThread);
  const resolution = resolved.pending ? undefined : resolved.value;
  const targetGraph = layer ? resolution?.graph : graph;
  const empty = model && layer && files && destination === '' ? emptyLayerSite(model, layer, files) : undefined;
  const candidates = empty ? [empty] : [...new Map((resolution?.origins.get(destination ?? '') ?? [])
    .map(origin => [JSON.stringify([origin.file, origin.parts]), origin])).values()];
  const targetSource = candidates[sourceIndex];
  const target = layer && targetSource && destination !== undefined
    ? { layer, source: { file: targetSource.file, parts: targetSource.parts }, group: destination } : undefined;
  const [name, setName] = useState(() => {
    if (!single) return '';
    if (!duplicate) return leafName(single);
    const parent = parentPath(single);
    const base = (leafName(single) === '$root' ? 'root' : leafName(single)) + '-copy';
    let candidate = base;
    let suffix = 2;
    while (graph.tokens.has([parent, candidate].filter(Boolean).join('.')) ||
      graph.groups.has([parent, candidate].filter(Boolean).join('.'))) candidate = base + '-' + suffix++;
    return candidate;
  });
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const allowed = useMemo(() => new Set(rename || !targetGraph ? [] : [...targetGraph.groups.keys()].filter(group =>
    !!layer || !paths.some(path => group === path || group.startsWith(path + '.')))), [layer, paths, rename, targetGraph]);
  const action = rename ? 'Rename' : duplicate ? 'Duplicate' : 'Move';
  const title = action + (single ? graph.groups.has(single) ? ' group' : ' token' : ' selected tokens');

  return <ActionDialog open={!reviewing} busy={checking} onOpenChange={open => { if (!open && !reviewing && !checking) close(); }} title={title}
    description={[single ?? paths.length + ' tokens selected', scopeLabel && 'Editing ' + scopeLabel].filter(Boolean).join(' · ')}>
      <form noValidate className="grid gap-space200" onSubmit={(event) => {
        event.preventDefault();
        if (checking) return;
        try {
          if (named && (!name.trim() || /[.{}]/u.test(name))) throw new Error('Enter a name without periods or braces.');
          if (layer && !target) throw new Error('Choose a destination group and source.');
          const groupGraph = requireValue(targetGraph, 'destination set');
          const occupied = new Set([...groupGraph.tokens.keys(), ...groupGraph.groups.keys()]);
          const moves = paths.flatMap(path => {
            const groupPath = destination ?? parentPath(path);
            const group = requireValue(groupGraph.groups.get(groupPath), 'destination group');
            const leaf = named ? name.trim() : leafName(path);
            let to = [groupPath, leaf].filter(Boolean).join('.');
            if (duplicate && !single && occupied.has(to)) {
              const base = [groupPath, (leaf === '$root' ? 'root' : leaf) + '-copy'].filter(Boolean).join('.');
              to = base;
              let suffix = 2;
              while (occupied.has(to)) to = base + '-' + suffix++;
            }
            occupied.add(to);
            if (target) return [{ path, to, file: target.source.file }];
            if (to === path) return [];
            const source = graph.tokens.get(path)?.file ?? graph.groups.get(path)?.files.keys().next().value;
            const file = source && group.files.has(source) ? source : group.files.size === 1 ? group.files.keys().next().value : undefined;
            if (!file) throw new Error('Choose a more specific destination group.');
            return [{ path, to, file }];
          });
          setChecking(true);
          void Promise.resolve(prepare(moves, target)).then(review)
            .catch((failure: unknown) => setError(errorMessage(failure))).finally(() => setChecking(false));
        } catch (failure) { setChecking(false); setError(errorMessage(failure)); }
      }}>
        {named && <TextField label={label} data-initial-focus value={name} onChange={(event) => setName(event.target.value)} required />}
        {operation === 'move' && options.length > 0 && <Select label="Destination set" value={setKey} onChange={event => {
          const value = event.target.value;
          setSetKey(value); setDestination(value ? '' : single ? parentPath(single) : ''); setSourceIndex(0); setError('');
        }}>
          <SelectOption value="">Keep each token in its current set</SelectOption>
          {options.map(({ label: optionLabel }, index) =>
            <SelectOption key={optionLabel} value={String(index + 1)}>{optionLabel}</SelectOption>)}
        </Select>}
        {!rename && <div className="grid gap-space100">
          <p className="copy-body copy-emphasis">Destination group</p>
          <div className="scroll-pane-md overflow-auto rounded-md border">
            {targetGraph ? <FolderTree key={setKey} groups={targetGraph.groups} allowed={allowed} current={destination ?? ''}
              select={path => { setDestination(path); setSourceIndex(0); setError(''); }} label="Destination group" rootLabel="Top level" /> :
              <output className="block pad-space100">{resolved.error ?? 'Loading destination groups…'}</output>}
          </div>
          <p className="wrap-anywhere copy-small tone-supporting">{destination === undefined ? 'Same groups as the originals' : destination || 'Top level'}</p>
          {layer && resolution && !candidates.length && <p className="copy-body tone-supporting">This group needs a source in the destination set.</p>}
          {candidates.length > 1 && <Select label="Destination source" value={String(sourceIndex)} onChange={event => setSourceIndex(Number(event.target.value))}>
            {candidates.map(({ file, parts }, index) => <SelectOption key={`${file}:${parts.join('/')}:${String(index)}`} value={String(index)}>
              {file}{parts.length > 0 ? ' · ' + parts.join(' / ') : ''}
            </SelectOption>)}
          </Select>}
          {duplicate && !single && destination !== undefined && <Button type="button" variant="text" onClick={() => setDestination(undefined)}>
            Use original groups
          </Button>}
        </div>}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap justify-end gap-space100">
          <Button type="button" variant="text" data-dialog-close="">Cancel</Button>
          <Button type="submit" disabled={checking || (layer ? !target : named ? !name.trim() || destination === parentPath(single ?? '') && name.trim() === leafName(single ?? '') :
            !duplicate && paths.every(path => destination === parentPath(path)))}>{'Review ' + operation}</Button>
        </div>
      </form>
  </ActionDialog>;
}
