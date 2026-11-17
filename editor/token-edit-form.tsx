import { lazy, Suspense, useId, useState } from 'react';
import { Link2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, TextField } from '@token-catalog/forge-react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, parseJson } from '../lib/json.ts';
import { colorHex } from '../lib/color.ts';
import { parentPath, referenceLabel } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { dtcgTypes, isColor } from '../lib/token-types.ts';
import type { Draft } from './lib/draft.ts';
import { displayInput, inputFormat, readInput, validateInputValue } from './lib/token-input.ts';
import { ReferenceDialog } from './reference-picker.tsx';
import type { ReferenceChoice } from './reference-picker.tsx';
import { serializeTokenPointer } from '../lib/token-path.ts';
import { TokenValue } from './token-value.tsx';
import { canEditType, defaultValue } from './lib/value-shape.ts';
import type { JsonValue } from '../lib/json.ts';
import { tokenValueIssues, validateTokenValue } from '../lib/validate-token.ts';

const TypedEditorPanel = lazy(() => import('./typed-value.tsx'));

interface Props {
  initialDraft: Draft;
  graph: DocumentGraph;
  onEdit?: () => void;
  inspectorActive?: boolean;
  valueOnly?: boolean;
  referenceFile?: string;
  sourceChoices?: ReadonlyMap<string, string>;
  commit: (draft: Draft) => boolean;
  cancel: () => void;
  error: string;
  busy: boolean;
}

function focusType(select: HTMLSelectElement | null) {
  select?.focus({ preventScroll: true });
}

