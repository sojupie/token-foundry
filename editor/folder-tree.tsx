import type { ReactElement } from 'react';
import { requireValue } from '../lib/json.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { useState } from 'react';
import { ChevronRight, Folder, FolderOpen, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { leafName } from '../lib/document.ts';

function revealFolder(button: HTMLButtonElement | null) {
  button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function FolderTree({ graph, current, select, allowed, rootLabel = 'All tokens', label = 'Token groups' }: {
  graph: DocumentGraph; current: string; select: (path: string) => void;
  allowed?: ReadonlySet<string>; rootLabel?: string; label?: string;
}) {
  const [open, setOpen] = useState(() => new Map<string, { expanded: boolean; selection: string }>());

  function item(path: string): ReactElement {
    const { children } = requireValue(graph.groups.get(path), 'group ' + path);
    const visible = allowed ? children.filter((child) => allowed.has(child)) : children;
    const override = open.get(path);
    const selectedBranch = current === path || current.startsWith(path + '.');
    const expanded = override?.selection === current ? override.expanded : selectedBranch || override?.expanded === true;
    const name = leafName(path);
    return <li key={path}>
      <div className="flex min-w-0 items-center gap-0.5">
        {visible.length ? <Button size="icon-xs" variant="ghost" type="button" aria-expanded={expanded}
          aria-label={(expanded ? 'Collapse ' : 'Expand ') + path} onClick={() => setOpen((previous) => {
            const next = new Map(previous);
            next.set(path, { expanded: !expanded, selection: current });
            return next;
          })}>
          <ChevronRight className={expanded ? 'rotate-90' : undefined} aria-hidden="true" />
        </Button> : <span className="w-6 shrink-0" />}
        <Button size="sm" variant={current === path ? 'secondary' : 'ghost'} type="button"
          ref={allowed && current === path ? revealFolder : undefined}
          aria-current={current === path ? 'true' : undefined} title={path}
          className="h-7 min-w-0 flex-1 justify-start px-1 font-normal" onClick={() => select(path)}>
          {expanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
          <span className="truncate">{name}</span>
        </Button>
      </div>
      {expanded && visible.length > 0 && <ul className="ms-2 border-s ps-0.5">{visible.map(item)}</ul>}
    </li>;
  }

  return <nav aria-label={label} className="p-1">
    <Button size="sm" variant={!current ? 'secondary' : 'ghost'} aria-current={!current ? 'true' : undefined}
      className="mb-1 h-7 w-full justify-start" onClick={() => select('')}>
      <Layers aria-hidden="true" /> {rootLabel}
    </Button>
    <ul>{requireValue(graph.groups.get(''), 'root group').children.filter((path) => !allowed || allowed.has(path)).map(item)}</ul>
  </nav>;
}
