import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import { changeDocument, inspectDocuments, leafName, parentPath } from '../lib/document.ts';
import { errorMessage, isJsonObject, parseJson } from '../lib/json.ts';
import { canEditType } from './lib/value-shape.ts';
import type { Draft } from './lib/draft.ts';
import { displayInput, readInput, validateInputValue } from './lib/token-input.ts';
import { TokenEditForm } from './token-edit-form.tsx';

export function InlineSourceEditor({ text, file, write }: {
  text: string; file: string; write: (text: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const parsed = useMemo(() => {
    try {
      const tree = parseJson(text);
      return isJsonObject(tree) ? { tree, graph: inspectDocuments([{ path: file, tree }]) } : null;
    } catch { return null; }
  }, [file, text]);

  if (!parsed) return <p className="text-sm text-muted-foreground">Repair the inline source JSON to edit its tokens here.</p>;
  const { graph, tree } = parsed;
  const pageSize = 20;
  const last = Math.max(0, Math.ceil(graph.rows.length / pageSize) - 1);
  const current = Math.min(page, last);
  const close = () => setDraft(undefined);
  return <>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm">{graph.rows.length} {graph.rows.length === 1 ? 'token' : 'tokens'}</span>
      <Button size="xsmall" variant="text" onClick={() => {
        setError('');
        setDraft({ create: true, groupOnly: false, path: '', file, name: '', type: undefined, value: '', description: '' });
      }}>Add inline token</Button>
    </div>
    <ul className="grid gap-1">
      {graph.rows.slice(current * pageSize, (current + 1) * pageSize).map(([path, token]) => <li key={path}>
        <Button type="button" size="xsmall" variant="text" onClick={() => {
          setError('');
          setDraft({ create: false, mode: 'inspector', column: 'value', path, name: leafName(path), type: token.node.$type,
            value: displayInput(token.type, token.value), original: token.value,
            description: token.node.$description ?? '', originalDescription: token.node.$description ?? '' });
        }}>{path}</Button>
      </li>)}
    </ul>
    {last > 0 && <div className="flex justify-end gap-2">
      <Button size="xsmall" variant="text" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous inline tokens</Button>
      <Button size="xsmall" variant="text" disabled={current === last} onClick={() => setPage(current + 1)}>Next inline tokens</Button>
    </div>}
    {draft && createPortal(<ActionDialog open title={draft.create ? 'Add inline token' : 'Edit inline token'}
      onOpenChange={open => { if (!open) close(); }} onSubmit={event => event.stopPropagation()}>
      <TokenEditForm initialDraft={draft} graph={graph} busy={false} error={error} cancel={close} commit={next => {
        try {
          const entry = graph.tokens.get(next.path);
          const group = next.create ? '' : parentPath(next.path);
          const type = next.type || entry?.type || graph.groups.get(group)?.type;
          const value = !next.create && next.value === displayInput(entry?.type, next.original) ? next.original :
            readInput(next.value, type, next.original);
          if (!canEditType(type)) throw new Error('Choose a token type.');
          validateInputValue(type, value);
          const name = next.create ? next.name.trim() : leafName(next.path);
          if (!name || next.create && name.startsWith('$')) throw new Error('Enter a token name.');
          const path = next.create ? name : next.path;
          if (!next.create && next.name !== name) throw new Error('Use the inline source JSON to rename this token and update its links.');
          const updated = changeDocument(tree, { path, create: next.create, node: {
            $value: value, ...(next.type ? { $type: next.type } : {}),
            ...(next.description || next.originalDescription ? { $description: next.description } : {}),
          }, inheritType: !next.type && !!entry?.node.$type });
          write(JSON.stringify(updated, null, 2));
          close();
          return true;
        } catch (failure) { setError(errorMessage(failure)); return false; }
      }} />
    </ActionDialog>, document.body)}
  </>;
}