function RawValueForm({ id, initialType, draft, authored, apply, close }: {
  id: string;
  initialType: string | undefined;
  draft: Draft;
  authored: string | undefined;
  apply: (draft: Draft) => boolean | void;
  close: () => void;
}) {
  const [type, setType] = useState(initialType ?? '');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  return <form id={id} className="grid self-start gap-4" onSubmit={event => {
    event.preventDefault();
    event.stopPropagation();
    setError('');
    try {
      const value = readInput(text, type, draft.original);
      if (referenceLabel(value)) throw new Error('Enter a raw value or switch back to Find a reference.');
      validateInputValue(type, value);
      if (apply({ ...draft, type, value: text }) !== false) close();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }}>
    <TokenTypeField value={type} {...{ authored }} onChange={setType} selectRef={focusType} required />
    <ValueInput value={text} setValue={setText} format={inputFormat(type)} required />
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </form>;
}

export function TokenReferenceDialog({ draft, graph, type, seed, choose, applyRawValue, close, error, referenceFile }: Pick<Props, 'graph'> & {
  draft: Draft;
  type: string | undefined;
  seed: string;
  choose: (value: string) => boolean | void;
  applyRawValue: (draft: Draft) => boolean | void;
  referenceFile?: string | undefined;
  close: () => void;
  error?: string;
}) {
  const originalReference = referenceLabel(draft.original);
  const alias = /^\{([^{}]+)\}$/u.exec(draft.value)?.[1];
  const matching = originalReference && draft.value === displayInput(type, draft.original)
    ? [...(graph.links.get(draft.path)?.values() ?? [])].find(link => link.field.length === 1 && link.text === originalReference) : undefined;
  const valueIndex = matching?.parts.indexOf('$value') ?? -1;
  const target = alias ? { path: alias, field: [] } : matching?.target && (valueIndex >= 0 || matching.parts.join('.') === matching.target)
    ? { path: matching.target, field: valueIndex < 0 ? [] : matching.parts.slice(valueIndex + 1) } : undefined;
  function applyReference(choice: ReferenceChoice) {
    if (matching && target?.path === choice.path && target.field.length === choice.field.length &&
      target.field.every((part, index) => part === choice.field[index])) return choose(draft.value);
    if (!choice.field.length) return choose('{' + choice.path + '}');
    const file = referenceFile ?? (draft.create ? draft.file : graph.tokens.get(draft.path)?.file);
    const destination = graph.tokens.get(choice.path)?.file;
    if (!file || destination === undefined) return false;
    return choose(JSON.stringify({ $ref: serializeTokenPointer(file, destination, [...choice.path.split('.'), '$value', ...choice.field]) }));
  }
  const flexible = draft.create || draft.mode === 'inspector' || draft.column === 'type' ?
    !draft.type : !graph.tokens.get(draft.path)?.node.$type;
  return <ReferenceDialog graph={graph} source={draft.create ? '' : draft.path} {...{ type, seed, target, flexible, close }} choose={applyReference}
    error={error ?? ''} renderRawForm={(id, closeRaw) => <RawValueForm {...{ id, draft }}
      initialType={type} authored={graph.tokens.get(draft.path)?.node.$type}
      apply={applyRawValue} close={closeRaw} />} />;
}

function ValueInput({ value, setValue, format, resolved, busy, required }: {
  value: string;
  setValue: (value: string) => void;
  format: ReturnType<typeof inputFormat>;
  resolved?: ReturnType<DocumentGraph['resolved']['get']>;
  busy?: boolean;
  required?: boolean;
}) {
  const color = /^#[0-9a-f]{6}$/iu.test(value) ? value :
    isColor(resolved) && resolved.colorSpace === 'srgb' ? colorHex(resolved) : '#000000';
  const input = { 'data-primary-editor': '', spellCheck: false, disabled: busy, required };
  if (format === 'json') return <Textarea {...input} aria-label="Token value" rows={4}
    className="min-w-0 resize-y font-mono text-xs" value={value} onChange={event => setValue(event.target.value)} />;
  return <TextField {...input} label="Token value" value={value} onChange={event => setValue(event.target.value)}
    trailing={format === 'hex' ? <input type="color" aria-label="Pick color" value={color} disabled={busy}
      className="workspace-color-picker" onChange={event => setValue(event.target.value)} /> : undefined} />;
}

function ValueField({ draft, graph, setDraft, busy, type, referenceFile }: Pick<Props, 'graph' | 'busy'> & {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  referenceFile?: string | undefined;
  type: string | undefined;
}) {
  const inspector = !draft.create && draft.mode === 'inspector';
  const [referenceSeed, setReferenceSeed] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const entry = graph.tokens.get(draft.path);
  const originalType = entry?.type;
  const originalValue = draft.create || type !== originalType || referenceLabel(draft.original) ? undefined : draft.original;
  const format = inputFormat(type, originalValue);
  const resolved = graph.resolved.get(draft.path);
  const valueIsOriginal = !draft.create && draft.value === displayInput(originalType, draft.original);
  const edit = { graph, source: draft.create ? '' : draft.path, file: referenceFile ?? (draft.create ? draft.file : entry?.file ?? ''), busy };
  let value: JsonValue | undefined;
  let parseError = '';
  try {
    value = valueIsOriginal ? draft.original : draft.value.trim() ? readInput(draft.value, type, draft.original) : undefined;
  } catch (failure) {
    parseError = errorMessage(failure);
  }
  const knownType = canEditType(type);
  const authored = value ?? (knownType && !draft.value ? defaultValue(type) : undefined);
  const codeText = value === undefined ? draft.value : JSON.stringify(value, null, 2);
  const [rawEdit, setRawEdit] = useState<{ text: string; value: string }>();
  const json = rawEdit?.value === draft.value ? rawEdit.text : codeText ?? '';
  let jsonIssue = '';
  let jsonValue: JsonValue | undefined;
  if (raw) {
    try { jsonValue = parseJson(json); }
    catch (failure) { jsonIssue = errorMessage(failure); }
  }
  const issues = raw && !jsonIssue ? [...tokenValueIssues(type, jsonValue, true)] : [];
  const typed = knownType && !referenceLabel(draft.original) && !referenceLabel(value) && !parseError;
  const panel = !raw && typed ? <Suspense fallback={<p className="text-xs text-muted-foreground">Loading value editor…</p>}>
    <TypedEditorPanel key={type + ':' + JSON.stringify(draft.original)} {...{ edit, type, resolved }} value={authored}
      original={valueIsOriginal} write={next => setDraft({ ...draft, value: next === undefined ? '' : JSON.stringify(next) })} />
  </Suspense> :
    <ValueInput value={draft.value} {...{ format, busy, resolved }} setValue={next => {
      setDraft({ ...draft, value: next });
      if (draft.create && format !== 'json' && next.startsWith('{')) setReferenceSeed(next.slice(1).replace(/\}$/u, ''));
    }} />;

  return <div className="grid min-w-0 gap-2">
    <div className="flex flex-wrap items-center justify-between gap-1">
      <span className="text-xs font-medium">Value</span>
      <div className="flex items-center gap-1">
        <Button type="button" size="xsmall" variant={raw ? 'tonal' : 'text'} pressed={raw} disabled={busy}
          onClick={() => { setRaw(!raw); if (!raw) setRawEdit(undefined); }}>Raw JSON</Button>
        <Button type="button" size="xsmall" variant="text" disabled={busy} aria-haspopup="dialog"
          onClick={() => setReferenceSeed('')}>
          <Link2 aria-hidden="true" /> Link token
        </Button>
      </div>
    </div>
    {raw ? <div className="grid gap-1">
      <Textarea data-primary-editor aria-label="Token value JSON" aria-invalid={!!jsonIssue || !!issues.length}
        rows={7} spellCheck={false} className="min-w-0 resize-y font-mono text-xs" disabled={busy} value={json}
        ref={input => input?.setCustomValidity(jsonIssue)}
        onChange={event => {
          const text = event.target.value;
          setRawEdit({ text, value: text });
          setDraft({ ...draft, value: text });
        }} />
      {jsonIssue && <p className="text-xs text-destructive" role="alert">{jsonIssue}</p>}
      {!!issues.length && <ul className="grid gap-1 text-xs text-destructive" aria-label="Value diagnostics">
        {issues.map(problem => <li key={problem}>{problem}</li>)}
      </ul>}
    </div> : panel}
    {referenceSeed !== null && <TokenReferenceDialog {...{ draft, graph, type, referenceFile }} seed={referenceSeed}
      choose={next => setDraft({ ...draft, value: next })}
      applyRawValue={setDraft} close={() => setReferenceSeed(null)} />}
    {inspector && valueIsOriginal && <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span>Resolved</span><TokenValue value={resolved} swatch wrap />
    </div>}
  </div>;
}

