import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  Button,
  ButtonLink,
  Card,
  Disclosure,
  IconButton,
  List,
  ListItemButton,
  Progress,
  Select,
  SelectOption,
  TextArea,
  TextField,
} from '@token-catalog/forge-react';
import { MoreHorizontal, Pencil, Search, Trash2, X } from 'lucide-react';
import { CommandMenu } from './command-bar.tsx';
import { ActionDialog } from './components/ui/dialog.tsx';
import { Alert, AlertDescription } from './components/ui/alert.tsx';
import type { FileChange, TokenBaselineChange, Workspace } from '../lib/workspace.ts';
import type { SourceFileAction } from './source-file-dialog.tsx';
import type { useSharedWorkspace } from './lib/shared-workspace.ts';
import { workspaceRequest } from '../integrations/workspace/client.ts';
import { isBundle, isTokenProposal, sameSourceValue } from '../integrations/figma/contract.ts';
import { isPullConflict } from '../integrations/figma/merge.ts';
import type { FigmaBundle, TokenProposal } from '../integrations/figma/contract.ts';
import type { PullChoice, PullConflict } from '../integrations/figma/merge.ts';
import { ConflictReview } from '../integrations/figma/conflict-review.tsx';
import { errorMessage, isRecord, isUnknownArray } from '../lib/json.ts';
import { isIdentity } from '../integrations/workspace/model.ts';
import { readPairing } from '../integrations/workspace/pairing.ts';
import { conflictInputKind, isConflictDraft } from '../integrations/figma/recovery.ts';
import type { ConflictDraft } from '../integrations/figma/recovery.ts';
import type { WorkspaceView } from '../integrations/workspace/model.ts';
import { describeTokenValue } from './token-value.tsx';
import { sameIncomingReview } from './lib/figma-review.ts';
import type { IncomingReviewRecovery, PreparedIncomingInput } from './lib/figma-review.ts';

interface IncomingRecoveryProps {
  retained: IncomingReviewRecovery[];
  remember: (entry: IncomingReviewRecovery) => void;
  forget: (entry: IncomingReviewRecovery) => void;
  prepareInput: (entry: IncomingReviewRecovery, draft: ConflictDraft) => (() => Promise<PreparedIncomingInput>) | undefined;
}

type Shared = ReturnType<typeof useSharedWorkspace>;
export type WorkspaceSaveMode = 'pull-request' | 'pull-request-update' | 'folder' | 'patch';

function targetSummary(saveMode: WorkspaceSaveMode, repository?: { repository: string; branch?: string }) {
  if ((saveMode === 'pull-request' || saveMode === 'pull-request-update') && repository) {
    return `GitHub merge request · ${repository.repository} · ${repository.branch ?? 'new branch on save'}`;
  }
  if (saveMode === 'folder') return 'Local folder · saves directly to disk.';
  return 'Standalone draft · exports as .patch. Open a GitHub repository below to create merge requests.';
}

function fileStatus(file: WorkspaceView['documents'][number], revision: string) {
  if (!file.expires) return 'No connected device';
  const connections = file.connections;
  if (!connections?.length) return file.baseline === revision ? 'Up to date' : 'Source updates available';
  const current = connections.filter(item => item.baseline === revision).length;
  return current === connections.length
    ? `Up to date · ${connections.length} device ${connections.length === 1 ? 'connection' : 'connections'}`
    : `${current} of ${connections.length} device connections up to date`;
}

