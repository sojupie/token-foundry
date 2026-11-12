import { StrictMode, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ComponentType } from 'react';
import { errorMessage, requireValue } from '../lib/json.ts';
import type { TokenNode } from '../lib/token-types.ts';
import { reviewAgainstLatest, reviewDelete, reviewEdit, reviewMove, reviewMoves, reviewProposal, reviewWorkspace, workspaceChanges } from '../lib/workspace.ts';
import type { Review, Workspace } from '../lib/workspace.ts';
import type { CellPosition, Draft, EditableColumn } from './lib/draft.ts';
import type { WorkspaceConnection, WorkspaceConnectorProps } from './lib/connector.ts';
import { OpenGitHub } from '../integrations/github/connect.tsx';
import { createRoot } from 'react-dom/client';
import { AlertCircle, ArrowDownToLine, ArrowRightLeft, ChevronLeft, ChevronRight, FileUp, FolderOpen, FolderPlus, GitPullRequest, Link2, PanelLeft, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ReviewChanges } from './review-dialog.tsx';
import { MoveDialog } from './move-dialog.tsx';
import { FolderTree } from './folder-tree';
import { TokenGrid } from './token-grid';
import { CommandBar, CommandMenu } from './command-bar.tsx';
import type { Menu } from './command-bar.tsx';
import { NamespaceActions } from './namespace-actions.tsx';
import { ReferenceDetails } from './reference-details.tsx';
import { TokenEditForm } from './token-edit-form.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { displayInput, inputFormat, readInput, validateInputValue } from './lib/token-input';
import { leafName, parentPath, referenceLabel } from '../lib/document.ts';
import type { DocumentGraph, TokenEntry } from '../lib/document.ts';
import { download, downloadPatch, openExample, openFiles } from './lib/sources.ts';
import { openLocalFolder } from './lib/local-folder.ts';
import './shadcn.css';

const pageSize = 100;
const desktopViewport = matchMedia('(min-width: 48rem)');
function subscribeViewport(onChange: () => void) {
  desktopViewport.addEventListener('change', onChange);
  return () => desktopViewport.removeEventListener('change', onChange);
}
const isDesktopViewport = () => desktopViewport.matches;

type SaveTarget = { kind: 'folder'; save: (workspace: Workspace) => Promise<void> } |
  { kind: 'pull-request'; connection: WorkspaceConnection };