function TokenTypeField({ value, automatic, authored, onChange, disabled, selectRef, required }: {
  value: string;
  automatic?: string | undefined;
  authored?: string | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  selectRef?: (select: HTMLSelectElement | null) => void;
}) {
  const id = useId();
  const types = [...new Set([...dtcgTypes, ...[authored, value].filter(Boolean)])];
  return <div className="grid min-w-0 gap-1.5">
    <label className="text-sm font-medium" htmlFor={id}>Token type</label>
    <NativeSelect ref={selectRef} id={id} data-primary-editor className="w-full" disabled={disabled} required={required} value={value}
      onChange={(event) => onChange(event.target.value)}>
      <NativeSelectOption value="" disabled={automatic === undefined}>{automatic ?? 'Choose a type'}</NativeSelectOption>
      {types.map((option) => <NativeSelectOption key={option} value={option}>
        {option}{!dtcgTypes.some((known) => known === option) ? ' (document type)' : ''}
      </NativeSelectOption>)}
    </NativeSelect>
  </div>;
}

export function TokenEditForm({ initialDraft, graph, onEdit, inspectorActive, valueOnly, sourceChoices, referenceFile, commit, cancel, error, busy }: Props) {
  const [edit, setEdit] = useState<Draft | null>(null);
  const [valuesByType, setValuesByType] = useState(() => new Map<string, string>());
  const localDraft = inspectorActive === false ? null : edit;
  const draft = localDraft ?? initialDraft;
  function setDraft(next: Draft) {
    if (!localDraft) {
      setValuesByType(new Map());
      onEdit?.();
    }
    setEdit(next);
  }
  const inspector = !draft.create && draft.mode === 'inspector';
  const token = graph.tokens.get(draft.path);
  const folder = graph.groups.get(draft.create ? draft.path : parentPath(draft.path));
  const inherited = folder?.definitions.get(draft.create ? draft.file : token?.file ?? '')?.type;
  const automatic = token?.referenceType ?? inherited;
  const column = draft.create ? undefined : draft.column;
  const type = inspector ? draft.type || automatic : column === 'value' ? token?.type : draft.type || inherited;
  const files = draft.create ? [...(sourceChoices?.keys() ?? folder?.files.keys() ?? [])] : [];
  const showType = inspector || column === 'type' || (draft.create && !draft.groupOnly);
  const showValue = inspector || column === 'value' || (draft.create && !draft.groupOnly) ||
    column === 'type' && (draft.type || automatic) !== token?.type;
  const showName = inspector || draft.create || column === 'name';
  const showDescription = inspector || draft.create || column === 'description';
  const changed = !inspector || localDraft !== null;

  return <form className="grid min-w-0 gap-3" onSubmit={(event) => { event.preventDefault(); commit(draft); }}>
    {showName && !valueOnly && !(initialDraft.create && initialDraft.name === '$root') && <TextField label={draft.groupOnly ? 'Group name' : 'Token name'}
      data-initial-focus data-primary-editor readOnly={!!token?.inheritedFrom} disabled={busy} value={draft.name}
      onChange={(event) => setDraft({ ...draft, name: event.target.value })} />}
    {draft.create && files.length > 1 && <div className="grid gap-1.5">
      <label className="text-sm font-medium" htmlFor="token-edit-file">Source file</label>
      <NativeSelect id="token-edit-file" className="w-full" value={draft.file} disabled={busy}
        onChange={(event) => setDraft({ ...draft, file: event.target.value })}>
        <NativeSelectOption value="">Select source file</NativeSelectOption>
        {files.map((file) => <NativeSelectOption key={file} value={file}>{sourceChoices?.get(file) ?? file}</NativeSelectOption>)}
      </NativeSelect>
    </div>}
    {showType && !valueOnly && <div className="grid min-w-0 gap-1">
      <TokenTypeField value={draft.type ?? ''} automatic={automatic ? automatic[0]?.toUpperCase() + automatic.slice(1) : 'Automatic'}
        authored={token?.node.$type} disabled={busy} onChange={nextType => {
          const resolvedType = nextType || automatic;
          const previousValues = localDraft ? valuesByType : new Map<string, string>();
          const previousDraft = previousValues.get(resolvedType ?? '');
          let value = previousDraft ?? draft.value;
          if (previousDraft === undefined && canEditType(resolvedType) && resolvedType !== type) {
            try {
              const previous = !draft.create && draft.value === displayInput(token?.type, draft.original) ?
                draft.original : readInput(draft.value, type, draft.original);
              if (validateTokenValue(resolvedType, previous, true)) value = JSON.stringify(defaultValue(resolvedType));
            } catch {
              value = JSON.stringify(defaultValue(resolvedType));
            }
          }
          setDraft({ ...draft, type: nextType, value });
          setValuesByType(new Map(previousValues).set(type ?? '', draft.value));
        }} />
      {!draft.type && automatic && <p className="text-xs text-muted-foreground">{token?.referenceType ? 'From linked token' : 'From group'}</p>}
    </div>}
    {showValue && <ValueField {...{ draft, graph, setDraft, busy, type, referenceFile }} />}
    {showDescription && !valueOnly && <TextField label="Description" data-primary-editor disabled={busy} value={draft.description}
      onChange={(event) => setDraft({ ...draft, description: event.target.value })} />}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="token-editor-actions flex justify-end gap-2">
      <Button type="button" variant="text" disabled={busy || !changed && !valueOnly} onClick={() => { setEdit(null); cancel(); }}>{inspector && !valueOnly ? 'Reset' : 'Cancel'}</Button>
      <Button type="submit" disabled={busy || !changed}>{draft.create || valueOnly ? 'Review changes' : 'Apply to workspace'}</Button>
    </div>
  </form>;
}
