import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { leafName, parentPath } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { FolderTree } from './folder-tree.tsx';
import { TokenValue } from './token-value.tsx';

const limit = 50;

export function ReferencePicker({ graph, source, type, target, seed, flexible, choose, apply }: {
  graph: DocumentGraph; source: string; type: string | undefined; target: string | undefined;
  seed: string; flexible: boolean; choose: (path: string) => void; apply: () => void;
}) {
  const [group, setGroup] = useState(() => {
    let initial = target ?? parentPath(source);
    while (!graph.groups.has(initial) && initial) initial = parentPath(initial);
    return initial;
  });
  const [query, setQuery] = useState(seed);
  const [showAllTypes, setShowAllTypes] = useState(false);
  const filterType = showAllTypes ? undefined : type;
  const results = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const focusSearch = useCallback((input: HTMLInputElement | null) => {
    search.current = input;
    input?.focus({ preventScroll: true });
  }, []);
  const { candidates, allowed } = useMemo(() => {
    const excluded = new Set([source]);
    for (const path of excluded) {
      for (const consumer of graph.usedBy.get(path) ?? []) excluded.add(consumer);
    }
    const eligible = new Set<string>();
    const groups = new Set(['']);
    for (const [path, token] of graph.rows) {
      if (excluded.has(path) || graph.issues.has(path) || (filterType && filterType !== token.type)) continue;
      eligible.add(path);
      for (let parent = parentPath(path); !groups.has(parent); parent = parentPath(parent)) groups.add(parent);
    }
    return { candidates: eligible, allowed: groups };
  }, [graph, source, filterType]);

  const current = allowed.has(group) ? group : '';
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = terms.length ? [...candidates].filter((path) => terms.every((term) => path.toLowerCase().includes(term))) :
    [...(graph.groups.get(current)?.members ?? [])].filter((path) => candidates.has(path));
  const visible = terms.length ? matches.slice(0, limit) : matches;
  const children = (graph.groups.get(current)?.children ?? []).filter((path) => allowed.has(path));
  const count = matches.length;
  const summary = terms.length ? count > limit ? 'Showing ' + limit + ' of ' + count.toLocaleString('en') + ' matches' :
    count.toLocaleString('en') + (count === 1 ? ' match' : ' matches') : filterType ? filterType + ' tokens' : 'All token types';

  function browse(path: string) {
    setGroup(path);
    setQuery('');
  }

  function navigateResults(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = Array.from(results.current?.querySelectorAll('button') ?? []);
    const index = buttons.indexOf(event.currentTarget);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) search.current?.focus();
    else buttons[next]?.focus();
  }

  return <section aria-label="Link a reference" className="grid min-w-0 gap-2">
    <div className="relative">
      <Search className="pointer-events-none absolute start-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
      <Input ref={focusSearch} type="search" aria-label="Search references" placeholder="Search by token or group name"
        className="ps-8" data-reference-search value={query} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            results.current?.querySelector('button')?.focus();
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.ctrlKey || event.metaKey) apply();
            else if (terms.length && visible[0]) choose(visible[0]);
          }
        }} />
    </div>
    <div className="grid min-h-0 grid-cols-[minmax(7rem,41%)_minmax(0,1fr)] overflow-hidden rounded-md border">
      <div className="max-h-64 overflow-auto border-e bg-muted/30">
        <FolderTree graph={graph} current={current} select={browse} allowed={allowed} label="Reference groups" />
      </div>
      <div className="flex min-w-0 flex-col">
        <p className="truncate border-b bg-muted/20 px-2 py-1.5 text-xs font-medium" title={current}>
          {terms.length ? 'Search results' : current || 'All tokens'}
        </p>
        <div ref={results} aria-label="Reference results" className="min-h-20 max-h-56 overflow-auto p-1">
          {!terms.length && children.map((path) => <Button key={path} type="button" variant="ghost" size="sm"
            className="flex w-full justify-between font-normal" onClick={() => browse(path)} onKeyDown={navigateResults}>
            <span className="truncate">{leafName(path)}</span><ChevronRight aria-hidden="true" />
          </Button>)}
          {visible.map((path) => <Button key={path} type="button" variant={target === path ? 'secondary' : 'ghost'}
            size="sm" title={path} aria-label={path} aria-pressed={target === path}
            className="flex h-auto min-h-8 w-full items-start justify-between px-2 py-1 text-start font-normal"
            onClick={() => choose(path)} onKeyDown={navigateResults}>
            <span className="min-w-0 font-mono text-xs whitespace-normal wrap-anywhere">{terms.length ? path : leafName(path)}</span>
            <span className="max-w-[45%] shrink-0 text-muted-foreground"><TokenValue value={graph.resolved.get(path)} swatch={type === 'color'} /></span>
          </Button>)}
          {!visible.length && (terms.length > 0 || !children.length) &&
            <p className="p-2 text-xs text-muted-foreground">{terms.length ? 'No matching references.' : 'No compatible tokens in this group.'}</p>}
        </div>
      </div>
    </div>
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground" aria-live="polite">{summary}</p>
      {flexible && type && <Button type="button" variant={showAllTypes ? 'secondary' : 'ghost'} size="xs"
        aria-pressed={showAllTypes} onClick={() => setShowAllTypes(!showAllTypes)}>All types</Button>}
    </div>
  </section>;
}
