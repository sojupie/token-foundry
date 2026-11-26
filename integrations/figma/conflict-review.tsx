import { useState } from 'react';
import { Button, Card, Select, SelectOption, TextField } from '@token-catalog/forge-react';
import type { VariableRow } from './contract.ts';
import { sameLocalValue, sameSourceValue } from './contract.ts';
import type { LocalValue, PullChoice, PullConflict } from './merge.ts';
import type { ConflictDraft } from './recovery.ts';
import { conflictInputKind, unmatchedConflictDrafts } from './recovery.ts';
import './conflict-review.css';
import { easingPoints, isCubicEasing, parseEasingInput } from './easing.ts';
import { EasingField } from './easing-field.tsx';

export const displayValue = (value: unknown): string => isCubicEasing(value) ? JSON.stringify(easingPoints(value)) : typeof value === 'string' ? value : JSON.stringify(value) ?? '';
const withUnit = (value: unknown, unit?: string) => displayValue(value) + (typeof value === 'number' && unit ? ' ' + unit : '');

export function parseVariableValue(row: VariableRow, text: string): LocalValue {
  if (row.type === 'EASING') return parseEasingInput(text);
  if (row.type === 'FLOAT' || row.type === 'TIMING') {
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value)) throw new Error('Enter a finite number for ' + row.path + '.');
    if (row.type === 'TIMING' && value < 0) throw new Error('Duration cannot be negative for ' + row.path + '.');
    return value;
  }
  if (row.type === 'BOOLEAN') {
    if (!['true', 'false'].includes(text)) throw new Error('Choose true or false for ' + row.path + '.');
    return text === 'true';
  }
  if (row.type === 'COLOR') {
    if (!/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/iu.test(text)) throw new Error('Enter a color as #RRGGBB or #RRGGBBAA.');
    const channel = (offset: number) => Number.parseInt(text.slice(offset, offset + 2), 16) / 255;
    return { r: channel(1), g: channel(3), b: channel(5), a: text.length === 7 ? 1 : channel(7) };
  }
  return text;
}

