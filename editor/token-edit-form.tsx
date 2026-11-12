import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, TextField } from '@token-catalog/forge-react';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { colorHex } from '../lib/color.ts';
import { parentPath, referenceLabel } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { dtcgTypes, isColor } from '../lib/token-types.ts';
import type { Draft } from './lib/draft.ts';
import { displayInput, inputFormat } from './lib/token-input.ts';
import { ReferencePicker } from './reference-picker.tsx';

interface Props {
  draft: Draft;
  graph: DocumentGraph;
  setDraft: (draft: Draft) => void;
  commit: () => void;
  cancel: () => void;
  error: string;
  busy: boolean;
}

function ValueField({ draft, graph, setDraft, busy, type, commit }: Pick<Props, 'draft' | 'graph' | 'setDraft' | 'busy' | 'commit'> & {
  type: string | undefined;
}) {
  const originalReference = referenceLabel(draft.original);
  const startLinked = !draft.create && draft.mode === 'link';
  const [referenceSeed, setReferenceSeed] = useState<string | null>(() => {
    if (!startLinked && !originalReference) return null;
    return startLinked && !originalReference && draft.value.startsWith('{') ? draft.value.slice(1).replace(/\}$/u, '') : '';
  });
  const linking = referenceSeed !== null;
  const format = inputFormat(type, draft.create ? undefined : draft.original);
  const resolved = graph.resolved.get(draft.path);
  const color = /^#[0-9a-f]{6}$/iu.test(draft.value) ? draft.value :
    isColor(resolved) && resolved.colorSpace === 'srgb' ? colorHex(resolved) : '#000000';
  const alias = /^\{([^{}]+)\}$/u.exec(draft.value)?.[1];
  const pointerTarget = originalReference && !originalReference.startsWith('{') && draft.value === displayInput(type, draft.original) ?
    [...(graph.dependencies.get(draft.path) ?? [])][0] : undefined;
  const target = alias ?? pointerTarget;
  const flexible = draft.create || draft.column === 'type' ? !draft.type : !graph.tokens.get(draft.path)?.node.$type;
  const input = {
    'data-primary-editor': '', spellCheck: false, disabled: busy,
    value: draft.value,
  };

  return <div className="grid min-w-0 gap-2">
    <div className="flex flex-wrap items-center justify-between gap-1">
      <span className="text-xs font-medium">{linking ? 'Reference' : 'Value'}</span>
      <Button type="button" size="xsmall" variant="text" disabled={busy} aria-pressed={linking}
        onClick={() => setReferenceSeed(linking ? null : '')}>
        <Link2 aria-hidden="true" /> {linking ? 'Edit raw value' : 'Link token'}
      </Button>
    </div>
    {linking ? <>
      <ReferencePicker graph={graph} source={draft.create ? '' : draft.path} type={type} seed={referenceSeed} target={target} flexible={flexible} apply={commit}
        choose={(path) => setDraft({ ...draft, value: '{' + path + '}' })} />
      <p className="min-w-0 wrap-anywhere font-mono text-xs text-primary" aria-live="polite">
        {alias || (originalReference && target ? originalReference : 'Choose a token to link')}
      </p>
    </> : <div className="flex min-w-0 gap-2">
      {format === 'hex' && <input type="color" aria-label="Pick color" value={color} disabled={busy}
        className="workspace-color-picker" onChange={(event) => setDraft({ ...draft, value: event.target.value })} />}
      {format === 'json' ? <Textarea {...input} aria-label="Token value" rows={3} className="min-w-0 resize-y font-mono text-xs"
        onChange={(event) => setDraft({ ...draft, value: event.target.value })} /> :
        <TextField {...input} label="Token value" containerClassName="min-w-0 flex-1" onChange={(event) => {
          const value = event.target.value;
          setDraft({ ...draft, value });
          if (value.startsWith('{')) setReferenceSeed(value.slice(1).replace(/\}$/u, ''));
        }} />}
    </div>}
  </div>;
}

export function TokenEditForm({ draft, graph, setDraft, commit, cancel, error, busy }: Props) {
  const token = graph.tokens.get(draft.path);
  const folder = graph.groups.get(draft.create ? draft.path : parentPath(draft.path));
  const inherited = folder?.files.get(draft.create ? draft.file : token?.file ?? '');
  const automatic = token?.referenceType ?? inherited;
  const column = draft.create ? undefined : draft.column;
  const type = column === 'value' ? token?.type : draft.type || inherited;
  const files = draft.create ? [...(folder?.files.keys() ?? [])] : [];
  const showType = column === 'type' || (draft.create && !draft.groupOnly);
  const showValue = column === 'value' || (draft.create && !draft.groupOnly) ||
    column === 'type' && (draft.type || automatic) !== token?.type;
  const showName = draft.create || column === 'name';
  const showDescription = draft.create || column === 'description';
  const authored = token?.node.$type;
  const typeOptions = [...new Set([...dtcgTypes, ...(authored ? [authored] : [])])];

  return <form className="grid min-w-0 gap-3" onSubmit={(event) => { event.preventDefault(); commit(); }}>
    {showName && <TextField label={draft.groupOnly ? 'Group name' : 'Token name'}
      data-initial-focus data-primary-editor disabled={busy} value={draft.name}
      onChange={(event) => setDraft({ ...draft, name: event.target.value })} />}
    {draft.create && files.length > 1 && <div className="grid gap-1.5">
      <label className="text-sm font-medium" htmlFor="token-edit-file">Source file</label>
      <NativeSelect id="token-edit-file" className="w-full" value={draft.file} disabled={busy}
        onChange={(event) => setDraft({ ...draft, file: event.target.value })}>
        <NativeSelectOption value="">Select source file</NativeSelectOption>
        {files.map((file) => <NativeSelectOption key={file} value={file}>{file}</NativeSelectOption>)}
      </NativeSelect>
    </div>}
    {showType && <div className="grid gap-1.5">
      <label className="text-sm font-medium" htmlFor="token-edit-type">Token type</label>
      <NativeSelect id="token-edit-type" data-primary-editor className="w-full" disabled={busy} value={draft.type ?? ''}
        onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
        <NativeSelectOption value="">{automatic ? 'Automatic (' + automatic + ')' : 'Automatic'}</NativeSelectOption>
        {typeOptions.map((option) => <NativeSelectOption key={option} value={option}>
          {option}{option === authored && !dtcgTypes.some((known) => known === option) ? ' (document type)' : ''}
        </NativeSelectOption>)}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">Automatic uses the linked token’s type or the closest group type.</p>
    </div>}
    {showValue && <ValueField {...{ draft, graph, setDraft, busy, type, commit }} />}
    {showDescription && <TextField label="Description" data-primary-editor disabled={busy} value={draft.description}
      onChange={(event) => setDraft({ ...draft, description: event.target.value })} />}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="text" disabled={busy} onClick={cancel}>Cancel</Button>
      <Button type="submit" disabled={busy}>{draft.create ? 'Review changes' : 'Apply'}</Button>
    </div>
  </form>;
}
