import { lazy, Suspense, useId, useState } from 'react';
import { Button, TextField } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FieldRow } from '@/components/ui/field-row';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { leafName, parentPath } from '../lib/document.ts';
import { errorMessage, isJsonObject, parseJson, requireValue } from '../lib/json.ts';
import type { JsonValue } from '../lib/json.ts';
import { tokenFieldType } from '../lib/validate-token.ts';
import { dtcgTypes } from '../lib/token-types.ts';
import { serializeTokenPointer } from '../lib/token-path.ts';
import { needsBulkReplacement, reviewBulkEdit, reviewMoves } from '../lib/workspace.ts';
import type { Review, Workspace } from '../lib/workspace.ts';
import { defaultValue } from './lib/value-shape.ts';
import { ReferenceDialog } from './reference-picker.tsx';
import { TokenValue } from './token-value.tsx';

const BulkValueInput = lazy(() => import('./typed-value.tsx').then(module => ({ default: module.BulkValueInput })));

export type SelectionEdit = 'rename' | 'value' | 'type' | 'description';

export const selectionEditLabels = {
  rename: 'Rename', value: 'Change value', type: 'Change type', description: 'Change description',
};

function sharedFields(value: JsonValue | undefined, type: string | undefined, path: readonly string[] = []): string[][] {
  if (!Array.isArray(value) && (!isJsonObject(value) || Object.hasOwn(value, '$ref'))) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const parts = [...path, key];
    return tokenFieldType(type, parts) ? [parts].concat(sharedFields(child, type, parts)) : [];
  });
}

function fieldName(parts: readonly string[]) {
  return parts.map(part => /^\d+$/u.test(part) ? String(Number(part) + 1) :
    part.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/^./u, char => char.toUpperCase())).join(' › ');
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
  const id = useId();
  const { graph } = workspace;
  const tokens = paths.map(path => requireValue(graph.tokens.get(path), path));
  const first = requireValue(tokens[0], 'selected token');
  const file = first.file;
  const commonType = tokens.every(token => token.type === first.type) ? first.type : undefined;
  const fields = action === 'value' ? sharedFields(first.value, first.type).filter(parts => tokens.every(token =>
    tokenFieldType(token.type, parts) === tokenFieldType(first.type, parts) && valueAt(token.value, parts) !== undefined)) : [];
  const parts = fields.find(candidate => JSON.stringify(candidate) === field) ?? [];
  const targetType = action === 'type' ? type : parts.length ? tokenFieldType(first.type, parts) : commonType ?? type;
  const incompatible = action === 'type' && type ? paths.filter(path => needsBulkReplacement(graph, path, type)) : [];
  const showValue = action === 'value' || incompatible.length > 0;
  const current = tokens.map(token => action === 'description' ? token.node.$description :
    action === 'type' ? token.type : valueAt(token.value, parts));
  const common = current.every(item => JSON.stringify(item) === JSON.stringify(current[0]));
  const initial = targetType && (action === 'type' || !common || current[0] === undefined || typeof current[0] === 'object' || !current[0])
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
  const collisions = moves.filter((move, index) => graph.tokens.has(move.to) || graph.groups.has(move.to) ||
    moves.some((other, otherIndex) => otherIndex !== index && other.to === move.to));
  const count = paths.length.toLocaleString('en') + (paths.length === 1 ? ' token' : ' tokens');

  function resetValue() {
    setValue(undefined);
    setRaw(undefined);
    setError('');
  }

  function submit() {
    setError('');
    try {
      if (action === 'rename') {
        if (patternError) throw new Error(patternError);
        if (!moves.length) throw new Error('Enter a name change that matches at least one selected token.');
        if (moves.some(move => !move.name || /[.{}]/u.test(move.name) || move.name.startsWith('$'))) throw new Error('Enter valid token names without periods, braces, or a leading dollar sign.');
        review(reviewMoves(workspace, moves, true));
        return;
      }
      if (action === 'description') {
        review(reviewBulkEdit(workspace, paths, { kind: action, value: description }));
        return;
      }
      if (!targetType) throw new Error('Choose a type.');
      const replacement = showValue ? raw === undefined ? value : parseJson(raw) : undefined;
      if (showValue && replacement === undefined) throw new Error('Enter a replacement value or link a token.');
      if (action === 'type') {
        review(reviewBulkEdit(workspace, paths, { kind: action, value: type, ...(replacement !== undefined ? { replacement, referenceFile: file } : {}) }));
      } else if (replacement !== undefined) {
        const pointer = parts.length ? '/' + parts.map(part => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/') : '';
        review(reviewBulkEdit(workspace, paths, { kind: action, value: replacement, referenceFile: file, ...(pointer ? { pointer } : {}) }));
      }
    } catch (failure) { setError(errorMessage(failure)); }
  }

  return <ActionDialog open={!reviewing} title={selectionEditLabels[action] + ' · ' + count}
    onOpenChange={open => { if (!open && !reviewing) close(); }} style={{ inlineSize: '38rem' }}>
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
            {moves.map(move => <li className="wrap-anywhere py-1" key={move.path}>{move.path} → {move.to}
              {collisions.includes(move) && <span className="text-destructive"> · Name already in use</span>}</li>)}
          </ul>
        </section>
      </> : <>
        {action === 'value' && fields.length > 0 && <label className="grid gap-1 text-sm" htmlFor={id + '-field'}>Part to change
          <NativeSelect id={id + '-field'} className="w-full" value={field} onChange={event => { setField(event.target.value); resetValue(); }}>
            <NativeSelectOption value="">Entire value</NativeSelectOption>
            {fields.map(part => <NativeSelectOption key={JSON.stringify(part)} value={JSON.stringify(part)}>{fieldName(part)}</NativeSelectOption>)}
          </NativeSelect>
        </label>}
        <section aria-label="Current values" className="grid gap-1 rounded-lg border p-2 text-sm">
          <h3 className="font-medium">Current {action === 'type' ? 'type' : action === 'description' ? 'description' : 'value'}</h3>
          {common ? <TokenValue value={current[0]} authored swatch wrap /> : <details>
            <summary className="cursor-pointer">Mixed {action === 'type' ? 'types' : action === 'description' ? 'descriptions' : 'values'}</summary>
            <ul className="mt-2 grid max-h-32 gap-2 overflow-auto">{paths.map((path, index) => <li key={path}>
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
          <ul className="max-h-28 overflow-auto text-xs">{incompatible.map(path => <li key={path}>{path}</li>)}</ul>
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
        <Button type="button" variant="text" data-dialog-close="">Cancel</Button>
        <Button type="submit" disabled={collisions.length > 0}>Review edits</Button>
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
