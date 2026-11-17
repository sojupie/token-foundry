import { lazy, Suspense, useId, useMemo, useState } from 'react';
import { Button, TextField } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FieldRow } from '@/components/ui/field-row';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { leafName, parentPath, referenceLabel } from '../lib/document.ts';
import { errorMessage, isJsonObject, parseJson, requireValue } from '../lib/json.ts';
import type { JsonValue } from '../lib/json.ts';
import { tokenFieldType } from '../lib/validate-token.ts';
import { dtcgTypes } from '../lib/token-types.ts';
import { serializeTokenPointer } from '../lib/token-path.ts';
import { needsBulkReplacement, optionalValueFields, reviewBulkEdit, reviewMoves } from '../lib/workspace.ts';
import { runWorkspaceReview } from './lib/workspace-review.ts';
import type { BulkEdit, Review, Workspace } from '../lib/workspace.ts';
import { defaultValue, valueFieldEditorType, valueFieldLabel } from './lib/value-shape.ts';
import { ReferenceDialog } from './reference-picker.tsx';
import { TokenValue } from './token-value.tsx';

const BulkValueInput = lazy(() => import('./typed-value.tsx').then(module => ({ default: module.BulkValueInput })));

export type SelectionEdit = 'rename' | 'value' | 'type' | 'description';

export const selectionEditLabels = {
  rename: 'Rename', value: 'Change value', type: 'Change type', description: 'Change description',
};

function sharedFields(value: JsonValue | undefined, type: string | undefined, path: readonly string[] = []): string[][] {
  if (!Array.isArray(value) && (!isJsonObject(value) || Object.hasOwn(value, '$ref'))) return [];
  const keys = new Set([...Object.keys(value), ...optionalValueFields(type)]);
  return [...keys].flatMap(key => {
    const child = Array.isArray(value) ? value[Number(key)] : value[key];
    const parts = [...path, key];
    return tokenFieldType(type, parts) ? [parts].concat(sharedFields(child, type, parts)) : [];
  });
}

function valueAt(value: JsonValue | undefined, parts: readonly string[]) {
  return parts.reduce<JsonValue | undefined>((node, part) => Array.isArray(node) ? node[Number(part)] :
    isJsonObject(node) && Object.hasOwn(node, part) ? node[part] : undefined, value);
}