function Editor({ Connector, proposalLink }: { Connector: ComponentType<WorkspaceConnectorProps> | null; proposalLink: string }) {
  const [data, setData] = useState(openExample);
  const [group, setGroup] = useState('');
  const [query, setQuery] = useState('');
  const [onlyUnresolved, setOnlyUnresolved] = useState(false);
  const [selected, setSelected] = useState('');
  const [checked, setChecked] = useState(() => new Set<string>());
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [referenceDetails, setReferenceDetails] = useState('');
  const [relocate, setRelocate] = useState<{ paths: string[]; rename: boolean } | null>(null);
  const [showTree, setShowTree] = useState(true);
  const desktop = useSyncExternalStore(subscribeViewport, isDesktopViewport);
  const [mobileTree, setMobileTree] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [finalReview, setFinalReview] = useState<Review | null>(null);
  const [saveTarget, setSaveTarget] = useState<SaveTarget | null>(null);
  const [revisionReview, setRevisionReview] = useState<'current' | 'stale' | 'refreshed'>('current');
  const [submittedUrl, setSubmittedUrl] = useState('');
  const [linkedProposal, setLinkedProposal] = useState(proposalLink);
  const [importChanges, setImportChanges] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const proposalInput = useRef<HTMLInputElement>(null);
  const workspacePane = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [focusRequest, setFocusRequest] = useState<CellPosition | null>(null);
  const graph = data.graph;
  const folder = requireValue(graph.groups.get(group), 'current group');
  const search = query.trim().toLowerCase();
  const groupRows = graph.rows.slice(folder.start, folder.end);
  const unresolvedCount = groupRows.reduce((count, [path]) => count + Number(graph.issues.has(path)), 0);
  const showOnlyUnresolved = onlyUnresolved && unresolvedCount > 0;
  function matchesRow([path, { type, node }]: [string, TokenEntry], current: DocumentGraph) {
    return (!showOnlyUnresolved || current.issues.has(path)) &&
      (!search || [path, type, node.$description].some((value) => typeof value === 'string' && value.toLowerCase().includes(search)));
  }
  const filtered = groupRows.filter((row) => matchesRow(row, graph));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const rows = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const active = graph.tokens.get(selected);
  const targets = checked.size ? [...checked] : active ? [selected] : [];
  const selectionCount = targets.length.toLocaleString('en');
  const hasChanges = workspaceChanges(data).length > 0;

  function activate(next: Workspace, target: SaveTarget | null = null) {
    setData(next);
    setGroup('');
    setDirty(false);
    setReview(null);
    setFinalReview(null);
    setSaveTarget(target);
    setRevisionReview('current');
    setSubmittedUrl('');
    clearSelection();
    setStatus('');
    setError('');
  }

  async function loadFolder() {
    if (!window.showDirectoryPicker) {
      folderInput.current?.setAttribute('webkitdirectory', '');
      folderInput.current?.click();
      return;
    }
    if (!canReplace()) return;
    setBusy(true);
    setError('');
    try {
      const directory = await window.showDirectoryPicker({ id: 'token-workspace', mode: 'read' });
      const { workspace, save } = await openLocalFolder(directory);
      activate(workspace, { kind: 'folder', save });
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function load(files: File[], isFolder: boolean) {
    if (!files.length || !canReplace()) return;
    setBusy(true);
    setError('');
    try {
      activate(await openFiles(files, isFolder));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function loadMd3() {
    if (!canReplace()) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/__md3-sample.json');
      if (!response.ok) throw new Error('The MD3 sample could not be loaded.');
      const file = new File([await response.blob()], 'md3-token-set.json', { type: 'application/json' });
      activate(await openFiles([file], false));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }

  async function loadProposal(file: File) {
    if (draft || review || busy) return;
    setBusy(true);
    setError('');
    try {
      setReview(reviewProposal(data, await file.text()));
      setImportChanges(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function reviewLinkedProposal() {
    setError('');
    try {
      setReview(reviewProposal(data, linkedProposal));
      setLinkedProposal('');
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  useLayoutEffect(() => {
    if (!focusRequest) return;
    const cell = grid.current?.querySelector<HTMLButtonElement>(
      '[data-token-row="' + CSS.escape(focusRequest.path) + '"] [data-edit-column="' + focusRequest.column + '"]',
    );
    cell?.focus({ preventScroll: true });
    cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focusRequest]);

  const hasUnsavedWork = dirty || !!draft;
  useEffect(() => {
    if (!hasUnsavedWork) return undefined;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedWork]);

  function clearSelection() {
    setFocusRequest(null);
    setDraft(null);
    setSelected('');
    setChecked(new Set());
    setReferenceDetails('');
    setPage(0);
    setQuery('');
    setOnlyUnresolved(false);
  }

  function resetScroll() {
    grid.current?.querySelector('[data-slot="table-container"]')?.scrollTo(0, 0);
  }

  function selectGroup(path: string) {
    setGroup(path);
    setMobileTree(false);
    setError('');
    clearSelection();
    resetScroll();
  }

  function select(path: string, replace = false) {
    if (replace) setChecked(new Set());
    setSelected(path);
    setReferenceDetails('');
    setError('');
  }

  function selectRows(paths: readonly string[], activePath: string) {
    setChecked(new Set(paths));
    select(activePath);
  }

  const clearOnEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || draft || (!selected && !checked.size) ||
      (event.target instanceof HTMLInputElement && event.target.type === 'search')) return;
    event.preventDefault();
    selectRows([], '');
  });
  useEffect(() => {
    const pane = workspacePane.current;
    const onKeyDown = (event: KeyboardEvent) => clearOnEscape(event);
    pane?.addEventListener('keydown', onKeyDown);
    return () => pane?.removeEventListener('keydown', onKeyDown);
  }, []);

  function jump(path: string) {
    const parent = parentPath(path);
    const start = requireValue(graph.groups.get(parent), 'parent group').start;
    setGroup(parent);
    setQuery('');
    setOnlyUnresolved(false);
    setPage(Math.floor((graph.rows.findIndex(([id]) => id === path) - start) / pageSize));
    setFocusRequest({ path, column: 'name' });
    select(path);
  }

  function toggle(paths: readonly string[], value: boolean) {
    setChecked((previous) => {
      const next = new Set(previous);
      for (const path of paths) {
        if (value) next.add(path);
        else next.delete(path);
      }
      return next;
    });
  }

  function toggleRow(path: string, previous: string) {
    const next = new Set(checked);
    if (!next.size && previous) next.add(previous);
    if (!next.delete(path)) next.add(path);
    setChecked(next);
    select(next.has(path) ? path : next.values().next().value ?? '');
  }

  function edit(path: string, column: EditableColumn, link = false) {
    if (busy || draft) return;
    const token = graph.tokens.get(path);
    if (!token) return;
    select(path);
    const mode = column === 'value' && (link || referenceLabel(token.value)) ? 'link' :
      column === 'value' && token.value !== null && typeof token.value === 'object' &&
        inputFormat(token.type, token.value) === 'json' ? 'details' : 'inline';
    setDraft({ path, name: leafName(path), column, mode, type: column === 'type' ? token.node.$type : token.type, original: token.value,
      value: displayInput(token.type, token.value), originalDescription: token.node.$description ?? '',
      description: token.node.$description ?? '', create: false });
  }

  function create(groupOnly: boolean) {
    setError('');
    setReferenceDetails('');
    if (showOnlyUnresolved) {
      setOnlyUnresolved(false);
      setPage(0);
    }
    const destinations = [...folder.files.keys()];
    setDraft({ create: true, groupOnly, path: group, name: '', type: folder.type ? '' : 'color', value: '', description: '',
      file: destinations.length === 1 ? destinations[0] ?? '' : '' });
  }

  function cancel(restore = true) {
    setError('');
    if (restore && draft && !draft.create) setFocusRequest({ path: draft.path, column: draft.column });
    setDraft(null);
  }

  function finishChange(next: Workspace, path: string, applied: Draft, after?: CellPosition | null) {
    setData(next);
    setDirty(true);
    setStatus('');
    if (applied.groupOnly) selectGroup(path);
    else if (applied.create) {
      setQuery('');
      const index = next.graph.rows.findIndex(([id]) => id === path);
      setPage(Math.floor((index - requireValue(next.graph.groups.get(group), 'current group').start) / pageSize));
      setSelected(path);
    }
    if (showOnlyUnresolved && !next.graph.issues.has(path)) {
      setPage(0);
      select('');
      resetScroll();
    } else {
      const nextPath = !applied.create && after && after.path !== applied.path ? after.path : path;
      if (!applied.groupOnly && after !== null) {
        setFocusRequest({ path: nextPath, column: after?.column ?? (applied.create ? 'name' : applied.column) });
      }
      if (!applied.create) {
        setSelected(nextPath);
        if (applied.path !== path) {
          setChecked((previous) => {
            const selection = new Set(previous);
            if (selection.delete(applied.path)) selection.add(path);
            return selection;
          });
          const index = next.graph.rows.findIndex(([id]) => id === nextPath);
          if (!search && index >= 0) setPage(Math.floor((index - requireValue(next.graph.groups.get(group), 'current group').start) / pageSize));
        }
      }
    }
    setDraft(null);
  }

  function closeReview() {
    setReview(null);
    setError('');
  }

  function saveReview() {
    if (!review) return;
    if (draft) finishChange(review.next, review.path, draft);
    else {
      setData(review.next);
      setDirty(true);
      if (review.path) {
        if (review.next.graph.groups.has(review.path)) selectGroup(review.path);
        else selectGroup(parentPath(review.path));
      }
      else {
        setChecked(new Set());
        setSelected('');
        setReferenceDetails('');
        setPage(0);
        if (!review.next.graph.groups.has(group)) setGroup(parentPath(group));
      }
      setStatus('');
    }
    closeReview();
  }

  function commit(pending = draft, after?: CellPosition | null): boolean {
    if (!pending || busy || review) return false;
    const change = pending;
    function closeUnchanged() {
      cancel(after === undefined);
      if (after) {
        setSelected(after.path);
        setFocusRequest(after);
      }
      return true;
    }
    setError('');
    try {
      const name = change.name.trim();
      if (!name || /[.{}]/u.test(name) || (name.startsWith('$') && (name !== '$root' || change.groupOnly))) {
        throw new Error('Enter a name without periods or braces. Only root tokens may use $root.');
      }
      if (!change.create && change.column === 'name') {
        if (leafName(change.path) === name) return closeUnchanged();
        const path = [parentPath(change.path), name].filter(Boolean).join('.');
        const file = requireValue(graph.tokens.get(change.path), 'token').file;
        const renamed = reviewMove(data, { path: change.path, to: path, file });
        finishChange(renamed.next, path, change, after);
        return true;
      }
      const path = change.create ? [group, name].filter(Boolean).join('.') : change.path;
      const token = change.create ? undefined : requireValue(graph.tokens.get(path), 'token');
      const file = change.create ? change.file : token?.file;
      if (!file) throw new Error('Choose a source file for this edit.');
      const node: TokenNode = {};
      const description = change.description.trim();
      if (description !== (change.originalDescription ?? '')) node.$description = description;
      const typeChanged = !change.create && change.column === 'type' && (change.type || undefined) !== token?.node.$type;
      const inheritType = typeChanged && !change.type;
      if (!change.groupOnly) {
        if ((change.create || typeChanged) && change.type) node.$type = change.type;
        const inherited = graph.groups.get(parentPath(path))?.files.get(file);
        const editingValue = !change.create && change.column === 'value';
        const type = editingValue ? token?.type ?? inherited : change.type || inherited;
        const valueChanged = change.create || change.value !== displayInput(token?.type, change.original);
        if (valueChanged) node.$value = readInput(change.value, type, change.original);
        if (valueChanged || typeChanged) {
          const value = node.$value === undefined ? change.original : node.$value;
          if (!referenceLabel(value)) {
            if (!type && (change.create || typeChanged)) throw new Error('Choose a type for this value, such as Color or Number.');
            if (editingValue && !token?.node.$type && type && type !== inherited) node.$type = type;
          }
          validateInputValue(type, value);
        }
      }
      if (!change.create && !Object.keys(node).length && !inheritType) return closeUnchanged();
      const updated = reviewEdit(data, file, { path, node, create: change.create, inheritType });
      if (change.create) {
        setReview(updated);
      } else finishChange(updated.next, path, change, after);
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    }
  }

  function deletePaths(paths: string[]) {
    setError('');
    try {
      setReview(reviewDelete(data, paths));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  function canReplace() {
    return !(dirty || draft) || window.confirm('Open different token files and discard your unsaved edits?');
  }

  function reviewForSave() {
    setError('');
    try {
      setFinalReview(reviewWorkspace(data));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  async function saveFinalReview() {
    if (!finalReview || busy) return;
    if (!saveTarget) {
      downloadPatch(finalReview.next);
      setFinalReview(null);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { next } = finalReview;
      if (saveTarget.kind === 'folder') {
        await saveTarget.save(next);
        setData({ ...next, baseline: next.files });
        setStatus('Saved to folder.');
      } else {
        if (revisionReview === 'stale') {
          const connection = await saveTarget.connection.refresh();
          const refreshed = reviewAgainstLatest(next, connection.workspace);
          activate(refreshed?.next ?? connection.workspace, { kind: 'pull-request', connection });
          if (refreshed) {
            setDirty(true);
            setFinalReview(refreshed);
            setRevisionReview('refreshed');
          } else setStatus('The latest revision already contains your changes.');
          return;
        }
        const result = await saveTarget.connection.submit(workspaceChanges(next));
        if (result.status === 'stale') {
          setRevisionReview('stale');
          return;
        }
        setSubmittedUrl(result.url);
        setStatus('Pull request opened.');
      }
      setFinalReview(null);
      setDirty(false);
      setRevisionReview('current');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  const menuDisabled = busy || !!draft;
  const treeVisible = desktop ? showTree : mobileTree;
  const reviewLabel = saveTarget?.kind === 'folder' ? 'Review and save' :
    saveTarget?.kind === 'pull-request' ? 'Review for pull request' : 'Review changes';
  const showMd3 = import.meta.env.DEV && import.meta.env['VITE_MD3_SAMPLE'] === '1';
  const menus: Menu[] = [
    { label: 'File', sections: [
      [
        { label: 'Open token files…', icon: <FileUp aria-hidden="true" />, run: () => fileInput.current?.click(), disabled: busy },
        { label: 'Open token folder…', icon: <FolderOpen aria-hidden="true" />, run: () => { void loadFolder(); }, disabled: busy },
        { label: 'Open built-in example', icon: <FolderOpen aria-hidden="true" />, run: () => { if (canReplace()) activate(openExample()); }, disabled: busy },
        { label: 'Open Material 3 sample', icon: <FolderOpen aria-hidden="true" />, run: () => { void loadMd3(); },
          disabled: busy || !showMd3, title: showMd3 ? undefined : 'This build does not include the Material 3 sample.' },
        { label: 'Import value changes…', icon: <FileUp aria-hidden="true" />,
          run: () => { setError(''); setImportChanges(true); }, disabled: menuDisabled },
      ],
      [
        {
          label: 'Download token JSON', icon: <ArrowDownToLine aria-hidden="true" />, disabled: menuDisabled || data.files.length !== 1,
          title: data.files.length === 1 ? undefined : 'Open a single token file to download it as JSON.',
          run: () => {
            const file = requireValue(data.files[0], 'open file');
            download(file.path, file.text, 'application/json');
            if (!saveTarget) setDirty(false);
          },
        },
        {
          label: 'Download patch', icon: <ArrowDownToLine aria-hidden="true" />, disabled: menuDisabled || !hasChanges,
          title: 'Apply the .patch file in your repository with git apply.',
          run: () => { downloadPatch(data); },
        },
      ],
    ] },
  ];

  return <div className="flex h-dvh flex-col overflow-hidden text-sm">
    <header className="grid h-11 shrink-0 grid-cols-[minmax(0,1fr)_6rem] items-center gap-2 border-b bg-muted/20 px-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
      <div className="flex min-w-0 items-center gap-2">
        <Button type="button" size="icon-sm" variant="ghost" className="shrink-0"
          aria-label={treeVisible ? 'Hide groups sidebar' : 'Show groups sidebar'}
          title={treeVisible ? 'Hide groups sidebar' : 'Show groups sidebar'}
          aria-controls="groups" aria-expanded={treeVisible} disabled={menuDisabled}
          onClick={() => { if (desktop) setShowTree(!showTree); else setMobileTree(!mobileTree); }}>
          <PanelLeft aria-hidden="true" />
        </Button>
        <div className="sr-only min-w-0 items-center gap-2 sm:not-sr-only sm:flex sm:w-60 sm:border-e sm:pe-3">
          <h1 className="shrink-0 font-semibold">Token Foundry</h1>
          <span className="min-w-0 truncate border-s ps-2 text-xs text-muted-foreground" title={data.name}>{data.name}</span>
        </div>
        <CommandBar menus={menus}>
          {Connector ? <Connector disabled={menuDisabled} canReplace={canReplace} connect={(connection) =>
            activate(connection.workspace, { kind: 'pull-request', connection })} /> :
            <CommandMenu label="Integrations" status="" sections={[[{
              label: 'Open GitHub repository…', icon: <GitPullRequest aria-hidden="true" />, disabled: true,
              title: 'GitHub integration is available in the hosted editor.', run: () => undefined,
            }]]} />}
        </CommandBar>
      </div>
      <input ref={fileInput} type="file" accept=".json,.tokens,application/json" hidden multiple onChange={(event) => {
        void load(Array.from(event.target.files ?? []), false);
        event.target.value = '';
      }} />
      <input ref={folderInput} type="file" hidden onChange={(event) => {
        void load(Array.from(event.target.files ?? []), true);
        event.target.value = '';
      }} />
      <input ref={proposalInput} type="file" accept=".json,application/json" hidden onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void loadProposal(file);
        event.target.value = '';
      }} />
      <div className="col-start-2 row-start-1">
        {submittedUrl && !dirty ? <Button size="sm" className="w-full" asChild>
          <a href={submittedUrl} target="_blank" rel="noreferrer" aria-label="View pull request">View PR</a>
        </Button> : <Button size="sm" className="w-full disabled:bg-transparent disabled:text-muted-foreground" disabled={menuDisabled || !dirty || !hasChanges} onClick={reviewForSave}
          aria-label={reviewLabel}>Review<span className="hidden sm:inline"> changes</span></Button>}
      </div>
    </header>
    {linkedProposal && <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <p className="me-auto">Linked changes apply to matching tokens in this workspace.</p>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setLinkedProposal('')}>Dismiss</Button>
      <Button size="sm" disabled={busy || !!draft} onClick={reviewLinkedProposal}>Review linked changes</Button>
    </div>}
    {error && !draft && !review && !finalReview && !importChanges && <Alert variant="destructive" className="shrink-0 rounded-none border-x-0">
      <AlertDescription className="max-h-32 overflow-auto whitespace-pre-wrap">{error}</AlertDescription>
    </Alert>}
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside id="groups" aria-label="Groups" className={(mobileTree ? 'block ' : 'hidden ') + (showTree ? 'md:block ' : 'md:hidden ') + 'max-h-56 w-full shrink-0 overflow-auto border-b bg-muted/20 md:max-h-none md:w-56 md:border-e md:border-b-0 lg:w-64'}>
          <div className="sticky top-0 z-10 flex h-10 items-center gap-1 border-b bg-background px-3">
            <h2 className="me-auto min-w-0 truncate text-sm font-medium" title={group}>{group || 'Groups'}</h2>
            {group && <>
              <Button type="button" size="icon-xs" variant="ghost" aria-label="Rename group" title="Rename group" disabled={menuDisabled}
                onClick={() => setRelocate({ paths: [group], rename: true })}><Pencil aria-hidden="true" /></Button>
              <NamespaceActions kind="group" disabled={menuDisabled} move={() => setRelocate({ paths: [group], rename: false })}
                remove={() => deletePaths([group])} />
            </>}
          </div>
          <fieldset disabled={!!draft || busy}>
            <FolderTree key={data.name} graph={graph} current={group} select={selectGroup} />
          </fieldset>
        </aside>
        <main ref={workspacePane} className="@container/grid flex min-h-0 min-w-0 flex-1 flex-col">
          <section aria-label="Token commands"
            className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b px-2 py-1 @min-[49rem]/grid:grid-cols-[auto_auto_minmax(0,1fr)]">
            <div className="col-start-1 row-start-1 flex items-center gap-1.5">
              <div className="flex shrink-0 items-center gap-1" aria-label="Create">
                <Button type="button" size="sm" variant="secondary" className="@max-[32rem]/grid:size-8 @max-[32rem]/grid:p-0"
                  aria-label="New token" title="New token" disabled={menuDisabled} onClick={() => create(false)}>
                  <Plus aria-hidden="true" /><span className="hidden @min-[32rem]/grid:inline">New token</span>
                </Button>
                <Button type="button" size="sm" variant="ghost" className="@max-[57rem]/grid:size-8 @max-[57rem]/grid:p-0"
                  aria-label="New group" title="New group" disabled={menuDisabled} onClick={() => create(true)}>
                  <FolderPlus aria-hidden="true" /><span className="hidden @min-[57rem]/grid:inline">New group</span>
                </Button>
              </div>
              <div className="flex shrink-0 items-center gap-1 border-s ps-2" aria-label="Selection">
                <Button type="button" size="sm" variant="ghost" className="@max-[32rem]/grid:size-8 @max-[32rem]/grid:p-0" disabled={menuDisabled || !targets.length}
                  aria-label={checked.size ? 'Move selected' : 'Move token'} title="Move tokens" onClick={() => setRelocate({ paths: targets, rename: false })}>
                  <ArrowRightLeft aria-hidden="true" /><span className="hidden @min-[32rem]/grid:inline">Move</span>
                </Button>
                <Button type="button" size="sm" variant="ghost" className="@max-[32rem]/grid:size-8 @max-[32rem]/grid:p-0" disabled={menuDisabled || !targets.length}
                  aria-label={checked.size ? 'Delete selected' : 'Delete token'} title="Delete tokens" onClick={() => deletePaths(targets)}>
                  <Trash2 aria-hidden="true" /><span className="hidden @min-[32rem]/grid:inline">Delete</span>
                </Button>
                <Button type="button" size="sm" variant="ghost" className="@max-[57rem]/grid:size-8 @max-[57rem]/grid:p-0" disabled={menuDisabled || targets.length !== 1}
                  aria-label="References" title="Inspect references" onClick={() => setReferenceDetails(targets[0] ?? selected)}>
                  <Link2 aria-hidden="true" /><span className="hidden @min-[57rem]/grid:inline">References</span>
                </Button>
              </div>
            </div>
            <div className="col-start-2 row-start-1 flex h-8 w-24 items-center justify-end gap-1 whitespace-nowrap text-xs text-muted-foreground @max-[32rem]/grid:w-16">
              <span aria-live="polite" title={targets.length ? selectionCount + ' selected' : undefined} className="tabular-nums">
                {targets.length > 0 && <>{selectionCount}<span className="sr-only @min-[32rem]/grid:not-sr-only"> selected</span></>}
              </span>
              {targets.length > 0 && <Button type="button" size="icon-xs" variant="ghost" aria-label="Clear selection" title="Clear selection" disabled={menuDisabled}
                onClick={() => selectRows([], '')}><X aria-hidden="true" /></Button>}
            </div>
            <div className="col-span-2 row-start-2 flex min-w-0 items-center gap-1.5 @min-[49rem]/grid:col-span-1 @min-[49rem]/grid:col-start-3 @min-[49rem]/grid:row-start-1 @min-[49rem]/grid:justify-end">
              <div className="relative min-w-0 max-w-[300px] flex-1">
                <Search className="pointer-events-none absolute start-2.5 top-2 size-4 text-muted-foreground" aria-hidden="true" />
                <Input type="search" className="h-8 ps-8" aria-label="Search tokens in group" placeholder="Search tokens" title={group ? 'Search in ' + group : 'Search all tokens'} value={query}
                  disabled={menuDisabled} onChange={(event) => { setQuery(event.target.value); setPage(0); select(''); resetScroll(); }} />
              </div>
              <Button type="button" size="sm" className="w-32 shrink-0 tabular-nums @min-[32rem]/grid:w-36" variant={showOnlyUnresolved ? 'secondary' : 'outline'}
                aria-pressed={showOnlyUnresolved} disabled={menuDisabled || unresolvedCount === 0} onClick={() => {
                  setOnlyUnresolved(!showOnlyUnresolved);
                  setPage(0);
                  select('');
                  resetScroll();
                }}><AlertCircle aria-hidden="true" /> Unresolved ({unresolvedCount})</Button>
            </div>
          </section>
          <div ref={grid} aria-busy={busy} className="min-h-0 flex-1 [&>[data-slot=table-container]]:h-full [&>[data-slot=table-container]]:overflow-auto">
            <TokenGrid {...{ rows, graph, group, selected, checked, toggle, toggleRow, selectRows, select, edit, draft, setDraft, busy, cancel, commit, error }} />
          </div>
          <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-xs text-muted-foreground">
            {group && !treeVisible && <span className="max-w-28 truncate" title={group}>{group}</span>}
            <span>{filtered.length.toLocaleString('en')} {filtered.length === 1 ? 'token' : 'tokens'}</span>
            {draft && !draft.create && draft.mode === 'inline' && error ?
              <output id="inline-edit-error" role="alert" className="text-destructive">{error}</output> :
              <output>{busy ? 'Working…' : status || (dirty ? 'Unsaved changes' : '')}</output>}
            {graph.extendedGroups > 0 && <span title="The document retains these declarations when downloaded.">Group extensions are shown as authored.</span>}
            <div className="ms-auto flex items-center gap-2">
              <Button size="icon-xs" variant="ghost" aria-label="Previous page" disabled={page === 0 || !!draft}
                onClick={() => { setPage(page - 1); select(''); resetScroll(); }}><ChevronLeft aria-hidden="true" /></Button>
              <span>Page {page + 1} of {pages}</span>
              <Button size="icon-xs" variant="ghost" aria-label="Next page" disabled={page + 1 === pages || !!draft}
                onClick={() => { setPage(page + 1); select(''); resetScroll(); }}><ChevronRight aria-hidden="true" /></Button>
            </div>
          </footer>
        </main>
      </div>
    <Dialog open={importChanges} onOpenChange={(open) => {
      if (!busy && !open) { setImportChanges(false); setError(''); }
    }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Import value changes</DialogTitle>
          <DialogDescription>
            Choose a file with edits to the tokens you have open. You’ll review the changes before applying them.
          </DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription className="max-h-36 overflow-auto whitespace-pre-wrap">{error}</AlertDescription></Alert>}
        <div className="flex justify-end">
          <Button type="button" disabled={busy} onClick={() => proposalInput.current?.click()}>Choose file…</Button>
        </div>
      </DialogContent>
    </Dialog>
    {relocate && <MoveDialog {...relocate} graph={graph} close={() => setRelocate(null)}
      review={(moves) => { setError(''); setReview(reviewMoves(data, moves)); }} />}
    {referenceDetails && <ReferenceDetails path={referenceDetails} graph={graph} close={() => setReferenceDetails('')} jump={jump} />}
    {draft?.create && !review && <Dialog open onOpenChange={(open) => { if (!open) cancel(); }}>
      <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft.groupOnly ? 'New group' : 'New token'}</DialogTitle>
          <DialogDescription className="wrap-anywhere">{group || 'Top level'}</DialogDescription>
        </DialogHeader>
        <TokenEditForm {...{ draft, graph, setDraft, busy, cancel, error }} commit={() => { commit(); }} />
      </DialogContent>
    </Dialog>}
    <ReviewChanges {...{ review, busy, error }} close={closeReview} save={saveReview} />
    <ReviewChanges review={finalReview} busy={busy} error={error}
      notice={revisionReview === 'stale' ? 'The default branch changed. Review the latest revision before opening a pull request.' :
        revisionReview === 'refreshed' ? 'This diff and its resolved values use the latest revision.' : ''}
      confirm={revisionReview === 'stale' ? 'Review latest revision' : saveTarget?.kind === 'folder' ? 'Save to folder' : saveTarget ? 'Open pull request' : 'Download patch'}
      close={() => { setFinalReview(null); setError(''); }} save={() => { void saveFinalReview(); }} />
  </div>;
}

const app = document.getElementById('app');
if (!app) throw new Error('Missing editor root.');
const fragment = location.hash;
const proposalLink = fragment.startsWith('#proposal=') && fragment.length <= 8010 ? new URLSearchParams(fragment.slice(1)).get('proposal') ?? '' : '';
if (fragment.startsWith('#proposal=')) history.replaceState(history.state, '', location.pathname + location.search);
createRoot(app).render(<StrictMode>
  <Editor Connector={import.meta.env.MODE === 'hosted' ? OpenGitHub : null} proposalLink={proposalLink} />
</StrictMode>);
