import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { errorMessage, requireValue } from '../lib/json.ts';
import type { TokenNode } from '../lib/token-types.ts';
import { reviewEdit, reviewMove, reviewProposal, reviewWorkspace, workspaceChanges } from '../lib/workspace.ts';
import type { Review, Workspace } from '../lib/workspace.ts';
import type { Draft } from './lib/draft.ts';
import type { SubmitWorkspace, WorkspaceConnectorProps } from './lib/connector.ts';
import { OpenGitHub } from '../integrations/github/connect.tsx';
import { createRoot } from 'react-dom/client';
import { ArrowDownToLine, ChevronLeft, ChevronRight, FileUp, FolderOpen, FolderPlus, Link2, PanelLeft, Pencil, Plus, Search } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ReviewChanges } from './review-dialog.tsx';
import { MoveDialog } from './move-dialog.tsx';
import { FolderTree } from './folder-tree';
import { TokenGrid, types } from './token-grid';
import { displayInput, readInput } from './lib/token-input';
import { parentPath } from '../lib/document.ts';
import { download, downloadPatch, openExample, openFiles } from './lib/sources.ts';
import './shadcn.css';

const pageSize = 100;

function Editor({ Connector, proposalLink }: { Connector: ComponentType<WorkspaceConnectorProps> | null; proposalLink: string }) {
  const [data, setData] = useState(openExample);
  const [group, setGroup] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [related, setRelated] = useState(false);
  const [mobileTree, setMobileTree] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [publishReview, setPublishReview] = useState<Review | null>(null);
  const [submit, setSubmit] = useState<SubmitWorkspace | null>(null);
  const [submittedUrl, setSubmittedUrl] = useState('');
  const [linkedProposal, setLinkedProposal] = useState(proposalLink);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const proposalInput = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const focusRow = useRef(false);
  const graph = data.graph;
  const folder = requireValue(graph.groups.get(group), 'current group');
  const typeOptions = folder.type ? ['', ...types] : types;
  const search = query.trim().toLowerCase();
  const groupRows = graph.rows.slice(folder.start, folder.end);
  const filtered = search ? groupRows.filter(([path, { type, node }]) =>
    [path, type, node.$description].some((value) => typeof value === 'string' && value.toLowerCase().includes(search))) : groupRows;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const rows = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const active = graph.tokens.get(selected);
  const movePath = active ? selected : group;
  const moveFile = active?.file ?? folder.files.keys().next().value ?? '';

  function activate(next: Workspace) {
    setData(next);
    setGroup('');
    setDirty(false);
    setReview(null);
    setPublishReview(null);
    setSubmit(null);
    setSubmittedUrl('');
    clearSelection();
    setStatus('');
    setError('');
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

  async function loadProposal(file: File) {
    if (draft || review || busy) return;
    setBusy(true);
    setError('');
    try {
      setReview(reviewProposal(data, await file.text()));
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

  useEffect(() => {
    if (!draft && selected && focusRow.current) {
      focusRow.current = false;
      const row = grid.current?.querySelector<HTMLTableRowElement>('[data-token-row][data-state="selected"]');
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [draft, selected]);

  useEffect(() => {
    if (!dirty && !draft) return undefined;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, draft]);

  function clearSelection() {
    setDraft(null);
    setSelected('');
    setRelated(false);
    setPage(0);
    setQuery('');
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

  function select(path: string) {
    setSelected(path);
    setRelated(false);
    setError('');
  }

  function jump(path: string) {
    const parent = parentPath(path);
    const start = requireValue(graph.groups.get(parent), 'parent group').start;
    setGroup(parent);
    setQuery('');
    setPage(Math.floor((graph.rows.findIndex(([id]) => id === path) - start) / pageSize));
    focusRow.current = true;
    select(path);
  }

  function edit(path: string) {
    const token = graph.tokens.get(path);
    if (!token || busy || draft) return;
    select(path);
    setDraft({ path, type: token.type, original: token.value,
      value: displayInput(token.type, token.value), originalDescription: token.node.$description ?? '',
      description: token.node.$description ?? '', create: false });
  }

  function create(groupOnly: boolean) {
    setError('');
    setRelated(false);
    const destinations = [...folder.files.keys()];
    setDraft({ create: true, groupOnly, path: group, name: '', type: typeOptions[0], value: '', description: '',
      file: destinations.length === 1 ? destinations[0] ?? '' : '' });
    resetScroll();
  }

  function cancel() {
    setError('');
    focusRow.current = true;
    setDraft(null);
  }

  function finishChange(next: Workspace, path: string, applied: Draft) {
    setData(next);
    setDirty(true);
    setStatus('Updated in this session.');
    if (applied.groupOnly) selectGroup(path);
    else if (applied.create) {
      setQuery('');
      const index = next.graph.rows.findIndex(([id]) => id === path);
      setPage(Math.floor((index - requireValue(next.graph.groups.get(group), 'current group').start) / pageSize));
      setSelected(path);
    }
    focusRow.current = !applied.groupOnly;
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
      setStatus(review.path ? 'Move applied in this session.' : 'Proposal applied in this session.');
    }
    closeReview();
  }

  function commit() {
    if (!draft || busy || review) return;
    setError('');
    const name = draft.name?.trim();
    if (draft.create && (!name || /[.{}]/u.test(name) || (name.startsWith('$') && (name !== '$root' || draft.groupOnly)))) {
      setError('Enter a name without periods or braces. Only root tokens may use $root.');
      return;
    }
    const path = draft.create ? [group, name].filter(Boolean).join('.') : draft.path;
    const node: TokenNode = {};
    const description = draft.description.trim();
    if (description !== (draft.originalDescription ?? '')) node.$description = description;
    if (!draft.groupOnly) {
      if (draft.create && draft.type) node.$type = draft.type;
      if (draft.create || draft.value !== displayInput(draft.type, draft.original)) {
        try {
          const inherited = draft.create && draft.file ? folder.files.get(draft.file) : folder.type;
          node.$value = readInput(draft.value, draft.type || inherited, draft.original);
        } catch (failure) {
          setError(errorMessage(failure));
          return;
        }
      }
    }
    try {
      const file = draft.create ? draft.file : active?.file;
      if (!file) throw new Error('Choose a destination file for this edit.');
      setReview(reviewEdit(data, file, { path, node, create: draft.create }));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  function canReplace() {
    return !(dirty || draft) || window.confirm('Close this document and discard changes that have not been saved?');
  }

  function reviewForPublish() {
    setError('');
    try {
      setPublishReview(reviewWorkspace(data));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  async function publish() {
    if (!submit || !publishReview || busy) return;
    setBusy(true);
    setError('');
    try {
      const url = await submit(workspaceChanges(publishReview.next));
      setSubmittedUrl(url);
      setPublishReview(null);
      setDirty(false);
      setStatus('Pull request opened.');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex h-dvh flex-col overflow-hidden text-sm">
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <Button size="icon-sm" variant="ghost" className="md:hidden" type="button" aria-label="Token groups"
        aria-controls="groups" aria-expanded={mobileTree} disabled={!!draft} onClick={() => setMobileTree((open) => !open)}>
        <PanelLeft aria-hidden="true" />
      </Button>
      <h1 className="me-1 font-semibold">Token Editor</h1>
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
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => fileInput.current?.click()}>
        <FileUp aria-hidden="true" /> Open files
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => {
        folderInput.current?.setAttribute('webkitdirectory', '');
        folderInput.current?.click();
      }}>
        <FolderOpen aria-hidden="true" /> Open folder
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => {
        if (canReplace()) activate(openExample());
      }}>Open example</Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy || !!draft} onClick={() => proposalInput.current?.click()}>
        Open proposal
      </Button>
      {Connector && <Connector disabled={busy || !!draft} canReplace={canReplace} connect={(workspace, publishWorkspace) => {
        activate(workspace);
        setSubmit(() => publishWorkspace);
      }} />}
      <div className="ms-auto flex flex-wrap gap-2">
        {data.files.length === 1 && <Button size="sm" variant="outline" disabled={busy || !!draft} onClick={() => {
          const file = requireValue(data.files[0], 'open file');
          download(file.path, file.text, 'application/json');
          setDirty(false);
        }}><ArrowDownToLine aria-hidden="true" /> Download JSON</Button>}
        <Button size="sm" variant="outline" disabled={busy || !!draft || !workspaceChanges(data).length} onClick={() => {
          downloadPatch(data);
          setStatus('Patch download requested.');
        }}><ArrowDownToLine aria-hidden="true" /> Download patch</Button>
        {submit && <Button size="sm" disabled={busy || !!draft || !dirty || !workspaceChanges(data).length} onClick={reviewForPublish}>
          Review for pull request
        </Button>}
        {submittedUrl && <Button size="sm" variant="link" asChild><a href={submittedUrl} target="_blank" rel="noreferrer">View pull request</a></Button>}
      </div>
    </header>
    {linkedProposal && <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <p className="me-auto">A proposal is ready. Open its token workspace before reviewing it.</p>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setLinkedProposal('')}>Dismiss proposal</Button>
      <Button size="sm" disabled={busy || !!draft} onClick={reviewLinkedProposal}>Review linked proposal</Button>
    </div>}
    {error && !review && !publishReview && <Alert variant="destructive" className="shrink-0 rounded-none border-x-0">
      <AlertDescription className="max-h-32 overflow-auto whitespace-pre-wrap">{error}</AlertDescription>
    </Alert>}
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside id="groups" aria-label="Groups" className={(mobileTree ? 'block' : 'hidden') + ' max-h-56 w-full shrink-0 overflow-auto border-b bg-muted/20 md:block md:max-h-none md:w-56 md:border-e md:border-b-0 lg:w-64'}>
          <h2 className="sticky top-0 z-10 truncate border-b bg-background px-3 py-2 text-xs font-medium" title={data.name}>{data.name} · {data.files.length} files</h2>
          <fieldset disabled={!!draft || busy}>
            <FolderTree key={data.name} graph={graph} current={group} select={selectGroup} />
          </fieldset>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b p-2">
            <h2 className="min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap px-1 font-medium" title={group}>{group || 'All tokens'}</h2>
            <div className="relative me-auto w-52 min-w-0 max-w-full">
              <Search className="pointer-events-none absolute start-2.5 top-2 size-4 text-muted-foreground" aria-hidden="true" />
              <Input type="search" className="h-8 ps-8" aria-label="Search tokens in group" placeholder="Search tokens" value={query}
                disabled={!!draft || busy} onChange={(event) => { setQuery(event.target.value); setPage(0); select(''); resetScroll(); }} />
            </div>
            {draft ? <>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={cancel}>Cancel</Button>
              <Button type="button" size="sm" disabled={busy} onClick={commit}>Review changes</Button>
            </> : <>
              <Button type="button" size="sm" variant="ghost" disabled={!active || busy } onClick={() => edit(selected)}><Pencil aria-hidden="true" /> Edit</Button>
              <Button type="button" size="sm" variant={related ? 'secondary' : 'ghost'} aria-pressed={related}
                disabled={!active} onClick={() => setRelated(!related)}><Link2 aria-hidden="true" /> References</Button>
              <MoveDialog path={movePath} originalFile={moveFile} files={data.files.map(({ path }) => path)} disabled={busy || !movePath}
                review={(move) => { setError(''); setReview(reviewMove(data, move)); }} />
              <Button type="button" size="sm" variant="outline" disabled={busy || !typeOptions.length} onClick={() => create(true)}><FolderPlus aria-hidden="true" /> New group</Button>
              <Button type="button" size="sm" disabled={busy || !typeOptions.length} onClick={() => create(false)}><Plus aria-hidden="true" /> New token</Button>
            </>}
          </div>
          <div ref={grid} aria-busy={busy} className="min-h-0 flex-1 [&>[data-slot=table-container]]:h-full [&>[data-slot=table-container]]:overflow-auto">
            <TokenGrid {...{ rows, graph, group, selected, select, edit, draft, setDraft, typeOptions, related, jump, busy }}
              destinations={draft?.create ? [...folder.files.keys()] : []}
              onEditKey={(event) => {
                if (event.key === 'Escape' && !busy) { event.preventDefault(); cancel(); }
                if (event.key === 'Enter' && (!(event.target instanceof HTMLTextAreaElement) || event.ctrlKey || event.metaKey)) {
                  event.preventDefault(); commit();
                }
              }} />
          </div>
          <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-xs text-muted-foreground">
            <span>{filtered.length.toLocaleString('en')} {filtered.length === 1 ? 'token' : 'tokens'}</span>
            <output>{busy ? 'Working…' : status || (dirty ? 'Unsaved changes' : '')}</output>
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
    <ReviewChanges {...{ review, busy, error }} close={closeReview} save={saveReview} />
    <ReviewChanges review={publishReview} busy={busy} error={error} confirm="Open pull request"
      close={() => { setPublishReview(null); setError(''); }} save={() => { void publish(); }} />
  </div>;
}

const app = document.getElementById('app');
if (!app) throw new Error('Missing editor root.');
const fragment = location.hash;
const proposalLink = fragment.startsWith('#proposal=') && fragment.length <= 8010 ? new URLSearchParams(fragment.slice(1)).get('proposal') ?? '' : '';
if (fragment.startsWith('#proposal=')) history.replaceState(history.state, '', location.pathname + location.search);
createRoot(app).render(<Editor Connector={import.meta.env.MODE === 'hosted' ? OpenGitHub : null} proposalLink={proposalLink} />);