export function ConflictReview({ conflicts, rows, busy, apply, cancel, drafts, onDraftsChange, resumeInput, submitted = false, native, updated = false }: {
  conflicts: readonly PullConflict[]; rows: readonly VariableRow[]; busy: boolean;
  apply: (choices: PullChoice[]) => void; cancel: () => void;
  drafts?: readonly ConflictDraft[]; onDraftsChange?: (drafts: ConflictDraft[]) => void;
  resumeInput?: (draft: ConflictDraft) => (() => void) | undefined;
  submitted?: boolean; native?: { values: ReadonlyMap<string, LocalValue>; rows: readonly VariableRow[] };
  updated?: boolean;
}) {
  const [localDrafts, setLocalDrafts] = useState<ConflictDraft[]>([]);
  const current = drafts ?? localDrafts;
  const retained = unmatchedConflictDrafts(conflicts, current);
  const choices = new Map(current.filter(draft => conflicts.some(conflict => conflict.path === draft.path && sameSourceValue(draft.review, conflict))).map(item => [item.path, item.keep]));
  const retainedChoices = new Map(current.map(item => [item.path, item.keep]));
  const custom = new Map(current.map(item => [item.path, item.text]));
  function update(path: string, patch: { keep?: string; text?: string; inputKind?: 'value' | 'alias' }) {
    const previous = current.find(item => item.path === path) ?? { path, keep: '', text: '' };
    const review = conflicts.find(item => item.path === path);
    const inputKind = patch.keep === 'custom' ? 'value' : patch.keep === 'alias' ? 'alias' : patch.inputKind ?? conflictInputKind(previous);
    const next = [...current.filter(item => item.path !== path), { ...previous, ...patch, ...(inputKind ? { inputKind } : {}), ...(review ? { review } : {}) }];
    if (onDraftsChange) onDraftsChange(next); else setLocalDrafts(next);
  }
  function discard(path: string) {
    const next = current.filter(item => item.path !== path);
    if (onDraftsChange) onDraftsChange(next); else setLocalDrafts(next);
  }
  const [error, setError] = useState('');
  const byPath = new Map(rows.map(row => [row.path, row]));
  const nativeRows = new Map(native?.rows.map(row => [row.path, row]));
  const laterEdits = submitted && native && conflicts.some(item => native.values.has(item.path) && !sameLocalValue(native.values.get(item.path), item.local));
  return <section aria-label="Conflicting changes" className="conflict-review">
    <div className="conflict-review-header">
      <h2 className="copy-emphasis copy-body">Choose which values to keep</h2>
      <p className="copy-body tone-supporting">Review each conflict. All choices apply together.</p>
    </div>
    {laterEdits && <p className="copy-body tone-supporting">Later Figma edits stay queued and are checked after this review.</p>}
    {updated && <output className="copy-body tone-supporting">Source values changed. Review the current values before applying choices.</output>}
    <ul>{conflicts.map(item => {
      const row = byPath.get(item.path);
      return <li key={item.path}>
        <Card variant="outlined" headline={item.path} headlineAs="h3">
          <dl className="copy-small"><dt>Before</dt><dd>{withUnit(item.before, item.beforeUnit)}</dd>
            <dt>{submitted ? 'Submitted Figma' : 'Figma'}</dt><dd>{withUnit(item.local, item.beforeUnit)}</dd><dt>Foundry</dt><dd>{item.remote === null ? 'Removed from source' : withUnit(item.remote, item.remoteUnit)}</dd>
            {submitted && native && (!native.values.has(item.path) || !sameLocalValue(native.values.get(item.path), item.local)) && <><dt>Current Figma</dt><dd>{native.values.has(item.path) ? withUnit(native.values.get(item.path), nativeRows.get(item.path)?.unit) : 'Value unavailable'}</dd></>}</dl>
          {retainedChoices.get(item.path) && !choices.get(item.path) && <p className="copy-small tone-supporting">Saved input kept. Choose an option after reviewing the current values.</p>}
          <Select label="Resolution" aria-label={'Keep value for ' + item.path} value={choices.get(item.path) ?? ''} disabled={busy}
            onChange={event => update(item.path, { keep: event.target.value })}>
            <SelectOption value="">Choose a value…</SelectOption><SelectOption value="source">Use Foundry value</SelectOption>
            {row?.editable && <SelectOption value="figma">{submitted ? 'Keep submitted Figma value' : 'Keep Figma value'}</SelectOption>}
            {row?.editable && <SelectOption value="custom">Enter another value</SelectOption>}
            {row?.editable && <SelectOption value="alias">Reference another token</SelectOption>}
          </Select>
          {retainedChoices.get(item.path) === 'custom' && row?.type === 'EASING' ? <EasingField value={custom.get(item.path) ?? ''} source={row.value} disabled={busy} onChange={text => update(item.path, { text })} /> : ['custom', 'alias'].includes(retainedChoices.get(item.path) ?? '') && row && <TextField
            label={retainedChoices.get(item.path) === 'alias' ? 'Target token path' : row.type === 'COLOR' ? 'Color (#RRGGBBAA)' : 'Value' + (row.unit ? ' (' + row.unit + ')' : '')}
            disabled={busy} value={custom.get(item.path) ?? ''} onChange={event => update(item.path, { text: event.target.value })} />}
        </Card>
      </li>;
    })}</ul>
    {!!retained.length && <section aria-label="Earlier conflict input" className="conflict-review-earlier">
      <h3 className="copy-emphasis copy-body">Earlier input</h3>
      <p className="copy-small tone-supporting">These tokens no longer conflict. Resume or discard saved draft input.</p>
      <ul>{retained.map(draft => { const resume = resumeInput?.(draft); return <li key={draft.path}>
        <Card variant="outlined" headline={draft.path} headlineAs="h4"
          supporting={({ source: 'Use Foundry value', figma: submitted ? 'Keep submitted Figma value' : 'Keep Figma value', custom: 'Enter another value', alias: 'Reference another token' })[draft.keep]}
          actions={<>
            {resume && <Button variant="outlined" data-snackbar-avoid="" disabled={busy} onClick={resume}>Resume token edit</Button>}
            <Button variant="text" data-snackbar-avoid="" disabled={busy} onClick={() => discard(draft.path)}>Discard earlier input</Button>
          </>}>
          {draft.text && <div className="conflict-review-input" data-snackbar-avoid=""><TextField label={conflictInputKind(draft) === 'alias' ? 'Reference' : 'Earlier input'} aria-label={'Earlier input for ' + draft.path} value={draft.text} readOnly /></div>}
          {!!draft.text && !conflictInputKind(draft) && <Select label="Input type" aria-label={'Input type for ' + draft.path} value="" disabled={busy} onChange={event => { const inputKind = event.target.value; if (inputKind === 'value' || inputKind === 'alias') update(draft.path, { inputKind }); }}><SelectOption value="">Choose input type…</SelectOption><SelectOption value="value">Value</SelectOption><SelectOption value="alias">Reference</SelectOption></Select>}
        </Card>
      </li>; })}</ul>
    </section>}
    {error && <p role="alert" className="copy-body tone-error">{error}</p>}
    <div className="actions" data-snackbar-avoid=""><Button disabled={busy || !!retained.length || conflicts.some(item => !choices.get(item.path))} onClick={() => {
      try {
        const next = conflicts.map(item => {
          const choice = choices.get(item.path);
          const row = byPath.get(item.path);
          if (!choice) throw new Error('Choose a value for ' + item.path + '.');
          const text = custom.get(item.path) ?? '';
          if (choice === 'alias' && !text.trim()) throw new Error('Enter a target token path.');
          return { path: item.path, value: choice === 'source' ? item.remote : choice === 'figma' ? item.local : choice === 'alias' ? { alias: text.trim() } : row ? parseVariableValue(row, text) : null };
        });
        setError(''); apply(next);
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }}>Apply choices</Button><Button variant="text" disabled={busy} onClick={cancel}>Cancel review</Button></div>
  </section>;
}
