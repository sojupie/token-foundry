import type { ReactElement, Ref } from 'react';
import { requireValue } from '../lib/json.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { memo, useId, useImperativeHandle, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Layers } from 'lucide-react';
import { IconButton, List, ListItemButton } from '@token-catalog/forge-react';
import { leafName, parentPath } from '../lib/document.ts';

function revealFolder(button: HTMLButtonElement | null) {
  button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export interface FolderTreeHandle { reveal: (path: string) => void }

export const FolderTree = memo(function FolderTree({ graph, current, select, allowed, rootLabel = 'All tokens', label = 'Token groups', independentExpansion = false, initiallyExpanded, ref }: {
  graph: DocumentGraph; current: string; select: (path: string) => void;
  allowed?: ReadonlySet<string>; rootLabel?: string; label?: string; independentExpansion?: boolean; initiallyExpanded?: string | undefined; ref?: Ref<FolderTreeHandle>;
}) {
  const pageSize = 80;
  const [limits, setLimits] = useState(() => new Map<string, number>());
  const [revealed, setRevealed] = useState('');
  const [open, setOpen] = useState(() => new Map<string, { expanded: boolean; selection?: string }>(
    initiallyExpanded ? [[initiallyExpanded, { expanded: true }]] : [],
  ));
  useImperativeHandle(ref, () => ({
    reveal(path) {
      setRevealed(path);
      setOpen(previous => {
        const next = new Map(previous);
        for (let ancestor = parentPath(path); ancestor; ancestor = parentPath(ancestor)) {
          next.set(ancestor, { expanded: true });
        }
        return next;
      });
    },
  }), []);
  const treeId = useId();
  const rootGroups = requireValue(graph.groups.get(''), 'root group').children;

  function items(parent: string, children: readonly string[]) {
    const visible = allowed ? children.filter(path => allowed.has(path)) : children;
    const limit = limits.get(parent) ?? pageSize;
    const relevant = visible.find(path => current === path || current.startsWith(path + '.') || revealed === path || revealed.startsWith(path + '.'));
    const entries = visible.slice(0, limit);
    if (relevant && !entries.includes(relevant)) entries.push(relevant);
    const remaining = visible.length - entries.length;
    return <>
      {entries.map(item)}
      {remaining > 0 && <li><ListItemButton leading={<ChevronRight />} onClick={event => {
        const list = event.currentTarget.closest('ul');
        setLimits(previous => new Map(previous).set(parent, limit + pageSize));
        requestAnimationFrame(() => {
          const siblings = list?.querySelectorAll<HTMLButtonElement>(':scope > li > button[data-group-path], :scope > li > div > button[data-group-path]');
          siblings?.[limit]?.focus();
        });
      }}>Show {Math.min(pageSize, remaining)} more groups</ListItemButton></li>}
    </>;
  }

  function item(path: string): ReactElement {
    const { children, definitions, files } = requireValue(graph.groups.get(path), 'group ' + path);
    const inherited = !files.size ? definitions.values().next().value?.source : undefined;
    const visible = allowed ? children.filter((child) => allowed.has(child)) : children;
    const override = open.get(path);
    const selectedBranch = current === path || current.startsWith(path + '.');
    const expanded = visible.length > 0 && (independentExpansion ? override?.expanded === true
      : override?.selection === current ? override.expanded : selectedBranch || override?.expanded === true);
    const name = leafName(path);
    const childrenId = treeId + '-' + encodeURIComponent(path);
    function toggle() {
      const state = independentExpansion ? { expanded: !expanded } : { expanded: !expanded, selection: current };
      setOpen((previous) => new Map(previous).set(path, state));
    }
    return <li key={path} data-list-expanded={expanded}>
      <ListItemButton data-group-path={path} leading={expanded ? <FolderOpen /> : <Folder />}
        actions={visible.length > 0 ? <IconButton width="narrow" aria-expanded={expanded}
          aria-controls={childrenId} label={(expanded ? 'Collapse ' : 'Expand ') + path} onClick={toggle}>
          <ChevronDown className={expanded ? 'rotate-180' : undefined} aria-hidden="true" />
        </IconButton> : undefined}
        ref={allowed && current === path ? revealFolder : undefined}
        aria-current={current === path ? 'page' : undefined}
        onDoubleClick={visible.length > 0 ? toggle : undefined}
        title={inherited ? 'Inherited from ' + inherited.path + ' · ' + inherited.file : path}
        onClick={() => select(path)}>{name}{inherited && <span aria-hidden="true" className="ms-2 text-xs text-muted-foreground">Inherited</span>}</ListItemButton>
      {visible.length > 0 && <List id={childrenId} hidden={!expanded} className="md-list-expand-content"
        data-variant="segmented" data-actions-layout="inline">
        {expanded && items(path, visible)}
      </List>}
    </li>;

  }

  return <nav aria-label={label} className="folder-tree">
    <List className="foundry-folder-list" data-variant="segmented" data-control="expand"
      data-actions-layout="inline" data-expand-inset="inset" data-expand-surface="none" data-surface="transparent">
      <li><ListItemButton leading={<Layers />} aria-current={!current ? 'page' : undefined}
        onClick={() => select('')}>{rootLabel}</ListItemButton></li>
      {items('', rootGroups)}
    </List>
  </nav>;
});
