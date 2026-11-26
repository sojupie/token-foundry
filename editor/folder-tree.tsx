import { memo, useCallback, useId, useImperativeHandle, useState } from 'react';
import type { Ref } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Layers } from 'lucide-react';
import { IconButton, List, ListItemButton } from '@token-catalog/forge-react';
import { leafName, parentPath } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { requireValue } from '../lib/json.ts';

const pageSize = 80;

function revealFolder(button: HTMLButtonElement | null) {
  button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function childOnPath(parent: string, path: string) {
  const start = parent ? parent.length + 1 : 0;
  if (path.length <= start) return '';
  const end = path.indexOf('.', start);
  return end < 0 ? path : path.slice(0, end);
}

export interface FolderTreeHandle { reveal: (path: string) => void }

interface TreeProps {
  groups: DocumentGraph['groups'];
  current: string;
  select: (path: string) => void;
  allowed?: ReadonlySet<string>;
  rootLabel?: string;
  label?: string;
  independentExpansion?: boolean;
  initiallyExpanded?: string | undefined;
  ref?: Ref<FolderTreeHandle>;
}

interface BranchProps {
  groups: DocumentGraph['groups'];
  current: string;
  revealed: string;
  select: TreeProps['select'];
  allowed: TreeProps['allowed'];
  independentExpansion: boolean;
  treeId: string;
  limits: ReadonlyMap<string, number>;
  open: ReadonlyMap<string, { expanded: boolean; selection?: string }>;
  showMore: (path: string, limit: number) => void;
  toggleGroup: (path: string, expanded: boolean, selection: string) => void;
}

export const FolderTree = memo(function FolderTree({ groups, current, select, allowed, rootLabel = 'All tokens', label = 'Token groups', independentExpansion = false, initiallyExpanded, ref }: TreeProps) {
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
  const showMore = useCallback((path: string, limit: number) => {
    setLimits(previous => new Map(previous).set(path, limit + pageSize));
  }, []);
  const toggleGroup = useCallback((path: string, expanded: boolean, selection: string) => {
    setOpen(previous => new Map(previous).set(path, independentExpansion ? { expanded } : { expanded, selection }));
  }, [independentExpansion]);

  return <nav aria-label={label} className="folder-tree">
    <List className="foundry-folder-list" data-variant="segmented" data-control="expand"
      data-actions-layout="inline" data-expand-inset="inset" data-expand-surface="none" data-surface="transparent">
      <li><ListItemButton leading={<Layers />} aria-current={!current ? 'page' : undefined}
        onClick={() => select('')}>{rootLabel}</ListItemButton></li>
      <GroupItems parent="" childrenPaths={requireValue(groups.get(''), 'root group').children}
        {...{ groups, current, revealed, select, allowed, independentExpansion, treeId, limits, open, showMore, toggleGroup }} />
    </List>
  </nav>;
});

const GroupItems = memo(function GroupItems({ parent, childrenPaths, current, revealed, ...branch }: BranchProps & {
  parent: string;
  childrenPaths: readonly string[];
}) {
  const visible = branch.allowed ? childrenPaths.filter(path => branch.allowed?.has(path)) : childrenPaths;
  const limit = branch.limits.get(parent) ?? pageSize;
  const currentBranch = childOnPath(parent, current);
  const revealedBranch = childOnPath(parent, revealed);
  const entries = visible.slice(0, limit);
  // Preserve the existing first relevant child in tree order beyond this page.
  if (!entries.includes(currentBranch) && !entries.includes(revealedBranch)) {
    const relevant = visible.find(path => path === currentBranch || path === revealedBranch);
    if (relevant) entries.push(relevant);
  }
  const remaining = visible.length - entries.length;
  return <>
    {entries.map(path => <GroupItem key={path} path={path} current={currentBranch === path ? current : ''}
      revealed={revealedBranch === path ? revealed : ''} {...branch} />)}
    {remaining > 0 && <li><ListItemButton leading={<ChevronRight />} onClick={event => {
      const list = event.currentTarget.closest('ul');
      branch.showMore(parent, limit);
      requestAnimationFrame(() => {
        const siblings = list?.querySelectorAll<HTMLButtonElement>(':scope > li > button[data-group-path], :scope > li > div > button[data-group-path]');
        siblings?.[limit]?.focus();
      });
    }}>Show {Math.min(pageSize, remaining)} more groups</ListItemButton></li>}
  </>;
});

const GroupItem = memo(function GroupItem({ path, current, revealed, ...branch }: BranchProps & { path: string }) {
  const { children, definitions, files } = requireValue(branch.groups.get(path), 'group ' + path);
  const inherited = !files.size ? definitions.values().next().value?.source : undefined;
  const expandable = branch.allowed ? children.some(child => branch.allowed?.has(child)) : children.length > 0;
  const override = branch.open.get(path);
  const expanded = expandable && (branch.independentExpansion ? override?.expanded === true
    : override?.selection === current ? override.expanded : !!current || override?.expanded === true);
  const childrenId = branch.treeId + '-' + encodeURIComponent(path);
  const toggle = () => branch.toggleGroup(path, !expanded, current);
  return <li data-list-expanded={expanded}>
    <ListItemButton data-group-path={path} leading={expanded ? <FolderOpen /> : <Folder />}
      actions={expandable ? <IconButton width="narrow" aria-expanded={expanded}
        aria-controls={childrenId} label={(expanded ? 'Collapse ' : 'Expand ') + path} onClick={toggle}>
        <ChevronDown className={expanded ? 'rotate-180' : undefined} aria-hidden="true" />
      </IconButton> : undefined}
      ref={branch.allowed && current === path ? revealFolder : undefined}
      aria-current={current === path ? 'page' : undefined}
      onDoubleClick={expandable ? toggle : undefined}
      title={inherited ? 'Inherited from ' + inherited.path + ' · ' + inherited.file : path}
      onClick={() => branch.select(path)}>{leafName(path)}{inherited && <span aria-hidden="true" className="margin-start-space100 copy-small tone-supporting">Inherited</span>}</ListItemButton>
    {expandable && <List id={childrenId} hidden={!expanded} className="md-list-expand-content"
      data-variant="segmented" data-actions-layout="inline">
      {expanded && <GroupItems parent={path} childrenPaths={children} {...{ current, revealed }} {...branch} />}
    </List>}
  </li>;
});