export function SourceBrowser({ data, disabled, open, action }: {
  data: Workspace;
  disabled: boolean;
  open: (file: string) => void;
  action: (action: SourceFileAction) => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const files = data.files.filter(file => file.path.toLowerCase().includes(query.toLowerCase()));
  const last = Math.max(0, Math.ceil(files.length / 8) - 1);
  const current = Math.min(page, last);

  return <Card
    variant="outlined"
    as="section"
    aria-label="Source files"
    headline="Source files"
    headlineAs="h3"
    supporting={`${data.files.length} ${data.files.length === 1 ? 'file' : 'files'} in this draft`}
    actions={
      <Button size="small" variant="tonal" disabled={disabled} data-new-source data-key-tip="N" onClick={() => action({ kind: 'create' })}>
        New source file
      </Button>
    }
  >
    <TextField
      type="search"
      label="Find source file"
      containerClassName="search-fill"
      leading={<Search aria-hidden="true" />}
      trailing={query ? (
        <IconButton size="xsmall" label="Clear source search" onClick={() => { setQuery(''); setPage(0); }}>
          <X aria-hidden="true" />
        </IconButton>
      ) : undefined}
      value={query}
      onChange={event => { setQuery(event.target.value); setPage(0); }}
    />
    <List>
      {files.slice(current * 8, current * 8 + 8).map(file => (
        <li key={file.path}>
          <ListItemButton
            disabled={disabled}
            data-source-file={file.path}
            onClick={() => open(file.path)}
            actions={
              <CommandMenu
                label={`Actions for ${file.path}`}
                icon={<MoreHorizontal />}
                disabled={disabled}
                sections={[
                  [{ label: 'Rename or move…', icon: <Pencil />, run: () => action({ kind: 'relocate', file: file.path }) }],
                  [{ label: 'Remove file…', icon: <Trash2 />, destructive: true, disabled: data.files.length < 2, run: () => action({ kind: 'remove', file: file.path }) }],
                ]}
              />
            }
          >
            <code className="truncate" title={file.path}>{file.path}</code>
          </ListItemButton>
        </li>
      ))}
    </List>
    {!files.length && <p className="copy-body tone-supporting">No matching source files.</p>}
    {last > 0 && (
      <div className="flex items-center justify-end gap-space100 copy-small">
        <Button variant="text" size="xsmall" disabled={!current} onClick={() => setPage(current - 1)}>Previous files</Button>
        <span>{current * 8 + 1}–{Math.min(current * 8 + 8, files.length)} of {files.length}</span>
        <Button variant="text" size="xsmall" disabled={current === last} onClick={() => setPage(current + 1)}>Next files</Button>
      </div>
    )}
  </Card>;
}

export function WorkspaceStatus({ shared, saveMode, repository, start, remove, disabled }: {
  shared: Shared;
  saveMode: WorkspaceSaveMode;
  repository?: { repository: string; branch?: string } | undefined;
  start: () => void;
  remove?: (() => Promise<void>) | undefined;
  disabled: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const summary = shared.view
    ? shared.phase === 'saved'
      ? 'Saved to workspace. Linked Figma files use this draft.'
      : shared.phase === 'saving'
        ? 'Saving changes to workspace…'
        : shared.phase === 'offline'
          ? 'Offline. Local draft stays saved until reconnected.'
          : 'Review pending changes before sharing updates.'
    : 'Stored in this browser. Start a shared workspace to connect Figma or collaborate.';

  return <Card
    variant="outlined"
    as="section"
    aria-label="Workspace storage"
    headline="Workspace sync"
    headlineAs="h3"
    supporting={summary}
    actions={<>
      <Button size="small" variant="outlined" disabled={disabled || deleting || !shared.hosted || shared.phase === 'saving'} onClick={shared.view ? () => { void shared.sync(); } : start}>
        {shared.view ? 'Check for updates' : 'Start shared workspace'}
      </Button>
      {shared.view && remove && (
        <Button size="small" variant="text" disabled={disabled || deleting} onClick={() => { setDeleteError(''); setConfirmOpen(true); }}>
          Delete workspace
        </Button>
      )}
    </>}
  >
    <p className="copy-small tone-supporting">{targetSummary(saveMode, repository)}</p>
    {shared.problem && <Alert variant="destructive"><AlertDescription>{shared.problem}</AlertDescription></Alert>}
    {shared.view?.repository && <p className="copy-small tone-supporting">Shared with write contributors to {shared.view.repository.repository} on GitHub.</p>}
    {!shared.hosted && <p className="copy-small tone-supporting">Shared workspaces are available in the hosted editor.</p>}
    {shared.view && remove && (
      <ActionDialog
        title="Delete workspace"
        open={confirmOpen}
        busy={deleting}
        onOpenChange={next => { if (!deleting) setConfirmOpen(next); }}
        description={`Delete "${shared.view.name}" from shared storage? Linked Figma files lose access immediately. Existing GitHub merge requests are unaffected.`}
      >
        <div className="grid gap-space150">
          {deleteError && <Alert variant="destructive"><AlertDescription>{deleteError}</AlertDescription></Alert>}
          <div className="flex justify-end gap-space100">
            <Button variant="text" disabled={deleting} data-dialog-close="">Cancel</Button>
            <Button
              disabled={deleting}
              onClick={() => {
                setDeleting(true);
                setDeleteError('');
                void remove()
                  .then(() => setConfirmOpen(false))
                  .catch((error: unknown) => setDeleteError(errorMessage(error)))
                  .finally(() => setDeleting(false));
              }}
            >
              {deleting ? 'Deleting…' : 'Delete workspace'}
            </Button>
          </div>
        </div>
      </ActionDialog>
    )}
  </Card>;
}

export function FigmaWorkspace({ shared, ensureShared, disabled, changes, downloadSnapshot, resume, onDelete }: {
  shared: Shared;
  ensureShared: () => Promise<WorkspaceView>;
  disabled: boolean;
  changes: () => void;
  downloadSnapshot: () => Promise<void>;
  resume: (id: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}) {
  const lifetime = useRef({ active: true });
  const [role, setRole] = useState('library');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(() => readPairing(window.location.hash));
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    lifetime.current = { active: true };
    const hide = () => { lifetime.current.active = false; };
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) {
        lifetime.current = { active: true };
        setBusy(false);
      }
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      lifetime.current.active = false;
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, []);

  const pairedRole = shared.view?.documents.find(file => file.id === pairing?.document)?.role;
  useEffect(() => {
    const update = () => {
      if (!lifetime.current.active) return;
      lifetime.current.active = false;
      lifetime.current = { active: true };
      setBusy(false);
      setProblem('');
      setCode('');
      setCopied(false);
      setPairing(readPairing(window.location.hash));
      setApproved(false);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  async function startWorkspace() {
    const operation = lifetime.current;
    const active = () => operation === lifetime.current && operation.active;
    setBusy(true);
    setProblem('');
    try {
      await ensureShared();
    } catch (error) {
      if (active()) setProblem(errorMessage(error));
    } finally {
      if (active()) setBusy(false);
    }
  }

  async function approve() {
    if (!pairing) return;
    const operation = lifetime.current;
    const active = () => operation === lifetime.current && operation.active;
    setBusy(true);
    setProblem('');
    try {
      const target = shared.view ?? await ensureShared();
      const targetRole = target.documents.find(file => file.id === pairing.document)?.role ?? role;
      await workspaceRequest(`/${target.id}/pair`, 'POST', { ...pairing, role: targetRole });
      if (!active()) return;
      setApproved(true);
      history.replaceState(null, '', window.location.pathname + window.location.search);
      await shared.sync();
    } catch (error) {
      if (active()) setProblem(errorMessage(error));
    } finally {
      if (active()) setBusy(false);
    }
  }

  async function createInvite() {
    if (!shared.view) return;
    const operation = lifetime.current;
    const active = () => operation === lifetime.current && operation.active;
    setBusy(true);
    setProblem('');
    setCode('');
    setCopied(false);
    try {
      const result = await workspaceRequest(`/${shared.view.id}/invites`, 'POST', { role });
      if (!active()) return;
      if (typeof result['code'] !== 'string') throw new Error('The pairing code could not be created.');
      setCode(result['code']);
    } catch (error) {
      if (active()) setProblem(errorMessage(error));
    } finally {
      if (active()) setBusy(false);
    }
  }

  async function revoke(documentId: string, grant?: string) {
    if (!shared.view) return;
    const operation = lifetime.current;
    const active = () => operation === lifetime.current && operation.active;
    setBusy(true);
    setProblem('');
    try {
      await workspaceRequest(`/${shared.view.id}/revoke`, 'POST', { document: documentId, ...(grant ? { grant } : {}) });
      if (active()) await shared.sync();
    } catch (error) {
      if (active()) setProblem(errorMessage(error));
    } finally {
      if (active()) setBusy(false);
    }
  }

  return <main id="workspace-figma" tabIndex={-1} className="workspace-management" aria-label="Figma" aria-busy={busy}>
    <div className="workspace-management-content">
      <header className="workspace-management-header">
        <div>
          <h2>Figma</h2>
          <p className="copy-body tone-supporting">Link your token library file and any concept files that consume its shared tokens.</p>
        </div>
      </header>

      <div className="card-group">
      {pairing && !approved && (
        <Card
          variant="outlined"
          as="section"
          aria-label="Approve Figma connection"
          headline={`Connect ${pairing.name}`}
          headlineAs="h3"
          supporting={shared.view
            ? `Allow access to ${shared.view.name} and pick how this file uses shared tokens.`
            : shared.hosted
              ? 'Creates a shared workspace from this draft and links this Figma file.'
              : 'Live Figma pairing is available in the hosted editor.'}
          actions={
            <Button disabled={!shared.hosted || busy || disabled} onClick={() => { void approve(); }}>
              Connect to this workspace
            </Button>
          }
        >
          <Select id="pairing-role" label="File role" value={pairedRole ?? role} disabled={!!pairedRole || busy} onChange={event => setRole(event.target.value)}>
            <SelectOption value="library">Library — edit shared tokens</SelectOption>
            <SelectOption value="concept">Concept — use shared tokens</SelectOption>
          </Select>
        </Card>
      )}

      {!shared.view && !pairing && (
        <Card
          variant="outlined"
          headline={shared.hosted ? 'Connect Figma to a shared workspace' : 'Hosted editor required for live sync'}
          supporting={shared.hosted
            ? 'Start a shared workspace from this draft or open an existing workspace below.'
            : 'Live Figma pairing is available in the hosted editor. Figma snapshots remain available.'}
          actions={shared.hosted ? (
            <Button size="small" disabled={busy || disabled || shared.phase === 'saving'} onClick={() => { void startWorkspace(); }}>
              Create shared workspace
            </Button>
          ) : undefined}
        />
      )}

      {!shared.view && shared.hosted && <WorkspaceList framed open={resume} onDelete={onDelete} current={undefined} />}

      {approved && <Alert><AlertDescription>Connected. Return to Figma to continue.</AlertDescription></Alert>}
      {problem && <Alert variant="destructive"><AlertDescription>{problem}</AlertDescription></Alert>}

      {shared.view && <>
        <Card
          variant="outlined"
          as="section"
          aria-label="Linked Figma files"
          headline="Linked files"
          headlineAs="h3"
          actions={
            <Button variant="text" size="small" onClick={changes}>
              Review workspace changes{shared.view.incoming.length ? ` (${shared.view.incoming.length})` : ''}
            </Button>
          }
        >
          {!shared.view.documents.length && (
            <p className="copy-body tone-supporting">No Figma files linked yet. Open the Foundry plugin in a Figma file and choose Connect workspace.</p>
          )}
          {!!shared.view.documents.length && (
            <div className="grid gap-space150">
              {shared.view.documents.map(file => (
                <div key={file.id} className="grid gap-space100">
                  <div className="flex flex-wrap items-center justify-between gap-space100">
                    <div>
                      <p className="copy-emphasis">{file.name}</p>
                      <p className="copy-small tone-supporting">
                        {file.role === 'library' ? 'Library · edits shared tokens' : 'Concept · uses shared tokens'} · {fileStatus(file, shared.view?.draft.revision ?? '')}
                      </p>
                    </div>
                    <Button variant="text" size="small" disabled={busy || !file.expires} onClick={() => { void revoke(file.id); }}>
                      Revoke all device access
                    </Button>
                  </div>
                  {!!file.connections?.length && (
                    <Disclosure compact label={`Manage connections (${file.connections.length})`}>
                      <List>
                        {file.connections.map(connection => (
                          <li key={connection.id}>
                            <ListItemButton
                              disabled={busy}
                              supporting={`Expires ${new Date(connection.expires).toLocaleTimeString()}`}
                              actions={
                                <Button variant="text" size="xsmall" disabled={busy} onClick={() => { void revoke(file.id, connection.id); }}>
                                  Revoke connection
                                </Button>
                              }
                            >
                              {connection.created ? `Connected ${new Date(connection.created).toLocaleString()}` : 'Existing connection'}
                            </ListItemButton>
                          </li>
                        ))}
                      </List>
                    </Disclosure>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          variant="outlined"
          as="section"
          aria-label="Connect Figma file"
          headline="Connect a file"
          headlineAs="h3"
          supporting="Open the Foundry plugin in Figma and choose Connect workspace. Use a pairing code when browser pairing is unavailable."
        >
          <Disclosure label="Manual connection">
            <form className="margin-top-space150 grid gap-space150" onSubmit={event => { event.preventDefault(); void createInvite(); }}>
              <Select id="figma-file-role" label="File role" value={role} onChange={event => setRole(event.target.value)}>
                <SelectOption value="library">Library — edit shared tokens</SelectOption>
                <SelectOption value="concept">Concept — use shared tokens</SelectOption>
              </Select>
              <div>
                <Button type="submit" disabled={busy || disabled}>Create pairing code</Button>
              </div>
              {code && (
                <div className="grid gap-space100">
                  <TextArea
                    label="One-time pairing code"
                    value={code}
                    readOnly
                    rows={3}
                    supporting="Paste into the plugin under Workspace → Connect with a code. Expires in 10 minutes."
                  />
                  <div>
                    <Button
                      type="button"
                      variant="text"
                      size="small"
                      onClick={() => {
                        void navigator.clipboard.writeText(code).then(
                          () => setCopied(true),
                          () => setProblem('Select and copy the pairing code.'),
                        );
                      }}
                    >
                      {copied ? 'Copied pairing code' : 'Copy pairing code'}
                    </Button>
                  </div>
                </div>
              )}
            </form>
          </Disclosure>
        </Card>
      </>}

      <Card
        variant="outlined"
        as="section"
        aria-label="Figma snapshot"
        headline="Figma snapshot"
        headlineAs="h3"
        supporting="Download a snapshot file to import into the Figma plugin without a live workspace connection."
        actions={
          <Button
            variant="outlined"
            size="small"
            disabled={busy || disabled}
            onClick={() => {
              const operation = lifetime.current;
              const active = () => operation === lifetime.current && operation.active;
              setBusy(true);
              setProblem('');
              void downloadSnapshot()
                .catch((error: unknown) => { if (active()) setProblem(errorMessage(error)); })
                .finally(() => { if (active()) setBusy(false); });
            }}
          >
            Download Figma snapshot
          </Button>
        }
      />
      </div>
    </div>
  </main>;
}

export function WorkspaceName({ shared, disabled }: { shared: Shared; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [before, setBefore] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  return <>
    <IconButton label="Rename workspace" size="small" disabled={disabled || !shared.view} onClick={() => { setBefore(shared.view?.name ?? ''); setName(shared.view?.name ?? ''); setProblem(''); setOpen(true); }}><Pencil /></IconButton>
    <ActionDialog title="Name workspace" open={open} busy={busy} onOpenChange={next => { if (!busy) setOpen(next); }}>
      <form className="grid gap-space150" onSubmit={event => {
        event.preventDefault();
        if (!shared.view || busy) return;
        setBusy(true);
        setProblem('');
        void workspaceRequest(`/${shared.view.id}/name`, 'POST', { before, name })
          .then(async () => { await shared.sync(); setOpen(false); return undefined; })
          .catch((error: unknown) => setProblem(errorMessage(error)))
          .finally(() => setBusy(false));
      }}>
        <TextField label="Workspace name" value={name} maxLength={120} required disabled={busy} onChange={event => setName(event.target.value)} supporting="Use a distinct name for each branch or experiment." />
        {problem && <Alert variant="destructive"><AlertDescription>{problem}</AlertDescription></Alert>}
        <div className="flex justify-end gap-space100">
          <Button variant="text" disabled={busy} data-dialog-close="">Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save name'}</Button>
        </div>
      </form>
    </ActionDialog>
  </>;
}

interface WorkspaceEntry { id: string; name: string; repository?: string; branch?: string; pullRequest?: string; updated?: number }
const isEntry = (value: unknown): value is WorkspaceEntry =>
  isRecord(value) &&
  isIdentity(value['id']) &&
  typeof value['name'] === 'string' &&
  ['repository', 'branch', 'pullRequest'].every(key => value[key] === undefined || typeof value[key] === 'string') &&
  (value['updated'] === undefined || (typeof value['updated'] === 'number' && Number.isFinite(value['updated'])));

export function WorkspaceList({ current, repository, open, onDelete, framed = false }: {
  current: string | undefined;
  repository?: string | undefined;
  open: (id: string) => Promise<void>;
  onDelete?: ((id: string) => Promise<void>) | undefined;
  framed?: boolean;
}) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [discovery, setDiscovery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    const channel = new BroadcastChannel('token-foundry-github');
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.data === 'ready') {
        setLoading(true);
        setRefresh(version => version + 1);
      }
    });
    return () => channel.close();
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      workspaceRequest('?refresh=' + refresh),
      ...(repository ? [workspaceRequest('?repository=' + encodeURIComponent(repository))] : []),
    ]).then(results => {
      const gathered = new Map<string, WorkspaceEntry>();
      let issue = '';
      let notice = '';
      for (const result of results) {
        if (result.status === 'rejected') {
          issue = errorMessage(result.reason);
          continue;
        }
        const values = result.value['workspaces'];
        if (!isUnknownArray(values) || !values.every(isEntry)) {
          issue = 'The workspace list is incomplete.';
          continue;
        }
        if (['sign-in', 'partial'].includes(String(result.value['repositoryDiscovery']))) notice = String(result.value['repositoryDiscovery']);
        for (const entry of values) gathered.set(entry.id, entry);
      }
      if (active) {
        setEntries([...gathered.values()]);
        setProblem(issue);
        setDiscovery(notice);
        setLoading(false);
      }
      return undefined;
    });
    return () => { active = false; };
  }, [repository, refresh]);

  const found = entries.filter(entry => (entry.name + ' ' + (entry.repository ?? '')).toLowerCase().includes(query.toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(found.length / 6) - 1));

  const content = <div className="grid gap-space150" aria-busy={!framed ? undefined : loading}>
    {onDelete && pendingDelete && (
      <Card
        variant="outlined"
        as="section"
        aria-label="Confirm workspace deletion"
        headline="Delete workspace"
        headlineAs="h3"
        supporting={`Delete "${pendingDelete.name}" from shared storage? Linked Figma files lose access immediately. Existing GitHub merge requests are unaffected.`}
        actions={<>
          <Button variant="text" size="small" disabled={deleting} onClick={() => setPendingDelete(null)}>Cancel</Button>
          <Button
            size="small"
            disabled={deleting}
            onClick={() => {
              const target = pendingDelete;
              setDeleting(true);
              setDeleteError('');
              void onDelete(target.id)
                .then(() => {
                  setEntries(currentEntries => currentEntries.filter(item => item.id !== target.id));
                  setPendingDelete(null);
                  return undefined;
                })
                .catch((error: unknown) => setDeleteError(errorMessage(error)))
                .finally(() => setDeleting(false));
            }}
          >
            {deleting ? 'Deleting…' : 'Delete workspace'}
          </Button>
        </>}
      >
        {deleteError && <Alert variant="destructive"><AlertDescription>{deleteError}</AlertDescription></Alert>}
      </Card>
    )}
    {(entries.length > 0 || query.length > 0) && (
      <TextField
        type="search"
        label="Find workspace"
        containerClassName="search-fill"
        leading={<Search aria-hidden="true" />}
        trailing={query ? (
          <IconButton size="xsmall" label="Clear workspace search" onClick={() => { setQuery(''); setPage(0); }}>
            <X aria-hidden="true" />
          </IconButton>
        ) : undefined}
        value={query}
        onChange={event => { setQuery(event.target.value); setPage(0); }}
      />
    )}
    {loading && <Progress label="Loading workspaces" />}
    {found.length > 0 && (
      <List>
        {found.slice(currentPage * 6, currentPage * 6 + 6).map(entry => (
          <li key={entry.id}>
            <ListItemButton
              disabled={busy || loading || deleting || entry.id === current}
              supporting={(entry.repository ?? 'Standalone draft (patch export)') + (entry.pullRequest ? ' · Linked merge request' : '') + (entry.updated ? ' · Updated ' + new Date(entry.updated).toLocaleString() : '')}
              actions={onDelete ? (
                <IconButton
                  label="Delete workspace"
                  title={`Delete ${entry.name}`}
                  size="xsmall"
                  disabled={busy || loading || deleting}
                  onClick={() => { setPendingDelete(entry); setDeleteError(''); }}
                >
                  <Trash2 aria-hidden="true" />
                </IconButton>
              ) : undefined}
              onClick={() => {
                setBusy(true);
                void open(entry.id).catch((error: unknown) => setProblem(errorMessage(error))).finally(() => setBusy(false));
              }}
            >
              {entry.name}{entry.id === current ? ' · Open' : ''}
            </ListItemButton>
          </li>
        ))}
      </List>
    )}
    {!loading && entries.length > 0 && !found.length && <p className="copy-body tone-supporting">No matching workspaces.</p>}
    {found.length > 6 && (
      <div className="flex gap-space100">
        <Button variant="text" size="xsmall" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous workspaces</Button>
        <Button variant="text" size="xsmall" disabled={(currentPage + 1) * 6 >= found.length} onClick={() => setPage(currentPage + 1)}>Next workspaces</Button>
      </div>
    )}
    {discovery === 'sign-in' && (
      <div className="grid justify-items-start gap-space100">
        <p className="copy-body tone-supporting">Sign in to GitHub to list shared repository workspaces.</p>
        <ButtonLink variant="text" size="small" href="/git/sign-in" target="_blank" rel="noreferrer">Connect GitHub</ButtonLink>
      </div>
    )}
    {discovery === 'partial' && <p className="copy-body tone-supporting">Some repository workspaces could not be checked.</p>}
    {(discovery || problem) && (
      <Button variant="text" size="small" className="justify-self-start" disabled={loading} onClick={() => { setLoading(true); setRefresh(version => version + 1); }}>
        Refresh workspaces
      </Button>
    )}
    {!loading && !entries.length && !problem && !discovery && <p className="copy-body tone-supporting">Saved shared workspaces appear here.</p>}
    {problem && <Alert variant="destructive"><AlertDescription>{problem}</AlertDescription></Alert>}
  </div>;

  return framed ? (
    <Card variant="outlined" as="section" aria-label="Saved workspaces" headline="Saved workspaces" headlineAs="h3" aria-busy={loading}>
      {content}
    </Card>
  ) : (
    <section aria-label="Saved workspaces" aria-busy={loading}>
      {content}
    </section>
  );
}

function IncomingReview({ workspace, document, replica, revision, done, retained, remember, forget, prepareInput }: IncomingRecoveryProps & {
  workspace: string;
  document: string;
  replica?: string | undefined;
  revision: string;
  done: () => void;
}) {
  const working = useRef(false);
  const [review, setReview] = useState<{ proposal: TokenProposal; current: FigmaBundle; conflicts: PullConflict[]; updated: boolean }>();
  const loaded = useRef<TokenProposal | undefined>(undefined);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<ConflictDraft[]>([]);
  const writes = useRef(Promise.resolve());
  const entry = (proposal: TokenProposal, choices = drafts): IncomingReviewRecovery => ({
    workspace,
    document,
    ...(replica ? { replica } : {}),
    proposal,
    drafts: choices,
  });
  const localDrafts = useEffectEvent((proposal: TokenProposal) => retained.find(saved => sameIncomingReview(saved, entry(proposal))));

  useEffect(() => {
    let active = true;
    void workspaceRequest(`/${workspace}/review?document=${encodeURIComponent(document)}${replica ? '&replica=' + encodeURIComponent(replica) : ''}`)
      .then(result => {
        if (!isTokenProposal(result['proposal']) || !isBundle(result['current']) || !isUnknownArray(result['conflicts']) || !result['conflicts'].every(isPullConflict)) {
          throw new Error('The conflict review is incomplete.');
        }
        if (active) {
          const first = !loaded.current || !sameSourceValue(loaded.current, result['proposal']);
          loaded.current = result['proposal'];
          setReview({
            proposal: result['proposal'],
            current: result['current'],
            conflicts: result['conflicts'],
            updated: result['reviewChanged'] === true || !first || result['current'].revision !== revision,
          });
          if (isUnknownArray(result['drafts']) && result['drafts'].every(isConflictDraft)) {
            const received = result['drafts'];
            const saved = localDrafts(result['proposal']);
            setDrafts(previous => (first ? saved?.drafts ?? received : previous));
          }
        }
        return undefined;
      })
      .catch((error: unknown) => {
        if (active) setProblem(errorMessage(error));
      });
    return () => { active = false; };
  }, [workspace, document, replica, revision]);

  async function apply(choices: PullChoice[]) {
    if (!review) return;
    setBusy(true);
    setProblem('');
    try {
      const result = await workspaceRequest(`/${workspace}/resolve`, 'POST', {
        document,
        ...(replica ? { replica } : {}),
        proposal: review.proposal,
        revision: review.current.revision,
        choices,
      });
      if (result['accepted'] !== true) throw new Error('The workspace changed. Reopen this review to choose current values.');
      forget(entry(review.proposal));
      done();
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function applyChoices(choices: PullChoice[]) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    void writes.current.then(() => apply(choices)).finally(() => { working.current = false; setBusy(false); });
  }

  function resumeInput(input: ConflictDraft): (() => void) | undefined {
    if (!review) return undefined;
    const current = review;
    const prepare = prepareInput(entry(current.proposal), input);
    if (!prepare) return undefined;
    return () => {
      if (working.current) return;
      working.current = true;
      setBusy(true);
      setProblem('');
      let prepared: PreparedIncomingInput | undefined;
      void (async () => {
        await writes.current;
        prepared = await prepare();
        const next = drafts.filter(draft => draft.path !== input.path);
        await workspaceRequest(`/${workspace}/review`, 'POST', { document, ...(replica ? { replica } : {}), revision: current.current.revision, drafts: next });
        if (!current.conflicts.length && !next.length) {
          const result = await workspaceRequest(`/${workspace}/resolve`, 'POST', { document, ...(replica ? { replica } : {}), proposal: current.proposal, revision: current.current.revision, choices: [] });
          if (result['accepted'] !== true) throw new Error('The workspace changed. Input remains saved in your recovery copy.');
        }
        prepared.complete();
        done();
      })()
        .catch((error: unknown) => setProblem(errorMessage(error)))
        .finally(() => {
          prepared?.release();
          working.current = false;
          setBusy(false);
        });
    };
  }

  return <div className="grid gap-space150 pad-top-space100">
    {review ? (
      <ConflictReview
        submitted
        updated={review.updated}
        drafts={drafts}
        onDraftsChange={next => {
          setDrafts(next);
          remember(entry(review.proposal, next));
          writes.current = writes.current
            .then(async () => {
              await workspaceRequest(`/${workspace}/review`, 'POST', { document, ...(replica ? { replica } : {}), revision: review.current.revision, drafts: next });
              return undefined;
            })
            .catch((error: unknown) => setProblem(errorMessage(error)));
        }}
        conflicts={review.conflicts}
        rows={review.current.variables}
        busy={busy}
        resumeInput={resumeInput}
        apply={applyChoices}
        cancel={done}
      />
    ) : <Progress label="Loading conflicting changes" />}
    {problem && <Alert variant="destructive"><AlertDescription>{problem}</AlertDescription></Alert>}
  </div>;
}

function EarlierIncomingInput({ entry, remember, forget, prepareInput }: Omit<IncomingRecoveryProps, 'retained'> & { entry: IncomingReviewRecovery }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  return <Card variant="outlined" as="section" aria-label="Unfinished Figma input" headline="Unfinished Figma input" headlineAs="h3" supporting="Saved locally in this browser.">
    {entry.drafts.map(input => {
      const prepare = prepareInput(entry, input);
      return <div key={input.path} className="grid gap-space100">
        <h4 className="copy-emphasis">{input.path}</h4>
        {input.text && <TextField label={`Earlier input for ${input.path}`} value={input.text} readOnly />}
        {!!input.text && !conflictInputKind(input) && (
          <Select label="Input type" aria-label={`Input type for ${input.path}`} value="" disabled={busy} onChange={event => {
            const inputKind = event.target.value;
            if (inputKind === 'value' || inputKind === 'alias') {
              remember({ ...entry, drafts: entry.drafts.map(draft => draft.path === input.path ? { ...draft, inputKind } : draft) });
            }
          }}>
            <SelectOption value="">Choose input type…</SelectOption>
            <SelectOption value="value">Value</SelectOption>
            <SelectOption value="alias">Reference</SelectOption>
          </Select>
        )}
        <div className="flex flex-wrap gap-space100">
          {prepare && (
            <Button variant="outlined" disabled={busy} onClick={() => {
              setBusy(true);
              setProblem('');
              void (async () => {
                const prepared = await prepare();
                try { prepared.complete(); } finally { prepared.release(); }
              })().catch((error: unknown) => setProblem(errorMessage(error))).finally(() => setBusy(false));
            }}>Resume token edit</Button>
          )}
          <Button variant="text" disabled={busy} onClick={() => {
            const drafts = entry.drafts.filter(draft => draft.path !== input.path);
            if (drafts.length) remember({ ...entry, drafts });
            else forget(entry);
          }}>Discard earlier input</Button>
        </div>
      </div>;
    })}
    {problem && <Alert variant="destructive"><AlertDescription>{problem}</AlertDescription></Alert>}
  </Card>;
}

const changesCopy: Record<WorkspaceSaveMode, { subtitle: (repo?: string) => string; button: string }> = {
  'pull-request': {
    subtitle: repo => `Review draft changes against ${repo ?? 'the repository'} before creating a merge request.`,
    button: 'Review and create merge request',
  },
  'pull-request-update': {
    subtitle: repo => `Review draft changes against ${repo ?? 'the repository'} before updating the merge request.`,
    button: 'Review and update merge request',
  },
  folder: {
    subtitle: () => 'Review draft changes before saving to your local folder.',
    button: 'Review and save to folder',
  },
  patch: {
    subtitle: () => 'No repository or folder is connected. Review draft changes to export a .patch file.',
    button: 'Review and export patch',
  },
};

export function WorkspaceChanges({ shared, saveMode, repositoryName, files, tokens, totalFiles, review, discard, discardFile, discardToken, disabled, reconcile, resumeSave, hasReview = false, incoming, setIncoming, retained, remember, forget, prepareInput }: IncomingRecoveryProps & {
  shared: Shared;
  saveMode: WorkspaceSaveMode;
  repositoryName?: string | undefined;
  files: FileChange[];
  tokens: TokenBaselineChange[];
  totalFiles: number;
  review: () => void;
  discard: () => void;
  discardFile: (file: string) => void;
  discardToken: (file: string, path: string) => void;
  disabled: boolean;
  reconcile: () => void;
  resumeSave: () => void;
  hasReview?: boolean;
  incoming: string;
  setIncoming: (id: string) => void;
}) {
  const [saveProblem, setSaveProblem] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [tokenPage, setTokenPage] = useState(0);
  const copy = changesCopy[saveMode];
  const tokenPageSize = 25;
  const lastTokenPage = Math.max(0, Math.ceil(tokens.length / tokenPageSize) - 1);
  const currentTokenPage = Math.min(tokenPage, lastTokenPage);
  const incomingEntries = retained.filter(
    entry => entry.workspace === shared.view?.id && !shared.view.incoming.some(item => item.document === entry.document && item.replica === entry.replica && sameSourceValue(item.proposal, entry.proposal)),
  );

  return <><main id="workspace-changes" tabIndex={-1} className="workspace-management" aria-label="Changes">
    <div className="workspace-management-content">
      <header className="workspace-management-header">
        <div>
          <h2>Changes</h2>
          <p className="copy-body tone-supporting">{copy.subtitle(repositoryName)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-space100">
          <Button variant="outlined" size="small" disabled={disabled || !files.length} onClick={() => setDiscardOpen(true)}>
            Discard changes
          </Button>
          <Button size="small" disabled={disabled || hasReview || !files.length || shared.phase === 'conflict' || shared.phase === 'invalid'} onClick={review}>
            {copy.button}
          </Button>
        </div>
      </header>

      <div className="card-group">

      {shared.phase === 'invalid' && (
        <Card variant="outlined" as="section" headline="Combined changes need attention" headlineAs="h3" supporting="Your local draft stays intact. Repair affected definitions in Tokens, then check for updates.">
          <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap">{shared.problem}</AlertDescription></Alert>
        </Card>
      )}

      {shared.view?.repositorySave && !shared.view.repositorySave.result && (
        <Card
          variant="outlined"
          as="section"
          aria-label="Interrupted repository save"
          headline="Confirm interrupted repository save"
          headlineAs="h3"
          supporting="Check whether GitHub accepted the reviewed save and record its checkpoint. Newer edits stay in the draft."
          actions={<>
            <Button disabled={disabled} onClick={resumeSave}>Resume reviewed save</Button>
            {!shared.view.repositorySave.started && (
              <Button variant="text" disabled={disabled} onClick={() => {
                const view = shared.view;
                if (!view?.repositorySave) return;
                setSaveProblem('');
                void workspaceRequest(`/${view.id}/cancel-save`, 'POST', { id: view.repositorySave.id })
                  .then(() => shared.sync())
                  .catch((failure: unknown) => setSaveProblem(errorMessage(failure)));
              }}>Cancel unstarted save</Button>
            )}
          </>}
        >
          {saveProblem && <Alert variant="destructive"><AlertDescription>{saveProblem}</AlertDescription></Alert>}
        </Card>
      )}

      {(shared.phase === 'conflict' || hasReview) && (
        <Card
          variant="outlined"
          as="section"
          headline={shared.phase === 'conflict' ? 'Conflicting browser edits' : 'Unfinished conflict review'}
          headlineAs="h3"
          supporting={shared.phase === 'conflict' ? 'Another client edited the same definitions. Pick which values to keep.' : 'Resume your saved conflict choices.'}
          actions={
            <Button onClick={reconcile}>
              {shared.phase === 'conflict' ? 'Resolve conflicting definitions' : 'Continue conflict review'}
            </Button>
          }
        />
      )}

      {!!shared.view?.incoming.length && (
        <Card variant="outlined" as="section" aria-label="Figma changes needing review" headline="Figma changes needing review" headlineAs="h3">
          <List>
            {shared.view.incoming.map(item => (
              <li key={item.id}>
                <ListItemButton
                  onClick={() => setIncoming(item.id)}
                  supporting={item.proposal.changes.slice(0, 2).map(change => `${change.path}: ${describeTokenValue(change.before)} → ${describeTokenValue(change.after)}`).join(' · ')}
                >
                  {shared.view?.documents.find(file => file.id === item.document)?.name ?? 'Figma file'} · {item.proposal.changes.length} token {item.proposal.changes.length === 1 ? 'change' : 'changes'}
                </ListItemButton>
                {incoming === item.id && (
                  <IncomingReview
                    workspace={shared.view?.id ?? ''}
                    document={item.document}
                    replica={item.replica}
                    revision={shared.view?.draft.revision ?? ''}
                    {...{ retained, remember, forget, prepareInput }}
                    done={() => { setIncoming(''); void shared.sync(); }}
                  />
                )}
              </li>
            ))}
          </List>
        </Card>
      )}

      {incomingEntries.map(entry => (
        <EarlierIncomingInput
          key={`${entry.workspace}:${entry.document}:${entry.replica ?? 'default'}:${entry.proposal.changes.map(change => change.path).join(',')}`}
          {...{ entry, remember, forget, prepareInput }}
        />
      ))}

      {!!tokens.length && (
        <Card
          variant="outlined"
          as="section"
          aria-label="Changed tokens"
          headline={`${tokens.length} changed ${tokens.length === 1 ? 'token' : 'tokens'}`}
          headlineAs="h3"
          supporting="Revert individual tokens back to the last checkpoint."
        >
          <List>
            {tokens.slice(currentTokenPage * tokenPageSize, (currentTokenPage + 1) * tokenPageSize).map(token => (
              <li key={`${token.file}\0${token.path}`} className="flex flex-wrap items-center justify-between gap-space100 pad-block-space50 copy-body">
                <div className="min-w-0">
                  <code className="wrap-anywhere">{token.path}</code>
                  <p className="copy-small tone-supporting wrap-anywhere">
                    {token.kind === 'added'
                      ? `Added · ${describeTokenValue(token.after)}`
                      : token.kind === 'removed'
                        ? `Removed · ${describeTokenValue(token.before)}`
                        : `${describeTokenValue(token.before)} → ${describeTokenValue(token.after)}`} · <code>{token.file}</code>
                  </p>
                </div>
                <Button
                  variant="text"
                  size="xsmall"
                  disabled={disabled}
                  aria-label={`Revert ${token.path}`}
                  onClick={() => discardToken(token.file, token.path)}
                >
                  Revert
                </Button>
              </li>
            ))}
          </List>
          {lastTokenPage > 0 && (
            <div className="flex items-center justify-end gap-space100 copy-small">
              <Button variant="text" size="xsmall" disabled={!currentTokenPage} onClick={() => setTokenPage(currentTokenPage - 1)}>Previous tokens</Button>
              <span>{currentTokenPage * tokenPageSize + 1}–{Math.min((currentTokenPage + 1) * tokenPageSize, tokens.length)} of {tokens.length}</span>
              <Button variant="text" size="xsmall" disabled={currentTokenPage === lastTokenPage} onClick={() => setTokenPage(currentTokenPage + 1)}>Next tokens</Button>
            </div>
          )}
        </Card>
      )}

      <Card
        variant="outlined"
        as="section"
        aria-label="Draft changes"
        headline={files.length ? `${files.length} changed source ${files.length === 1 ? 'file' : 'files'}` : 'No source changes'}
        headlineAs="h3"
      >
        {files.length ? (
          <List>
            {files.map(file => (
              <li key={file.path} className="flex flex-wrap items-center justify-between gap-space100 copy-body wrap-anywhere pad-block-space50">
                <div>
                  <code>{file.path}</code>
                  <span className="tone-supporting"> · {file.before === null ? 'Added' : file.after === null ? 'Removed' : 'Modified'}</span>
                </div>
                <Button
                  variant="text"
                  size="xsmall"
                  disabled={disabled || file.before === null && totalFiles <= 1}
                  aria-label={`Discard changes to ${file.path}`}
                  onClick={() => discardFile(file.path)}
                >
                  Discard
                </Button>
              </li>
            ))}
          </List>
        ) : (
          <p className="copy-small tone-supporting">Token edits and synced Figma changes appear here.</p>
        )}
      </Card>
      </div>
    </div>
  </main>
  <ActionDialog
    title="Discard changes"
    open={discardOpen}
    onOpenChange={setDiscardOpen}
    description={`Reset ${files.length} changed source ${files.length === 1 ? 'file' : 'files'} back to the last checkpoint? You can undo this during this session.`}
    actions={<>
      <Button variant="text" data-dialog-close="">Cancel</Button>
      <Button onClick={() => { setDiscardOpen(false); discard(); }}>Discard changes</Button>
    </>}
  /></>;
}
