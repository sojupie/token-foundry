import { useState } from 'react';
import { Button, Card, Select, SelectOption, TextArea, TextField } from '@token-catalog/forge-react';
import { ActionDialog } from './components/ui/dialog.tsx';
import { errorMessage, isJsonObject, parseJson } from '../lib/json.ts';
import type { JsonValue } from '../lib/json.ts';
import { parseTokenFile } from '../lib/parse-token-file.ts';
import type { RepositoryChoice, RepositoryChoiceDraft, RepositoryConflict } from '../lib/repository-merge.ts';
import { repositoryChoiceKey, repositoryChoiceTarget, repositoryDraft } from '../lib/repository-merge.ts';

const display = (value: JsonValue | undefined) => value === undefined ? 'Removed' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

const seedValue = (conflict: RepositoryConflict) => conflict.draft !== undefined ? conflict.draft : conflict.repository !== undefined ? conflict.repository : conflict.before;
function dimensionValue(seed: JsonValue | undefined) {
  return isJsonObject(seed) && typeof seed['value'] === 'number' && typeof seed['unit'] === 'string' ? { source: seed, value: seed['value'], unit: seed['unit'] } : undefined;
}
function readChoice(conflict: RepositoryConflict, draft: RepositoryChoiceDraft): RepositoryChoice {
  if (draft.keep !== 'custom') return { id: conflict.id, keep: draft.keep };
  const seed = seedValue(conflict); const dimension = dimensionValue(seed);
  let value: JsonValue;
  if (conflict.kind === 'file' || typeof seed === 'string') value = draft.text;
  else if (dimension || typeof seed === 'number') {
    if (!draft.text.trim() || !Number.isFinite(Number(draft.text))) throw new Error('Enter a finite number.');
    value = dimension ? { ...dimension.source, value: Number(draft.text) } : Number(draft.text);
  } else {
    value = parseJson(draft.text); parseTokenFile('{"definition":' + draft.text + '}', 'custom definition');
  }
  return { id: conflict.id, keep: 'custom', value };
}
function checkedChoice(conflict: RepositoryConflict, draft: RepositoryChoiceDraft): { choice: RepositoryChoice; error: string } {
  try { return { choice: readChoice(conflict, draft), error: '' }; }
  catch (cause) { return { choice: { id: conflict.id, keep: 'custom' }, error: errorMessage(cause) }; }
}
function DefinitionChoice({ conflict, initial, saveDraft, remoteLabel, busy }: { remoteLabel: string; conflict: RepositoryConflict; initial: RepositoryChoiceDraft | undefined; saveDraft: (choice: RepositoryChoiceDraft) => void; busy: boolean }) {
  const [keep, setKeep] = useState(initial?.keep ?? '');
  const seed = seedValue(conflict); const dimension = dimensionValue(seed);
  const [custom, setCustom] = useState(initial?.text ?? (dimension ? String(dimension.value) : display(seed)));
  const [error, setError] = useState(initial ? checkedChoice(conflict, initial).error : '');
  function update(kind: string, text = custom) {
    setKeep(kind); setCustom(text); setError('');
    if (kind !== 'draft' && kind !== 'repository' && kind !== 'custom') return;
    const draft: RepositoryChoiceDraft = { id: conflict.id, keep: kind, text };
    saveDraft(draft);
    const checked = checkedChoice(conflict, draft); setError(checked.error);
  }
  const definitions: readonly (readonly [string, JsonValue | undefined])[] = [['Before', conflict.before], ['Your draft', conflict.draft], [remoteLabel, conflict.repository]];
  return <Card variant="outlined" as="section" headline={`${conflict.file}${conflict.parts.length ? ' · ' + conflict.parts.join('.') : ''}`} headlineAs="h3"
    aria-label={remoteLabel + ' conflict in ' + conflict.file + ' ' + conflict.parts.join('.')}>
    {initial && initial.id !== conflict.id && <p className="copy-small tone-supporting">{/:[a-f0-9]{64}$/u.test(initial.id) ? 'Source values changed. Choose again after reviewing the current definitions.' : 'Saved input kept. Choose again after reviewing the current definitions.'}</p>}
    <div className="grid min-w-0 gap-space150 sm:grid-cols-3">{definitions.map(([label, value]) => <div className="min-w-0" key={label}><p className="copy-small copy-emphasis tone-supporting">{label}</p><pre className="scroll-list-xl overflow-auto whitespace-pre-wrap wrap-anywhere copy-small">{display(value)}</pre></div>)}</div>
    <Select label="Resolution" disabled={busy} aria-label={'Keep definition for ' + conflict.file + ' ' + conflict.parts.join('.')} value={initial && initial.id !== conflict.id ? '' : keep} onChange={event => update(event.target.value)}>
      <SelectOption value="" disabled>Choose a definition</SelectOption><SelectOption value="draft">Keep your draft</SelectOption>
      <SelectOption value="repository">Use {remoteLabel.toLowerCase()} definition</SelectOption><SelectOption value="custom">Enter another definition</SelectOption>
    </Select>
    {keep === 'custom' && (conflict.kind === 'file' || !dimension && typeof seed !== 'number' && typeof seed !== 'string'
      ? <TextArea disabled={busy} label={conflict.kind === 'file' ? 'Merged source file' : 'Definition (JSON)'} value={custom} rows={6} invalid={!!error} supporting={error} onChange={event => update('custom', event.target.value)} />
      : <TextField disabled={busy} label={dimension ? 'Value (' + dimension.unit + ')' : 'New value'} value={custom} invalid={!!error} supporting={error} onChange={event => update('custom', event.target.value)} />)}
  </Card>;
}

