import { useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, FileCode2 } from 'lucide-react';
import { Button, IconButton, List, ListItemButton } from '@token-catalog/forge-react';
import { diagnosticKey } from '../lib/document-diagnostics.ts';
import type { DocumentDiagnostic } from '../lib/document-diagnostics.ts';
import type { SourceLocation } from './source-dialog.tsx';
import { referenceLabel, referenceProblems } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { tokenDisplayName, valueFieldLabel } from './lib/value-shape.ts';
import { ActionDialog } from '@/components/ui/dialog';

const pageSize = 50;

export function DiagnosticsDialog({ graph, close, jump, editSource, sourceFor, repair, sourceOnly = false }: {
  graph: DocumentGraph;
  sourceOnly?: boolean;
  sourceFor?: (diagnostic: DocumentDiagnostic, location: SourceLocation) => SourceLocation;
  repair?: (path: string, link: boolean) => void;
  close: () => void;
  jump: (target: DocumentDiagnostic['target']) => void;
  editSource: (location: SourceLocation) => void;
}) {
  const [open, setOpen] = useState(true);
  const [page, setPage] = useState(0);
  const target = useRef<DocumentDiagnostic['target'] | { source: SourceLocation } | { repair: string; link: boolean } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const diagnostics = useMemo(() => {
    function tokenDiagnostic(path: string, message: string): DocumentDiagnostic {
      const valueField = /^(\$[^ ]+) · /u.exec(message)?.[1];
      const field = valueField?.split('/') ?? [];
      const sourcePath = [...path.split('.'), ...field];
      return { file: graph.tokens.get(path)?.file ?? '', path, field: field.join('/'), sourcePath, message, severity: 'error', target: { kind: 'token', path } };
    }
    return [...graph.documentDiagnostics,
      ...[...graph.issues].flatMap(([path, issue]) => referenceProblems(graph, path, issue).map(problem => tokenDiagnostic(path, problem))),
      ...[...graph.validation].flatMap(([path, issues]) => issues.map(issue => tokenDiagnostic(path, issue)))];
  }, [graph]);
  function revealSource(issue: DocumentDiagnostic) {
    const path = issue.sourcePath ? [...issue.sourcePath] : issue.path ? issue.path.split('.') : [];
    if (issue.field && !issue.sourcePath) path.push(issue.field);
    const location = { file: issue.file, path, ...(issue.offset === undefined ? {} : { offset: issue.offset }) };
    target.current = { source: sourceFor?.(issue, location) ?? location };
    setOpen(false);
  }
  const start = page * pageSize;
  const end = Math.min(diagnostics.length, start + pageSize);
  function turn(next: number) {
    setPage(next);
    list.current?.parentElement?.scrollTo(0, 0);
  }

  return <ActionDialog open={open} onOpenChange={setOpen} title="Workspace issues"
    onAfterClose={() => {
      close();
      if (target.current && 'source' in target.current) editSource(target.current.source);
      else if (target.current && 'repair' in target.current) repair?.(target.current.repair, target.current.link);
      else if (target.current) jump(target.current);
    }}
    actions={diagnostics.length > pageSize && <>
      <span className="me-auto numeric-text">{start + 1}–{end} of {diagnostics.length}</span>
      <IconButton size="xsmall" label="Previous diagnostics" disabled={page === 0}
        onClick={() => turn(page - 1)}><ChevronLeft aria-hidden="true" /></IconButton>
      <IconButton size="xsmall" label="Next diagnostics" disabled={end === diagnostics.length}
        onClick={() => turn(page + 1)}><ChevronRight aria-hidden="true" /></IconButton>
    </>}>
    <div className="max-h-[55dvh] overflow-auto">
      <List ref={list} aria-label="Document diagnostics" data-variant="segmented" data-surface="transparent">
        {diagnostics.slice(start, end).map(issue => {
          const token = graph.tokens.get(issue.path);
          const link = !!referenceLabel(token?.value) && graph.issues.has(issue.path);
          const field = valueFieldLabel(issue.field.split('/').filter(Boolean), graph.resolved.get(issue.path) ?? token?.value, token?.type);
          return <li key={diagnosticKey(issue)}>
            <ListItemButton leading={<AlertCircle />} actions={<>
              {repair && !sourceOnly && token && <Button size="xsmall" variant="text"
                aria-label={(link ? 'Fix link in ' : 'Edit value in ') + tokenDisplayName(issue.path)}
                onClick={() => { target.current = { repair: issue.path, link }; setOpen(false); }}>
                {link ? 'Fix link' : 'Edit value'}
              </Button>}
              <Button variant="text" size="xsmall"
                aria-label={'Open source for ' + (issue.path || issue.file) + (issue.field ? ' · ' + issue.field : '')} title="Open source" onClick={() => revealSource(issue)}>
                <FileCode2 aria-hidden="true" /> Open source
              </Button>
            </>} onClick={() => {
              if (sourceOnly || issue.target.kind === 'source') revealSource(issue);
              else { target.current = issue.target; setOpen(false); }
            }}>
              <span className="grid min-w-0 gap-1 text-start">
                <code className="wrap-anywhere">{tokenDisplayName(issue.path) || (issue.target.kind === 'source' ? issue.file : 'Top level')}</code>
                <span className="wrap-anywhere copy-small tone-supporting">
                  {issue.severity === 'error' ? 'Error' : 'Warning'} · {issue.file}{field && ' · ' + field} · {issue.message}
                </span>
              </span>
            </ListItemButton>
          </li>;
        })}
      </List>
    </div>
  </ActionDialog>;
}
