import type { ReactNode } from 'react';
import { lazy, Suspense, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2 } from './icons.tsx';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, IconButton, TextField, Select, SelectOption } from '@token-catalog/forge-react';
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
import { FieldBoundary } from './field-boundary.tsx';

const TypedEditorPanel = lazy(() => import('./typed-value.tsx'));

interface Props {
  initialDraft: Draft;
  graph: DocumentGraph;
  onEdit?: () => void;
  onDraftChange?: (draft: Draft) => void;
  inspectorActive?: boolean;
  footer?: HTMLDivElement | null | undefined;
  valueOnly?: boolean;
  definition?: boolean;
  referenceFile?: string;
  sourceChoices?: ReadonlyMap<string, string>;
  commit: (draft: Draft) => boolean;
  cancel: () => void;
  error: string;
  busy: boolean;
}

function focusType(select: HTMLInputElement | null) {
  select?.focus({ preventScroll: true });
}

function RawValueForm({ id, initialType, draft, authored, apply, close, graph, file }: {
  graph: DocumentGraph;
  file: string;
  id: string;
  initialType: string | undefined;
  draft: Draft;
  authored: string | undefined;
  apply: (draft: Draft) => boolean | void;
  close: () => void;
}) {
  const [type, setType] = useState(initialType ?? '');
  const [literal, setLiteral] = useState<JsonValue>();
  const [text, setText] = useState('');
  const [showJson, setShowJson] = useState(false);
  const valueHeading = useId();
  const typed = canEditType(type);
  const value = literal ?? (typed ? defaultValue(type) : undefined);
  const edit = { graph, file, source: draft.create ? '' : draft.path, busy: false };
  const [error, setError] = useState('');
  return <form id={id} className="grid self-start gap-space200" onSubmit={event => {
    event.preventDefault();
    event.stopPropagation();
    setError('');
    try {
      const next = showJson || !typed ? readInput(text, type, draft.original) : value;
      if (referenceLabel(next)) throw new Error('Enter a raw value or switch back to Find a reference.');
      validateInputValue(type, next);
      if (apply({ ...draft, type, value: JSON.stringify(next) ?? '' }) !== false) close();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }}>
    <TokenTypeField value={type} {...{ authored }} onChange={next => {
      setType(next); setLiteral(undefined); setText(''); setShowJson(false); setError('');
    }} selectRef={focusType} required />
    <section aria-labelledby={valueHeading} className="token-editor-section grid min-w-0 gap-space150">
      <header className="flex flex-wrap items-center justify-between gap-space50">
        <h3 id={valueHeading} className="token-editor-section-title">Value</h3>
        {typed && <Button type="button" size="xsmall" variant={showJson ? 'tonal' : 'text'} pressed={showJson} onClick={() => {
          if (!showJson) { setText(JSON.stringify(value, null, 2)); setShowJson(true); }
          else {
            try { setLiteral(parseJson(text)); setShowJson(false); setError(''); }
            catch (failure) { setError(errorMessage(failure)); }
          }
        }}>{showJson ? 'Use fields' : 'Raw JSON'}</Button>}
      </header>
      {typed && !showJson ? <FieldBoundary key={type}><Suspense fallback={<p className="copy-small">Loading value editor…</p>}>
        <TypedEditorPanel key={type} {...{ edit, type, value }} resolved={undefined} original={false} write={setLiteral} />
      </Suspense></FieldBoundary> : <ValueInput value={text} setValue={setText} format={showJson ? 'json' : inputFormat(type)} required />}
    </section>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </form>;
}

export function TokenReferenceDialog({ draft, graph, type, seed, choose, applyRawValue, close, error, referenceFile, initialRaw }: Pick<Props, 'graph'> & {
  draft: Draft;
  type: string | undefined;
  seed: string;
  initialRaw?: boolean;
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
    initialRaw={initialRaw ?? false} error={error ?? ''} renderRawForm={(id, closeRaw) => <RawValueForm {...{ id, draft }}
      initialType={type} authored={graph.tokens.get(draft.path)?.node.$type}
      graph={graph} file={referenceFile ?? (draft.create ? draft.file : graph.tokens.get(draft.path)?.file ?? '')}
      apply={applyRawValue} close={closeRaw} />} />;
}

function ValueInput({ value, setValue, format, resolved, busy, required, trailing }: {
  value: string;
  setValue: (value: string) => void;
  format: ReturnType<typeof inputFormat>;
  resolved?: ReturnType<DocumentGraph['resolved']['get']>;
  busy?: boolean;
  required?: boolean;
  trailing?: ReactNode;
}) {
  const color = /^#[0-9a-f]{6}$/iu.test(value) ? value :
    isColor(resolved) && resolved.colorSpace === 'srgb' ? colorHex(resolved) : '#000000';
  const input = { 'data-primary-editor': '', spellCheck: false, disabled: busy, required };
  if (format === 'json') return <Textarea {...input} aria-label="Token value" rows={4}
    className="min-w-0 resize-y code-editor" value={value} onChange={event => setValue(event.target.value)} />;
  return <TextField {...input} label="Token value" value={value} onChange={event => setValue(event.target.value)}
    trailing={trailing ?? (format === 'hex' ? <input type="color" aria-label="Pick color" value={color} disabled={busy}
      className="workspace-color-picker" onChange={event => setValue(event.target.value)} /> : undefined)} />;
}

function ValueField({ draft, graph, setDraft, busy, type, referenceFile }: Pick<Props, 'graph' | 'busy'> & {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  referenceFile?: string | undefined;
  type: string | undefined;
}) {
  const inspector = !draft.create && draft.mode === 'inspector';
  const linkButton = useRef<HTMLButtonElement>(null);
  const restoreLinkFocus = useRef(false);
  const valueHeading = useId();
  const [referenceSeed, setReferenceSeed] = useState<string | null>(null);
  const [enterLiteral, setEnterLiteral] = useState(false);
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
  const linked = !!referenceLabel(value);
  function openLink() {
    restoreLinkFocus.current = true;
    setEnterLiteral(false);
    setReferenceSeed('');
  }
  function closeLink() {
    setReferenceSeed(null);
    if (restoreLinkFocus.current) {
      restoreLinkFocus.current = false;
      requestAnimationFrame(() => linkButton.current?.focus({ preventScroll: true }));
    }
  }
  const inlineLink = inspector && linked && !raw && format !== 'json';
  const typed = knownType && !referenceLabel(draft.original) && !referenceLabel(value) && !parseError;
  const panel = !raw && typed ? <FieldBoundary key={type}><Suspense fallback={<p className="copy-small tone-supporting">Loading value editor…</p>}>
    <TypedEditorPanel key={type + ':' + JSON.stringify(draft.original)} {...{ edit, type, resolved }} value={authored}
      original={valueIsOriginal} write={next => setDraft({ ...draft, value: next === undefined ? '' : JSON.stringify(next) })} />
  </Suspense></FieldBoundary> :
    <ValueInput value={draft.value} {...{ format, busy, resolved }}
      trailing={inlineLink ? <IconButton ref={linkButton} size="xsmall" label="Link token" aria-haspopup="dialog" disabled={busy} onClick={openLink}>
        <Link2 aria-hidden="true" />
      </IconButton> : undefined} setValue={next => {
      setDraft({ ...draft, value: next });
      if (draft.create && format !== 'json' && next.startsWith('{')) setReferenceSeed(next.slice(1).replace(/\}$/u, ''));
    }} />;

  return <section aria-labelledby={valueHeading} className={'grid min-w-0 gap-space150' + (inspector ? ' token-editor-section' : '')}>
    <header className="grid min-w-0 gap-space50">
      <h3 id={valueHeading} className="token-editor-section-title">Value</h3>
      <div className="flex flex-wrap items-center gap-space50">
        {referenceLabel(value) && <Button type="button" size="xsmall" variant="text" disabled={busy} onClick={() => {
          setEnterLiteral(true); setReferenceSeed('');
        }}>Enter a value</Button>}
        <Button type="button" size="xsmall" variant={raw ? 'tonal' : 'text'} pressed={raw} disabled={busy}
          onClick={() => { setRaw(!raw); if (!raw) setRawEdit(undefined); }}>{raw ? 'Use fields' : 'Raw JSON'}</Button>
        {!inlineLink && <Button ref={linkButton} type="button" size="xsmall" variant="text" disabled={busy} aria-haspopup="dialog" onClick={openLink}>
          <Link2 aria-hidden="true" /> Link token
        </Button>}
      </div>
    </header>
    {raw ? <div className="grid gap-space50">
      <Textarea data-primary-editor aria-label="Token value JSON" aria-invalid={!!jsonIssue || !!issues.length}
        rows={7} spellCheck={false} className="min-w-0 resize-y code-editor" disabled={busy} value={json}
        ref={input => input?.setCustomValidity(jsonIssue)}
        onChange={event => {
          const text = event.target.value;
          setRawEdit({ text, value: text });
          setDraft({ ...draft, value: text });
        }} />
      {jsonIssue && <p className="copy-small tone-error" role="alert">{jsonIssue}</p>}
      {!!issues.length && <ul className="grid gap-space50 copy-small tone-error" aria-label="Value diagnostics">
        {issues.map(problem => <li key={problem}>{problem}</li>)}
      </ul>}
    </div> : panel}
    {referenceSeed !== null && <TokenReferenceDialog {...{ draft, graph, type, referenceFile }} seed={referenceSeed} initialRaw={enterLiteral}
      choose={next => setDraft({ ...draft, value: next })}
      applyRawValue={setDraft} close={closeLink} />}
    {inspector && valueIsOriginal && linked && <div className="token-editor-support flex min-w-0 items-center gap-space100">
      <span>Resolved</span><TokenValue value={resolved} swatch wrap />
    </div>}
  </section>;
}

function TokenTypeField({ value, automatic, authored, onChange, disabled, selectRef, required }: {
  value: string;
  automatic?: string | undefined;
  authored?: string | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  selectRef?: (select: HTMLInputElement | null) => void;
}) {
  const id = useId();
  const types = [...new Set([...dtcgTypes, ...[authored, value].filter(Boolean)])];
  return <div className="grid min-w-0 gap-space75">
    <label className="token-editor-label" htmlFor={id}>Token type</label>
    <Select ref={selectRef} id={id} data-primary-editor className="w-full" disabled={disabled} required={required} value={value}
      onChange={(event) => onChange(event.target.value)}>
      <SelectOption value="" disabled={automatic === undefined}>{automatic ?? 'Choose a type'}</SelectOption>
      {types.map((option) => <SelectOption key={option} value={option}>
        {option}{!dtcgTypes.some((known) => known === option) ? ' (document type)' : ''}
      </SelectOption>)}
    </Select>
  </div>;
}

export function TokenEditForm({ initialDraft, graph, onEdit, onDraftChange, inspectorActive, footer, valueOnly, definition, sourceChoices, referenceFile, commit, cancel, error, busy }: Props) {
  const [edit, setEdit] = useState<Draft | null>(() => inspectorActive ? initialDraft : null);
  const [valuesByType, setValuesByType] = useState(() => new Map<string, string>());
  const localDraft = inspectorActive === false ? null : edit;
  const draft = localDraft ?? initialDraft;
  function setDraft(next: Draft) {
    if (!localDraft) {
      setValuesByType(new Map());
      onEdit?.();
    }
    setEdit(next);
    onDraftChange?.(next);
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

  const formId = useId();
  const actions = <div className="flex justify-end gap-space100">
      <Button type="button" variant="text" disabled={busy || !changed && !valueOnly} onClick={() => { setEdit(null); cancel(); }}>{inspector && !valueOnly ? 'Reset' : 'Cancel'}</Button>
      <Button type="submit" form={formId} disabled={busy || !changed}>{draft.create || valueOnly || definition ? 'Review changes' : 'Apply to workspace'}</Button>
    </div>;

  return <form id={formId} className="grid min-w-0 gap-space150" onSubmit={(event) => { event.preventDefault(); commit(draft); }}>
    {showName && !valueOnly && !definition && !(initialDraft.create && initialDraft.name === '$root') && <TextField label={draft.groupOnly ? 'Group name' : 'Token name'}
      data-initial-focus data-primary-editor readOnly={!!token?.inheritedFrom} disabled={busy} value={draft.name}
      onChange={(event) => setDraft({ ...draft, name: event.target.value })} />}
    {draft.create && files.length > 1 && <div className="grid gap-space75">
      <label className="copy-body copy-emphasis" htmlFor="token-edit-file">Source file</label>
      <Select id="token-edit-file" className="w-full" value={draft.file} disabled={busy}
        onChange={(event) => setDraft({ ...draft, file: event.target.value })}>
        <SelectOption value="">Select source file</SelectOption>
        {files.map((file) => <SelectOption key={file} value={file}>{sourceChoices?.get(file) ?? file}</SelectOption>)}
      </Select>
    </div>}
    {showType && !valueOnly && <div className="grid min-w-0 gap-space50">
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
      {!draft.type && automatic && <div className="token-editor-support">{token?.referenceType ? 'From linked token' : 'From group'}</div>}
    </div>}
    {showValue && <ValueField {...{ draft, graph, setDraft, busy, type, referenceFile }} />}
    {showDescription && !valueOnly && <TextField label={inspector ? 'Token description' : 'Description'}
      data-primary-editor disabled={busy} value={draft.description}
      onChange={(event) => setDraft({ ...draft, description: event.target.value })} />}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {footer ? createPortal(actions, footer) : actions}
  </form>;
}