export function BulkEditDialog({ workspace, paths, action, reviewing, close, review }: {
  workspace: Workspace;
  paths: readonly string[];
  action: SelectionEdit;
  reviewing: boolean;
  close: () => void;
  review: (next: Review) => void;
}) {
  const [field, setField] = useState('');
  const [replaceLinks, setReplaceLinks] = useState(false);
  const [value, setValue] = useState<JsonValue>();
  const [type, setType] = useState('');
  const [description, setDescription] = useState('');
  const [renameMode, setRenameMode] = useState('replace');
  const [find, setFind] = useState('');
  const [name, setName] = useState('');
  const [regex, setRegex] = useState(false);
  const [raw, setRaw] = useState<string>();
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const id = useId();
  const { graph } = workspace;
  const tokens = useMemo(() => paths.map(path => ({ ...requireValue(graph.tokens.get(path), path), path })), [graph, paths]);
  const first = requireValue(tokens[0], 'selected token');
  const file = first.file;
  const commonType = tokens.every(token => token.type === first.type) ? first.type : undefined;
  const fieldOptions = useMemo(() => {
    const options = new Map<string, { parts: string[]; label: string; type: string }>();
    if (action !== 'value') return options;
    for (const token of tokens) {
      const shape = graph.resolved.get(token.path) ?? token.value;
      for (const parts of sharedFields(shape, token.type)) {
        const fieldType = valueFieldEditorType(token.type, parts);
        if (!fieldType) continue;
        const key = JSON.stringify([parts, fieldType]);
        if (!options.has(key)) options.set(key, { parts, label: valueFieldLabel(parts, shape, token.type), type: fieldType });
      }
    }
    return options;
  }, [action, graph, tokens]);
  const option = fieldOptions.get(field);
  const parts = option?.parts ?? [];
  const targetType = action === 'type' ? type : option?.type ?? commonType ?? type;
  const incompatible = useMemo(() => action === 'type' && type ? paths.filter(path => needsBulkReplacement(graph, path, type)) : [],
    [action, graph, paths, type]);
  const showValue = action === 'value' || incompatible.length > 0;
  const eligible = tokens.filter(token => {
    if (!option) return true;
    if (valueFieldEditorType(token.type, parts) !== option.type) return false;
    const shape = replaceLinks && referenceLabel(token.value) ? graph.resolved.get(token.path) : token.value;
    const parent = valueAt(shape, parts.slice(0, -1));
    return !referenceLabel(parent) && (valueAt(shape, parts) !== undefined ||
      isJsonObject(parent) && optionalValueFields(tokenFieldType(token.type, parts.slice(0, -1))).includes(parts.at(-1) ?? ''));
  });
  const linkedCount = option ? tokens.filter(token => referenceLabel(token.value)).length : 0;
  const addedCount = option ? eligible.filter(token => valueAt(graph.resolved.get(token.path) ?? token.value, parts) === undefined).length : 0;
  const current = action === 'rename' ? [] : tokens.map(token => action === 'description' ? token.node.$description :
    action === 'type' ? token.type : valueAt(token.value, parts));
  const firstValue = JSON.stringify(current[0]);
  const common = current.every(item => JSON.stringify(item) === firstValue);
  const initial = targetType && (action === 'type' || !common || current[0] === undefined || referenceLabel(current[0]))
    ? defaultValue(targetType) : current[0];
  let pattern: RegExp | undefined;
  let patternError = '';
  if (action === 'rename' && regex && find && renameMode === 'replace') {
    try { pattern = new RegExp(find, 'gu'); } catch (failure) { patternError = errorMessage(failure); }
  }
  const moves = action === 'rename' ? paths.flatMap((path, index) => {
    const original = leafName(path);
    const next = renameMode === 'prefix' ? name + original : renameMode === 'suffix' ? original + name :
      pattern ? original.replace(pattern, name) : find ? original.replaceAll(find, () => name) : original;
    const token = tokens[index];
    if (!token || next === original) return [];
    return [{ path, to: [parentPath(path), next].filter(Boolean).join('.'), file: token.file, name: next }];
  }) : [];
  const destinations = new Map<string, number>();
  for (const move of moves) destinations.set(move.to, (destinations.get(move.to) ?? 0) + 1);
  const collisions = new Set(moves.filter(move => graph.tokens.has(move.to) || graph.groups.has(move.to) || (destinations.get(move.to) ?? 0) > 1));
  const count = paths.length.toLocaleString('en') + (paths.length === 1 ? ' token' : ' tokens');

  function resetValue() {
    setValue(undefined);
    setRaw(undefined);
    setError('');
  }

  function reviewBulk(selection: readonly string[], edit: BulkEdit) {
    if (graph.rows.length < 1000) return review(reviewBulkEdit(workspace, selection, edit));
    setChecking(true);
    void runWorkspaceReview({ kind: 'bulk', workspace, paths: selection, edit }).then(review)
      .catch((failure: unknown) => setError(errorMessage(failure))).finally(() => setChecking(false));
  }

  function submit() {
    if (checking) return;
    setError('');
    try {
      if (action === 'rename') {
        if (patternError) throw new Error(patternError);
        if (!moves.length) throw new Error('Enter a name change that matches at least one selected token.');
        if (moves.some(move => !move.name || /[.{}]/u.test(move.name) || move.name.startsWith('$'))) throw new Error('Enter valid token names without periods, braces, or a leading dollar sign.');
        if (graph.rows.length < 1000) review(reviewMoves(workspace, moves, true));
        else {
          setChecking(true);
          void runWorkspaceReview({ kind: 'move', workspace, moves, operation: 'rename' }).then(review)
            .catch((failure: unknown) => setError(errorMessage(failure))).finally(() => setChecking(false));
        }
        return;
      }
      if (action === 'description') {
        reviewBulk(paths, { kind: action, value: description });
        return;
      }
      if (!targetType) throw new Error('Choose a type.');
      const replacement = showValue ? raw === undefined ? value ?? initial : parseJson(raw) : undefined;
      if (showValue && replacement === undefined) throw new Error('Enter a replacement value or link a token.');
      if (action === 'type') {
        reviewBulk(paths, { kind: action, value: type, ...(replacement !== undefined ? { replacement, referenceFile: file } : {}) });
      } else if (replacement !== undefined) {
        const pointer = parts.length ? '/' + parts.map(part => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/') : '';
        reviewBulk(eligible.map(token => token.path), { kind: action, value: replacement, referenceFile: file, replaceLinks, ...(pointer ? { pointer } : {}) });
      }
    } catch (failure) { setError(errorMessage(failure)); }
  }

  return <ActionDialog open={!reviewing} busy={checking} title={selectionEditLabels[action] + ' · ' + count}
    onOpenChange={open => { if (!open && !reviewing && !checking) close(); }} style={{ inlineSize: '38rem' }}>
    <form noValidate className="bulk-token-fields grid min-w-0 gap-3" onSubmit={event => { event.preventDefault(); submit(); }}>
      {action === 'rename' ? <>
        <label className="grid gap-1 text-sm" htmlFor={id + '-rename'}>Rename method
          <NativeSelect className="w-full" id={id + '-rename'} value={renameMode} data-initial-focus onChange={event => setRenameMode(event.target.value)}>
            <NativeSelectOption value="replace">Find and replace</NativeSelectOption>
            <NativeSelectOption value="prefix">Add prefix</NativeSelectOption>
            <NativeSelectOption value="suffix">Add suffix</NativeSelectOption>
          </NativeSelect>
        </label>
        <FieldRow>
          {renameMode === 'replace' && <TextField label="Find in token name" value={find} invalid={!!patternError}
            supporting={patternError || undefined} onChange={event => setFind(event.target.value)} />}
          <TextField label={renameMode === 'replace' ? 'Replace with' : renameMode === 'prefix' ? 'Prefix' : 'Suffix'} value={name} onChange={event => setName(event.target.value)} />
        </FieldRow>
        {renameMode === 'replace' && <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={regex} onChange={event => setRegex(event.target.checked)} />Use regular expression
        </label>}
        <section aria-label="Rename preview" className="grid gap-1 text-sm">
          <p>{moves.length} of {count} will change</p>
          <ul className="max-h-40 overflow-auto font-mono text-xs">
            {moves.slice(0, 50).map(move => <li className="wrap-anywhere py-1" key={move.path}>{move.path} → {move.to}
              {collisions.has(move) && <span className="text-destructive"> · Name already in use</span>}</li>)}
          </ul>
          {moves.length > 50 && <p>Showing the first 50 changes.</p>}
        </section>
      </> : <>
        {action === 'value' && fieldOptions.size > 0 && <label className="grid gap-1 text-sm" htmlFor={id + '-field'}>Part to change
          <NativeSelect id={id + '-field'} className="w-full" value={field} onChange={event => { setField(event.target.value); resetValue(); }}>
            <NativeSelectOption value="">Entire value</NativeSelectOption>
            {[...fieldOptions].map(([key, part]) => <NativeSelectOption key={key} value={key}>{part.label}</NativeSelectOption>)}
          </NativeSelect>
        </label>}
        {option && <div className="grid gap-1 text-sm">
          <p>{eligible.length} eligible · {addedCount} missing this field · {paths.length - eligible.length} skipped</p>
          {linkedCount > 0 && <label className="flex gap-2"><input type="checkbox" checked={replaceLinks}
            onChange={event => setReplaceLinks(event.target.checked)} />Replace whole-value links with their resolved values before changing this part ({linkedCount})</label>}
        </div>}
        <section aria-label="Current values" className="grid gap-1 rounded-lg border p-2 text-sm">
          <h3 className="font-medium">Current {action === 'type' ? 'type' : action === 'description' ? 'description' : 'value'}</h3>
          {common ? <TokenValue value={current[0]} authored swatch wrap /> : <details>
            <summary className="cursor-pointer">Mixed {action === 'type' ? 'types' : action === 'description' ? 'descriptions' : 'values'}</summary>
            <ul className="mt-2 grid max-h-32 gap-2 overflow-auto">{paths.slice(0, 50).map((path, index) => <li key={path}>
              <code className="wrap-anywhere text-xs">{path}</code><TokenValue value={current[index]} authored swatch wrap />
            </li>)}</ul>
          </details>}
        </section>
        {(action === 'type' || action === 'value' && !commonType && !parts.length) && <label className="grid gap-1 text-sm" htmlFor={id + '-type'}>
          {action === 'type' ? 'New token type' : 'Type of replacement value'}
          <NativeSelect id={id + '-type'} className="w-full" value={type} onChange={event => { setType(event.target.value); resetValue(); }}>
            <NativeSelectOption value="">Choose a type…</NativeSelectOption>
            {dtcgTypes.map(item => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}
          </NativeSelect>
        </label>}
        {incompatible.length > 0 && <details className="text-sm" open>
          <summary className="cursor-pointer">{incompatible.length} need a replacement value</summary>
          <ul className="max-h-28 overflow-auto text-xs">{incompatible.slice(0, 50).map(path => <li key={path}>{path}</li>)}</ul>
        </details>}
        {action === 'description' && <TextField label="New description" value={description} onChange={event => setDescription(event.target.value)} supporting="Leave blank to remove the descriptions." />}
        {showValue && targetType && <>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="xsmall" type="button" variant="text" onClick={() => {
              if (raw === undefined) setRaw(JSON.stringify(value ?? initial, null, 2) ?? '');
              else {
                try { setValue(parseJson(raw)); setRaw(undefined); setError(''); }
                catch (failure) { setError(errorMessage(failure)); }
              }
            }}>{raw === undefined ? 'Raw JSON' : 'Use typed editor'}</Button>
            <Button size="xsmall" type="button" variant="text" onClick={() => setLinking(true)}>Link a token</Button>
          </div>
          {raw === undefined ? <Suspense fallback={<output>Loading value editor…</output>}>
            <BulkValueInput {...{ graph, file, paths }} field={parts} type={targetType}
              label="Replacement value" value={value ?? initial} write={next => { setValue(next); setError(''); }} />
          </Suspense> :
            <Textarea aria-label="Replacement value JSON" rows={5} value={raw} onChange={event => setRaw(event.target.value)} />}
        </>}
      </>}
      {(error || patternError) && <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap">{error || patternError}</AlertDescription></Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="text" data-dialog-close="" disabled={checking}>Cancel</Button>
        <Button type="submit" disabled={checking || collisions.size > 0 || !eligible.length}>Review edits</Button>
      </div>
    </form>
    {linking && <ReferenceDialog graph={graph} source="" sourcePaths={paths} sourceField={parts} type={targetType} target={undefined} seed="" flexible={false}
      close={() => setLinking(false)} choose={choice => {
        const target = requireValue(graph.tokens.get(choice.path), 'linked token');
        setValue(choice.field.length ? { $ref: serializeTokenPointer(file, target.file, [...choice.path.split('.'), '$value', ...choice.field]) } : '{' + choice.path + '}');
        setRaw(undefined);
        return true;
      }} />}
  </ActionDialog>;
}
