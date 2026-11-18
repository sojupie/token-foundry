import { useState } from 'react';
import { Button, Checkbox, TextField, Select, SelectOption } from '@token-catalog/forge-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ActionDialog } from '@/components/ui/dialog';
import { FieldRow } from '@/components/ui/field-row';
import { errorMessage } from '../lib/json.ts';
import { newResolverDocument } from '../lib/resolver.ts';
import { serializeTokenPointer } from '../lib/token-path.ts';
import type { Workspace } from '../lib/workspace.ts';

export function VariantSetupDialog({ workspace, files, root, reviewing, close, create }: {
  workspace: Workspace;
  files: readonly string[];
  root?: string | undefined;
  reviewing: boolean;
  close: () => void;
  create: (file: string, text: string) => void;
}) {
  const [name, setName] = useState(workspace.name === 'Example' ? '' : workspace.name);
  const [base, setBase] = useState(() => new Set(files));
  const [dimension, setDimension] = useState('');
  const choiceLabels = ['First choice', 'Second choice'];
  const [choices, setChoices] = useState(['', '']);
  const [overrides, setOverrides] = useState(['', '']);
  const [preferred, setPreferred] = useState('');
  const [error, setError] = useState('');

  return <ActionDialog open={!reviewing} title="Set up variants" onOpenChange={open => { if (!open && !reviewing) close(); }}>
    <form className="grid gap-3" onSubmit={event => {
      event.preventDefault();
      setError('');
      try {
        const title = name.trim();
        const stem = title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'resolver';
        const file = (root ? root + '/' : '') + stem + '.resolver.json';
        if (workspace.files.some(source => source.path === file)) throw new Error('A configuration already uses ' + file + '.');
        const link = (target: string) => ({ $ref: serializeTokenPointer(file, target, []).slice(0, -1) });
        const json = newResolverDocument(title);
        const order = [];
        if (base.size) {
          json['sets'] = { foundation: { sources: files.filter(source => base.has(source)).map(link) } };
          order.push({ $ref: '#/sets/foundation' });
        }
        if (dimension.trim()) {
          const axis = dimension.trim();
          const names = choices.map(choice => choice.trim());
          if (names.some(choice => !choice) || new Set(names.map(choice => choice.toLowerCase())).size !== names.length) {
            throw new Error('Give the two choices different names.');
          }
          const defaultChoice = preferred === '' ? undefined : names[Number(preferred)];
          json['modifiers'] = { [axis]: {
            contexts: Object.fromEntries(names.map((choice, index) => [choice, overrides[index] ? [link(overrides[index])] : []])),
            ...(defaultChoice ? { default: defaultChoice } : {}),
          } };
          order.push({ $ref: serializeTokenPointer(file, file, ['modifiers', axis]) });
        }
        json['resolutionOrder'] = order;
        create(file, JSON.stringify(json, null, 2) + '\n');
      } catch (failure) {
        setError(errorMessage(failure));
      }
    }}>
      <TextField label="Configuration name" required data-initial-focus value={name} onChange={event => setName(event.target.value)} />
      <fieldset className="grid gap-1">
        <legend className="copy-body copy-emphasis">Shared source files</legend>
        {files.map(file => <label key={file} className="flex items-center gap-2 copy-body">
          <Checkbox checked={base.has(file)} onChange={event => {
            const next = new Set(base);
            if (event.target.checked) next.add(file);
            else next.delete(file);
            setBase(next);
          }} />{file}
        </label>)}
      </fieldset>
      <TextField label="First variant dimension" placeholder="Appearance" supporting="Optional. You can add more in Manage variants."
        value={dimension} onChange={event => setDimension(event.target.value)} />
      {dimension.trim() && <>
        <FieldRow>{choices.map((choice, index) => <div key={choiceLabels[index]} className="grid gap-2">
          <TextField label={choiceLabels[index] ?? 'Choice'} required value={choice}
            onChange={event => setChoices(choices.with(index, event.target.value))} />
          <label className="grid gap-1 copy-body">{index === 0 ? 'First choice source' : 'Second choice source'}
            <Select aria-label={index === 0 ? 'First choice source' : 'Second choice source'} value={overrides[index]} onChange={event => {
              const file = event.target.value;
              setOverrides(overrides.with(index, file));
              if (file) setBase(previous => { const next = new Set(previous); next.delete(file); return next; });
            }}>
              <SelectOption value="">Use shared values</SelectOption>
              {files.map(file => <SelectOption key={file} value={file}>{file}</SelectOption>)}
            </Select>
          </label>
        </div>)}</FieldRow>
        <label className="grid gap-1 copy-body">Default choice
          <Select aria-label="Default choice" value={preferred} onChange={event => setPreferred(event.target.value)}>
            <SelectOption value="">Ask when previewing</SelectOption>
            {choices.map((choice, index) => <SelectOption key={choiceLabels[index]} value={String(index)}>{choice || (choiceLabels[index] ?? 'Choice')}</SelectOption>)}
          </Select>
        </label>
        <p className="copy-body">The selected choice overrides matching tokens from the shared files.</p>
      </>}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="text" data-dialog-close="">Cancel</Button>
        <Button type="submit" disabled={!name.trim()}>Set up variants</Button>
      </div>
    </form>
  </ActionDialog>;
}