export function RepositoryConflictReview({ conflicts, drafts, saveDraft, discardDraft, resumeInput, busy = false, error, close, apply, title = 'Reconcile repository changes', remoteLabel = 'Repository' }: {
  title?: string; remoteLabel?: string;
  conflicts: readonly RepositoryConflict[]; drafts: readonly RepositoryChoiceDraft[]; saveDraft: (draft: RepositoryChoiceDraft) => void;
  discardDraft: (draft: RepositoryChoiceDraft) => void;
  resumeInput?: (draft: RepositoryChoiceDraft) => (() => void) | undefined;
  busy?: boolean;
  error: string; close: () => void; apply: (choices: RepositoryChoice[]) => void;
}) {
  const choices = new Map(conflicts.flatMap(conflict => {
    const draft = repositoryDraft(conflict, drafts);
    return draft?.id === conflict.id ? [[conflict.id, checkedChoice(conflict, draft).choice] as const] : [];
  }));
  const earlier = drafts.filter(draft => !conflicts.some(conflict => repositoryChoiceKey(conflict.id) === repositoryChoiceKey(draft.id)));
  return <ActionDialog open busy={busy} onOpenChange={open => { if (!open && !busy) close(); }} title={title}
    description="Non-conflicting changes merge automatically. Resolve conflicts below, then review the result before saving.">
    <div className="grid min-w-0 gap-space200">{conflicts.map(conflict => <DefinitionChoice busy={busy} remoteLabel={remoteLabel} key={conflict.id} conflict={conflict} initial={repositoryDraft(conflict, drafts)} saveDraft={saveDraft} />)}
      {!!earlier.length && <Card variant="outlined" as="section" headline="Earlier input" headlineAs="h3" supporting="These definitions no longer conflict. Resume or discard saved input." aria-label="Earlier conflict input">
        {earlier.map(draft => {
          const target = repositoryChoiceTarget(draft.id); const resume = resumeInput?.(draft);
          return <div key={draft.id} className="grid gap-space100"><p className="copy-small">{target ? target.file + ' · ' + target.parts.join('.') : 'Saved input'} · {draft.keep === 'custom' ? 'Custom value' : draft.keep === 'draft' ? 'Keep your draft' : 'Use ' + remoteLabel.toLowerCase() + ' definition'}</p>{draft.keep === 'custom' && <pre className="scroll-list-xl overflow-auto whitespace-pre-wrap copy-small">{draft.text}</pre>}<div className="flex flex-wrap gap-space100">{resume && <Button variant="outlined" disabled={busy} onClick={resume}>Resume token edit</Button>}<Button variant="text" disabled={busy} onClick={() => discardDraft(draft)}>Discard earlier input</Button></div></div>;
        })}
      </Card>}
      {error && <p role="alert" className="copy-body tone-error">{error}</p>}
      <div className="flex flex-wrap justify-end gap-space100"><Button variant="text" disabled={busy} onClick={close}>Cancel reconciliation</Button>
        <Button disabled={busy || !!earlier.length || conflicts.some(conflict => !choices.has(conflict.id) || choices.get(conflict.id)?.keep === 'custom' && choices.get(conflict.id)?.value === undefined)} onClick={() => apply([...choices.values()])}>{busy ? 'Applying choices…' : 'Review merged changes'}</Button></div>
    </div>
  </ActionDialog>;
}
