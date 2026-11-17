import { startTransition, StrictMode, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ClipboardEvent, ComponentType } from 'react';
import { errorMessage, isJsonObject, requireValue } from '../lib/json.ts';
import type { JsonObject, JsonValue } from '../lib/json.ts';
import { diagnosticKey } from '../lib/document-diagnostics.ts';
import type { DocumentGraph } from '../lib/document.ts';
import type { TokenNode } from '../lib/token-types.ts';
import { compileResolver, isResolverFile, newResolverDocument, resolveResolver, resolverValueAt, winningOrigins } from '../lib/resolver.ts';
import type { ResolverOrigin } from '../lib/resolver.ts';
import { serializeTokenPointer, tokenPointer } from '../lib/token-path.ts';
import { copyEntries, decodeClipboard, encodeClipboard } from '../lib/structure.ts';
import type { ClipboardEntry } from '../lib/structure.ts';
import { PasteDialog } from './paste-dialog.tsx';
import { ResolverPane, VariantComparison, downloadEditableSources, downloadVariant, labelOrigin, variantLabel } from './resolver-pane.tsx';
import type { Inputs } from './resolver-pane.tsx';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { openWorkspace, reviewAgainstLatest, reviewCreateSource, reviewDelete, reviewDuplicate, reviewEdit, reviewMove, reviewMoves, reviewProposal, reviewRenameWithEdit, reviewMetadata, reviewRemoveOverride, reviewResolverValue, workspaceChanges } from '../lib/workspace.ts';
import type { ResolverEditScope, Review, Workspace } from '../lib/workspace.ts';
import { runWorkspaceReview } from './lib/workspace-review.ts';
import type { CellPosition, Draft, EditableColumn, GridColumn } from './lib/draft.ts';
import type { WorkspaceConnection, WorkspaceConnectorProps } from './lib/connector.ts';
import { OpenGitHub } from '../integrations/github/connect.tsx';
import { createRoot } from 'react-dom/client';
import { AlertCircle, ArrowDownToLine, ArrowRightLeft, ChevronLeft, ChevronRight, ClipboardPaste, Copy, FileUp, FolderOpen, GitPullRequest, Layers, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, SquarePen, Plus, Redo2, Search, Settings2, Sun, Trash2, Undo2, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink, IconButton, NavigationRail, NavigationRailItem, SearchBar, SideSheet, TextField } from '@token-catalog/forge-react';
import { BulkEditDialog, selectionEditLabels } from './bulk-edit-dialog.tsx';
import { ReviewChanges } from './review-dialog.tsx';
import type { SelectionEdit } from './bulk-edit-dialog.tsx';
import { DiagnosticsDialog } from './diagnostics-dialog.tsx';
import { SourceFileDialog } from './source-file-dialog.tsx';
import type { SourceFileAction } from './source-file-dialog.tsx';
import { SourceDialog } from './source-dialog.tsx';
import type { SourceLocation } from './source-dialog.tsx';
import { MoveDialog } from './move-dialog.tsx';
import type { MoveOperation } from './move-dialog.tsx';
import { FolderTree } from './folder-tree';
import type { FolderTreeHandle } from './folder-tree.tsx';
import { WorkspacePanes } from './pane-resize.tsx';
import { TokenGrid } from './token-grid';
import { CommandBar, CommandMenu } from './command-bar.tsx';
import type { Menu } from './command-bar.tsx';
import { MetadataDialog } from './metadata-dialog.tsx';
import type { MetadataLocation } from './metadata-dialog.tsx';
import { GroupActions } from './group-actions.tsx';
import { ReferenceDetails } from './reference-details.tsx';
import { TokenValue } from './token-value.tsx';
import { TokenEditForm } from './token-edit-form.tsx';
import { ActionDialog } from '@/components/ui/dialog';
import { displayInput, inputFormat, readInput, validateInputValue } from './lib/token-input';
import { canEditType, defaultValue } from './lib/value-shape.ts';
import { referenceProblems, leafName, parentPath, referenceLabel } from '../lib/document.ts';
import { download, downloadPatch, openExample, openFiles } from './lib/sources.ts';
import { openLocalFolder } from './lib/local-folder.ts';
import './workspace.css';
import './components/ui/primitives.css';
import '@token-catalog/forge-react/styles.css';

const pageSize = 100;

function nearestGroup(graph: DocumentGraph, path: string): string {
  while (path && !graph.groups.has(path)) path = parentPath(path);
  return path;
}
const systemDark = matchMedia('(prefers-color-scheme: dark)');
document.documentElement.dataset['contrast'] = 'default';
const themeKey = 'foundry-theme';
type Theme = 'light' | 'dark';
function savedTheme(): Theme | null {
  const theme = localStorage.getItem(themeKey);
  return theme === 'light' || theme === 'dark' ? theme : null;
}

function applyTheme(preference: Theme | null) {
  document.documentElement.dataset['theme'] = preference ?? (systemDark.matches ? 'dark' : 'light');
}

applyTheme(savedTheme());
const prefersDark = () => systemDark.matches;
function subscribeTheme(onChange: () => void) {
  systemDark.addEventListener('change', onChange);
  return () => systemDark.removeEventListener('change', onChange);
}

const desktopViewport = matchMedia('(min-width: 48rem)');
function subscribeViewport(onChange: () => void) {
  desktopViewport.addEventListener('change', onChange);
  return () => desktopViewport.removeEventListener('change', onChange);
}
const isDesktopViewport = () => desktopViewport.matches;

type Snapshot = Workspace['baseline'];
interface History { past: readonly Snapshot[]; future: readonly Snapshot[] }
const emptyHistory: History = { past: [], future: [] };

function snapshot(workspace: Workspace): Snapshot {
  return workspace.files.map(({ path, text }) => ({ path, text }));
}

type SaveTarget = { kind: 'folder'; save: (workspace: Workspace) => Promise<void> } |
  { kind: 'pull-request'; connection: WorkspaceConnection };

function Editor({ Connector, proposalLink }: { Connector: ComponentType<WorkspaceConnectorProps> | null; proposalLink: string }) {
  const [data, setData] = useState(openExample);
  const [history, setHistory] = useState(emptyHistory);
  const [group, setGroup] = useState('');
  const [query, setQuery] = useState('');
  const [onlyUnresolved, setOnlyUnresolved] = useState(false);
  const [selected, setSelected] = useState('');
  const [activeColumn, setActiveColumn] = useState<GridColumn>('name');
  const [paste, setPaste] = useState<{ entries: ClipboardEntry[]; group: string } | null>(null);
  const pastedGroupFocus = useRef(false);
  const groupsTree = useRef<FolderTreeHandle>(null);
  const clipboard = useRef({ text: '', tabOnly: false });
  const [bulkEdit, setBulkEdit] = useState<{ paths: readonly string[]; action: SelectionEdit } | null>(null);
  const bulkTrigger = useRef<HTMLButtonElement>(null);
  const bulkFocusAfterReview = useRef(false);
  const [checked, setChecked] = useState(() => new Set<string>());
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [theme, setTheme] = useState(savedTheme);
  const systemPrefersDark = useSyncExternalStore(subscribeTheme, prefersDark);
  const dark = theme ? theme === 'dark' : systemPrefersDark;
  useLayoutEffect(() => applyTheme(dark ? 'dark' : 'light'), [dark]);

  function toggleTheme() {
    const next = dark ? 'light' : 'dark';
    localStorage.setItem(themeKey, next);
    setTheme(next);
  }
  const [view, setView] = useState<'tokens' | 'workspace'>('tokens');
  const [relocate, setRelocate] = useState<{ paths: string[]; operation: MoveOperation } | null>(null);
  const [showTree, setShowTree] = useState(true);
  const desktop = useSyncExternalStore(subscribeViewport, isDesktopViewport);
  const [mobileTree, setMobileTree] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const resolverFocusAfterApply = useRef<HTMLElement | null>(null);
  const afterReviewApplied = useRef<(() => void) | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [finalReview, setFinalReview] = useState<Review | null>(null);
  const [saveTarget, setSaveTarget] = useState<SaveTarget | null>(null);
  const [revisionReview, setRevisionReview] = useState<'current' | 'stale' | 'refreshed'>('current');
  const [submittedUrl, setSubmittedUrl] = useState('');
  const [linkedProposal, setLinkedProposal] = useState(proposalLink);
  const [importChanges, setImportChanges] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [metadataLocation, setMetadataLocation] = useState<MetadataLocation | null>(null);
  const sourceManagement = useRef<HTMLElement>(null);
  const sourceFocusAfterReview = useRef<string | null>(null);
  const [sourceFileAction, setSourceFileAction] = useState<SourceFileAction | null>(null);
  const [sourceLocation, setSourceLocation] = useState<SourceLocation | null>(null);
  const [primary, setPrimary] = useState<Inputs>({});
  const [secondary, setSecondary] = useState<Inputs>({});
  const [comparing, setComparing] = useState(false);
  const [definitionOpen, setDefinitionOpen] = useState(false);
  const [variantDirty, setVariantDirty] = useState(false);
  const [variantEdit, setVariantEdit] = useState<{ path: string; origin: ResolverOrigin; insert?: true }>();
  const [resolverFile, setResolverFile] = useState('');
  const [newResolver, setNewResolver] = useState(false);
  const [resolverName, setResolverName] = useState('');
  const [resolverError, setResolverError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const proposalInput = useRef<HTMLInputElement>(null);
  const workspacePane = useRef<HTMLElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const inspectorCloseButton = useRef<HTMLButtonElement>(null);
  const tokenSearch = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const pendingRename = useRef<{ after: CellPosition | null | undefined } | null>(null);
  const refocusAfterReview = useRef(false);
  const [focusRequest, setFocusRequest] = useState<CellPosition | null>(null);
  const resolvers = useMemo(() => data.files.filter(isResolverFile), [data.files]);
  const activeResolver = resolvers.find(file => file.path === resolverFile) ?? resolvers[0];
  const model = useMemo(() => activeResolver && compileResolver(activeResolver, data.files.filter(file => !file.parseIssue)), [activeResolver, data.files]);
  const current = useMemo(() => model && resolveResolver(model, primary), [model, primary]);
  const alternative = useMemo(() => model && comparing ? resolveResolver(model, secondary) : undefined, [model, comparing, secondary]);
  const graph = current?.graph ?? data.graph;
  const displayedGroup = nearestGroup(graph, group);
  const variantScope: ResolverEditScope | undefined = model && current ? { file: model.file, contexts: [
    { label: variantLabel(current), inputs: primary },
    ...(alternative ? [{ label: variantLabel(alternative), inputs: secondary }] : []),
  ] } : undefined;
  const diagnosticGraph = useMemo(() => current ? {
    ...graph,
    documentDiagnostics: [...new Map([...graph.documentDiagnostics, ...data.graph.documentDiagnostics]
      .map(issue => [diagnosticKey(issue), issue])).values()],
  } : graph, [current, graph, data.graph]);
  const diagnosticsCount = useMemo(() => {
    let count = diagnosticGraph.documentDiagnostics.length;
    for (const [path, issue] of diagnosticGraph.issues) count += referenceProblems(diagnosticGraph, path, issue).length;
    for (const issues of diagnosticGraph.validation.values()) count += issues.length;
    return count;
  }, [diagnosticGraph]);
  const inspected = graph.tokens.get(selected);
  const origins = current ? winningOrigins(current, selected) : [];
  const winner = origins.at(-1);
  const sharedOrigin = origins.findLast(origin => !origin.modifier);
  const groupOrigins = new Map<string, ResolverOrigin>();
  for (const origin of current?.origins.get(displayedGroup) ?? []) {
    if (!origin.modifier) groupOrigins.set(JSON.stringify([origin.file, origin.parts]), origin);
  }
  const sourceChoices = new Map([...groupOrigins].map(([key, origin]) => [key, labelOrigin(origin)]));
  const overrideTargets = current && model && inspected?.type ? [...model.modifiers.values()].flatMap(modifier => {
    const option = current.contexts.get(modifier.name);
    const site = option === undefined ? undefined : modifier.contextSites.get(option);
    const tree = data.files.find(source => source.path === site?.file)?.tree;
    const list = site && resolverValueAt(tree, site.parts);
    return site && option !== undefined && Array.isArray(list) && (winner?.modifier !== modifier.name || winner.context !== option) ?
      [{ file: site.file, parts: [...site.parts, String(list.length)], modifier: modifier.name, context: option }] : [];
  }) : [];
  const variantOriginal = variantEdit && (variantEdit.insert ? current?.graph.resolved.get(variantEdit.path) :
    resolverValueAt(data.files.find(source => source.path === variantEdit.origin.file)?.tree, variantEdit.origin.parts));
  const authoredVariant = isJsonObject(variantOriginal) ? variantOriginal : undefined;
  const variantValue = variantEdit?.insert ? variantOriginal :
    authoredVariant && (Object.hasOwn(authoredVariant, '$value') ? authoredVariant['$value'] : { $ref: authoredVariant['$ref'] });
  const variantType = typeof authoredVariant?.['$type'] === 'string' && !variantEdit?.insert ? authoredVariant['$type'] : inspected?.type;
  const inspectorDraft = draft && !draft.create && draft.mode === 'inspector' ? draft : null;
  const inspectorInitial: Draft | null = inspected && inspectorOpen ? {
    create: false, mode: 'inspector', column: 'value', path: selected, name: leafName(selected),
    type: inspected.node.$type, original: inspected.value, value: displayInput(inspected.type, inspected.value),
    originalDescription: inspected.node.$description ?? '', description: inspected.node.$description ?? '',
  } : null;
  const folder = requireValue(graph.groups.get(displayedGroup), 'current group');
  const search = query.trim().toLowerCase();
  const groupRows = useMemo(() => graph.rows.slice(folder.start, folder.end), [graph, folder]);
  const unresolvedCount = useMemo(() => groupRows.reduce((count, [path]) => count + Number(graph.issues.has(path)), 0),
    [graph, groupRows]);
  const showOnlyUnresolved = onlyUnresolved && unresolvedCount > 0;
  const filtered = useMemo(() => !search && !showOnlyUnresolved ? groupRows : groupRows.filter(([path, { type, node }]) =>
    (!showOnlyUnresolved || graph.issues.has(path)) &&
    (!search || [path, type, node.$description].some((value) => typeof value === 'string' && value.toLowerCase().includes(search)))),
  [graph, groupRows, search, showOnlyUnresolved]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const shownPage = Math.min(page, pages - 1);
  const rows = useMemo(() => filtered.slice(shownPage * pageSize, (shownPage + 1) * pageSize), [filtered, shownPage]);
  const selectionCount = checked.size.toLocaleString('en');
  const selectedTokenLabel = selectionCount + (checked.size === 1 ? ' token' : ' tokens');
  const hiddenChecked = checked.size - rows.filter(([path]) => checked.has(path)).length;
  const saveStatus = busy ? 'Working…' : status || (dirty ? 'Unsaved changes' : '');
  const hasChanges = useMemo(() => workspaceChanges(data).length > 0, [data]);

  function activate(next: Workspace, target: SaveTarget | null = null) {
    setView('tokens');
    setData(next);
    setResolverFile('');
    setPrimary({});
    setSecondary({});
    setComparing(false);
    setDefinitionOpen(false);
    setVariantEdit(undefined);
    setVariantDirty(false);
    setHistory(emptyHistory);
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
    if (!focusRequest) return undefined;
    // React Aria commits collection items separately from the draft that replaces them.
    const frame = requestAnimationFrame(() => {
      const control = grid.current?.querySelector<HTMLButtonElement>(
        '[data-token-row="' + CSS.escape(focusRequest.path) + '"] [data-edit-column="' + focusRequest.column + '"]',
      );
      const cell = control?.closest<HTMLElement>('td, th');
      cell?.focus({ preventScroll: true });
      control?.focus({ preventScroll: true });
      cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
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
    setPage(0);
    clearTokenSearch();
    setOnlyUnresolved(false);
  }

  function resetScroll() {
    grid.current?.querySelector('[data-slot="table-container"]')?.scrollTo(0, 0);
  }

  function clearTokenSearch() {
    if (tokenSearch.current) tokenSearch.current.value = '';
    setQuery('');
  }

  function searchTokens(value: string) {
    // The input owns its text. Updating the results can wait until the browser can paint it.
    startTransition(() => {
      setQuery(value);
      setPage(0);
      select('');
    });
    resetScroll();
  }

  function selectGroup(path: string) {
    if (variantDirty) return;
    setGroup(path);
    setMobileTree(false);
    setError('');
    clearSelection();
    resetScroll();
  }

  function select(path: string, column?: GridColumn) {
    if (variantDirty && selected !== path) return;
    setSelected(path);
    if (column) setActiveColumn(column);
    if (variantEdit?.path !== path) setVariantEdit(undefined);
    setError('');
  }

  function clearCheckedSelection() {
    const stop = grid.current?.querySelector<HTMLElement>('[data-token-row][tabindex="0"], [data-token-row] [tabindex="0"]');
    stop?.focus({ preventScroll: true });
    setChecked(new Set());
  }

  function copyPaths(paths: readonly string[], event?: ClipboardEvent<HTMLElement>) {
    try {
      const entries = copyEntries(data, paths);
      const text = encodeClipboard(entries);
      const copy = { text, tabOnly: !event };
      clipboard.current = copy;
      if (event) {
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
      } else void navigator.clipboard?.writeText(text).then(() => Object.assign(copy, { tabOnly: false })).catch(() => undefined);
      setError('');
      setStatus(entries.length + (entries.length === 1 ? ' entry copied' : ' entries copied'));
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  function copySelection(event: ClipboardEvent<HTMLElement>, fromGroups = false) {
    if (current) return;
    if (busy || draft || window.getSelection()?.toString() || !(event.target instanceof HTMLElement) ||
      event.target.closest('input:not([type=checkbox]), textarea, select, [contenteditable]')) return;
    const focused = fromGroups ? event.target.closest<HTMLElement>('[data-group-path]')?.dataset['groupPath'] ?? group :
      event.target.closest<HTMLElement>('[data-token-row]')?.dataset['tokenRow'] ?? selected;
    const paths = !fromGroups && checked.size ? [...checked] : focused ? [focused] : [];
    if (paths.length) copyPaths(paths, event);
  }

  function openPaste(text: string, destination: string) {
    try {
      setPaste({ entries: decodeClipboard(text), group: destination });
      setError('');
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  async function pasteIntoGroup(destination: string) {
    const local = clipboard.current;
    let text = local.text;
    if (!local.tabOnly) {
      try { text = await navigator.clipboard?.readText() ?? text; }
      catch { /* The tab retains the copy when system clipboard access is unavailable. */ }
    }
    if (!text) { setError('Copy tokens or a group before pasting.'); return; }
    openPaste(text, destination);
  }

  function pasteSelection(event: ClipboardEvent<HTMLElement>) {
    if (current) return;
    if (busy || draft || event.target instanceof HTMLElement &&
      event.target.closest('input:not([type=checkbox]), textarea, select, [contenteditable]')) return;
    const text = event.clipboardData.getData('text/plain');
    if (!/"format"\s*:\s*"foundry\.tokens"/u.test(text)) return;
    event.preventDefault();
    openPaste(text, group);
  }

  const handleGridShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!event.defaultPrevented && !event.isComposing && !event.altKey && (event.ctrlKey || event.metaKey) &&
      event.target instanceof HTMLElement && !event.target.closest('input, textarea, select, [contenteditable]')) {
      const key = event.key.toLowerCase();
      if (key === 'z' || key === 'y') {
        event.preventDefault();
        stepHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo');
        return;
      }
    }
    if (event.key !== 'Escape' || event.defaultPrevented || draft || (!selected && !checked.size) ||
      (event.target instanceof HTMLInputElement && event.target.type === 'search')) return;
    event.preventDefault();
    setChecked(new Set());
    select('');
  });
  useEffect(() => {
    const pane = workspacePane.current;
    const onKeyDown = (event: KeyboardEvent) => handleGridShortcut(event);
    // Scope workspace shortcuts to the token pane alongside React Aria's grid shortcuts.
    pane?.addEventListener('keydown', onKeyDown);
    return () => pane?.removeEventListener('keydown', onKeyDown);
  }, []);

  function jump(path: string) {
    const parent = parentPath(path);
    const start = requireValue(graph.groups.get(parent), 'parent group').start;
    setGroup(parent);
    clearTokenSearch();
    setOnlyUnresolved(false);
    setPage(Math.floor((graph.rows.findIndex(([id]) => id === path) - start) / pageSize));
    setFocusRequest({ path, column: 'name' });
    select(path);
  }

  function edit(path: string, column: EditableColumn, link = false) {
    if (busy || draft || variantDirty) return;
    if (current) { openInspector(path); return; }
    const token = graph.tokens.get(path);
    if (!token) return;
    if (token.inheritedFrom && column === 'name') { openInspector(path); return; }
    select(path);
    const mode = column === 'value' && (link || referenceLabel(token.value)) ? 'link' :
      column === 'value' && token.value !== null && typeof token.value === 'object' &&
        inputFormat(token.type, token.value) === 'json' ? 'details' : 'inline';
    setDraft({ path, name: leafName(path), column, mode, type: column === 'type' || mode === 'link' ? token.node.$type : token.type, original: token.value,
      value: displayInput(token.type, token.value), originalDescription: token.node.$description ?? '',
      description: token.node.$description ?? '', create: false });
  }

  function create(groupOnly: boolean, name = '') {
    const destinations = [...(current ? sourceChoices.keys() : folder.files.keys())];
    if (!destinations.length) return;
    setError('');
    if (showOnlyUnresolved) {
      setOnlyUnresolved(false);
      setPage(0);
    }
    const type = folder.type ?? 'color';
    const value = !groupOnly && canEditType(type) ? JSON.stringify(defaultValue(type)) : '';
    setDraft({ create: true, groupOnly, path: displayedGroup, name, type: current ? type : folder.type ? '' : 'color', value, description: '',
      file: destinations.length === 1 ? destinations[0] ?? '' : '' });
  }

  function cancel(restore = true) {
    setError('');
    if (restore && draft && !draft.create && draft.mode !== 'inspector') setFocusRequest({ path: draft.path, column: draft.column });
    setDraft(null);
  }

  function applyWorkspace(next: Workspace) {
    setHistory({ past: [...history.past, snapshot(data)], future: [] });
    setData(next);
    setDirty(true);
  }

  function stepHistory(direction: 'undo' | 'redo') {
    if (busy || draft || variantDirty || review || finalReview || relocate || paste || bulkEdit) return;
    const source = direction === 'undo' ? history.past.at(-1) : history.future.at(-1);
    if (!source) return;
    const restored = { ...openWorkspace(data.name, source), baseline: data.baseline };
    const previousSnapshot = snapshot(data);
    setHistory(direction === 'undo'
      ? { past: history.past.slice(0, -1), future: [...history.future, previousSnapshot] }
      : { past: [...history.past, previousSnapshot], future: history.future.slice(0, -1) });
    setData(restored);
    setDirty(workspaceChanges(restored).length > 0);
    selectGroup(nearestGroup(restored.graph, group));
    setStatus('');
  }

  function finishChange(next: Workspace, path: string, applied: Draft, after?: CellPosition | null) {
    applyWorkspace(next);
    setStatus('');
    if (applied.groupOnly) selectGroup(path);
    else if (applied.create) {
      clearTokenSearch();
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
      if (!applied.groupOnly && after !== null && (applied.create || applied.mode !== 'inspector')) {
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
    afterReviewApplied.current = null;
    pendingRename.current = null;
    setReview(null);
    setError('');
  }

  function saveReview() {
    if (!review || review.validationErrors?.length) return;
    afterReviewApplied.current?.();
    afterReviewApplied.current = null;
    if (sourceLocation) setSourceLocation(null);
    if (metadataLocation) setMetadataLocation(null);
    if (draft?.create && current) {
      applyWorkspace(review.next);
      if (draft.groupOnly) selectGroup(review.path);
      else setSelected(review.path);
      setDraft(null);
    } else if (draft) {
      refocusAfterReview.current = true;
      finishChange(review.next, review.path, draft, pendingRename.current?.after);
    }
    else {
      applyWorkspace(review.next);
      if (review.pasteGroup !== undefined) {
        selectGroup(review.pasteGroup);
        groupsTree.current?.reveal(review.pasteGroup);
      } else if (review.path && !current) {
        if (review.next.graph.groups.has(review.path)) selectGroup(review.path);
        else if (graph.tokens.has(review.path) && review.next.graph.tokens.has(review.path)) {
          refocusAfterReview.current = true;
          setSelected(review.path);
          setFocusRequest({ path: review.path, column: 'name' });
        } else selectGroup(parentPath(review.path));
      }
      else if (bulkEdit?.action === 'rename' && review.structure) {
        const renamed = new Map(review.structure.paths.map(({ from, to }) => [from, to]));
        setChecked(new Set([...checked].map(path => renamed.get(path) ?? path)));
        setSelected(renamed.get(selected) ?? selected);
      }
      else if (!review.bulk && !current) {
        setChecked(new Set());
        setSelected('');
        setPage(0);
        if (!review.next.graph.groups.has(group)) setGroup(nearestGroup(review.next.graph, group));
      }
      setStatus('');
    }
    closeReview();
  }

  async function checkVariantEdit(pending: Review, path = pending.path, applied?: () => void) {
    if (!variantScope) return;
    setBusy(true);
    try {
      const next = await runWorkspaceReview({ kind: 'resolver', workspace: data, draft: pending, scope: variantScope });
      afterReviewApplied.current = applied ?? null;
      setReview({ ...next, path });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }

  function authoredVariantValue(file: string, next: JsonValue, previous?: JsonValue): JsonValue {
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    if (Array.isArray(next)) return next.map((part, index) => authoredVariantValue(file, part, Array.isArray(previous) ? previous[index] : undefined));
    if (!isJsonObject(next)) return next;
    if (typeof next['$ref'] === 'string' && next['$ref'].startsWith('#') && next['$ref'] !== (isJsonObject(previous) && previous['$ref'])) {
      const { parts } = tokenPointer(next['$ref'], model?.file ?? '');
      const index = parts.indexOf('$value');
      const target = winningOrigins(requireValue(current, 'active variant'), parts.slice(0, index < 0 ? parts.length : index).join('.')).at(-1);
      if (!target) throw new Error('Choose an available token field.');
      const pointer = serializeTokenPointer(file, target.file, [...target.parts, ...parts.slice(index < 0 ? parts.length : index)]);
      return { ...next, $ref: file === target.file ? encodeURIComponent(target.file.split('/').at(-1) ?? '') + pointer : pointer };
    }
    return Object.fromEntries(Object.entries(next).map(([key, part]) => [key,
      part === undefined ? undefined : authoredVariantValue(file, part, isJsonObject(previous) ? previous[key] : undefined)]));
  }

  function commitVariant(change: Draft): boolean {
    if (!model || !current || !variantEdit || busy) return false;
    const { path, origin, insert } = variantEdit;
    const type = change.type || variantType;
    try {
      const value = readInput(change.value, type, change.original);
      validateInputValue(type, value);
      const { $ref: _, ...existing } = insert ? inspected?.authoredNode ?? {} : authoredVariant ?? {};
      const node: JsonObject = { ...existing, ...(insert || change.type !== variantType ? { $type: type } : {}), $value: authoredVariantValue(origin.file, value, change.original) };
      const content = insert ? path.split('.').reduceRight<JsonObject>((child, key) => ({ [key]: child }), node) : node;
      const pending = reviewResolverValue(data, origin.file, origin.parts, content, insert);
      setError('');
      void checkVariantEdit(pending, path, () => { setVariantEdit(undefined); setVariantDirty(false); });
      return true;
    } catch (failure) { setError(errorMessage(failure)); return false; }
  }

  function commit(change: Draft, after?: CellPosition | null): boolean {
    if (review || pendingRename.current) return true;
    if (busy) return false;
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
      if (change.create && current) {
        const path = [displayedGroup, name].filter(Boolean).join('.');
        if (graph.tokens.has(path) || graph.groups.has(path)) throw new Error('That name already exists in this group.');
        const origin = requireValue(groupOrigins.get(change.file), 'source for this group');
        const type = change.type || folder.type;
        const raw = change.groupOnly ? undefined : readInput(change.value, type, undefined);
        const node: JsonObject = raw === undefined ? {} : { $type: type, $value: authoredVariantValue(origin.file, raw),
          ...(change.description.trim() ? { $description: change.description.trim() } : {}) };
        if ('$value' in node) validateInputValue(type, node['$value']);
        void checkVariantEdit(reviewResolverValue(data, origin.file, [...origin.parts, name], node), path);
        return true;
      }
      if (!change.create && change.column === 'name') {
        if (leafName(change.path) === name) return closeUnchanged();
        const path = [parentPath(change.path), name].filter(Boolean).join('.');
        const file = requireValue(graph.tokens.get(change.path), 'token').file;
        const renamed = reviewMove(data, { path: change.path, to: path, file }, true);
        if (renamed.structure?.referencesUpdated || renamed.inheritanceImpact.length || renamed.validationErrors?.length) {
          pendingRename.current = { after };
          setReview(renamed);
        } else finishChange(renamed.next, path, change, after);
        return true;
      }
      const path = change.create ? [group, name].filter(Boolean).join('.') : change.path;
      const token = change.create ? undefined : requireValue(graph.tokens.get(path), 'token');
      const file = change.create ? change.file : token?.file;
      if (!file) throw new Error('Choose a source file for this edit.');
      const node: TokenNode = {};
      const description = change.description.trim();
      if (description !== (change.originalDescription ?? '')) node.$description = description;
      const inspector = !change.create && change.mode === 'inspector';
      const typeChanged = !change.create && (inspector || change.mode === 'link' || change.column === 'type') && (change.type || undefined) !== token?.node.$type;
      const inheritType = typeChanged && !change.type;
      if (!change.groupOnly) {
        if ((change.create || typeChanged) && change.type) node.$type = change.type;
        const inherited = graph.groups.get(parentPath(path))?.definitions.get(file)?.type;
        const editingValue = !change.create && change.column === 'value' && !typeChanged;
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
      const hasEdits = Object.keys(node).length > 0 || inheritType;
      const tokenChange = { path, node, create: change.create, inheritType };
      if (inspector && name !== leafName(path)) {
        const renamedPath = [parentPath(path), name].filter(Boolean).join('.');
        const move = { path, to: renamedPath, file };
        const renamed = hasEdits ? reviewRenameWithEdit(data, move, tokenChange) : reviewMove(data, move, true);
        if (renamed.structure?.referencesUpdated || renamed.inheritanceImpact.length || renamed.validationErrors?.length) {
          pendingRename.current = { after };
          setReview(renamed);
        } else finishChange(renamed.next, renamedPath, change, after);
        return true;
      }
      if (!change.create && !hasEdits) return closeUnchanged();
      const updated = reviewEdit(data, file, tokenChange);
      if (change.create || token?.inheritedFrom) {
        setReview(updated);
      } else finishChange(updated.next, path, change, after);
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    }
  }

  function restoreInherited(path: string) {
    setError('');
    try {
      setReview(reviewRemoveOverride(data, path));
    } catch (failure) {
      setError(errorMessage(failure));
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
    return !(dirty || draft || variantDirty) || window.confirm('Open different token files and discard your unsaved edits?');
  }

  async function reviewForSave() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setFinalReview(await runWorkspaceReview({ kind: 'save', workspace: data }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function saveFinalReview() {
    if (!finalReview || busy || finalReview.validationErrors?.length) return;
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

  const suggestedEdit: SelectionEdit = activeColumn === 'name' ? 'rename' : activeColumn === 'resolved' ? 'value' : activeColumn;
  const editActions = (['rename', 'value', 'type', 'description'] as const).map(action => ({
    action, label: selectionEditLabels[action], run: () => setBulkEdit({ paths: [...checked], action }),
  }));
  const menuDisabled = busy || !!draft || variantDirty;
  const treeVisible = desktop ? showTree : mobileTree;
  const treeLabel = treeVisible ? 'Hide groups sidebar' : 'Show groups sidebar';
  const inspectorLabel = inspectorOpen ? 'Close token editor' : 'Edit token';
  const treeIcon = treeVisible ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />;
  const themeLabel = dark ? 'Switch to light mode' : 'Switch to dark mode';
  function toggleTree() {
    if (desktop) setShowTree(!showTree);
    else {
      setMobileTree(!mobileTree);
      if (!mobileTree) setInspectorOpen(false);
    }
  }
  const reviewLabel = saveTarget?.kind === 'folder' ? 'Review and save' :
    saveTarget?.kind === 'pull-request' ? 'Review pull request' : 'Review changes';
  const canCreate = !menuDisabled && (current ? sourceChoices.size > 0 : folder.files.size > 0);
  const canAddGroupValue = canCreate && !!displayedGroup && !graph.tokens.has(displayedGroup + '.$root');
  function setUpVariants() {
    setResolverName(data.name === 'Example' ? '' : data.name);
    setResolverError('');
    setNewResolver(true);
  }
  function manageVariants() {
    setView('tokens');
    setDefinitionOpen(true);
  }
  const showMd3 = import.meta.env.DEV && import.meta.env['VITE_MD3_SAMPLE'] === '1';
  const menus: Menu[] = [
    { label: 'File', sections: [
      [
        { label: 'Open token files…', icon: <FileUp aria-hidden="true" />, run: () => fileInput.current?.click(), disabled: busy },
        { label: 'Open token folder…', icon: <FolderOpen aria-hidden="true" />, run: () => { void loadFolder(); }, disabled: busy },
        { label: 'Open built-in example', icon: <FolderOpen aria-hidden="true" />, run: () => { if (canReplace()) activate(openExample()); }, disabled: busy },
        { label: 'Open Material 3 sample', icon: <FolderOpen aria-hidden="true" />, run: () => { void loadMd3(); },
          disabled: busy || !showMd3, title: showMd3 ? undefined : 'This build does not include the Material 3 sample.' },
        { label: 'Import proposal…', icon: <FileUp aria-hidden="true" />,
          run: () => { setError(''); setImportChanges(true); }, disabled: !!activeResolver || menuDisabled },
      ],
      [
        { label: reviewLabel + '…', icon: <ArrowDownToLine aria-hidden="true" />,
          disabled: menuDisabled || !dirty || !hasChanges, run: () => { void reviewForSave(); } },
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
      model && current ? [
        { label: 'Download editable sources (.zip)', icon: <ArrowDownToLine aria-hidden="true" />, disabled: menuDisabled,
          run: () => { void downloadEditableSources(data, model).catch((failure: unknown) => setError(errorMessage(failure))); } },
        { label: 'Download resolved tokens · ' + variantLabel(current), icon: <ArrowDownToLine aria-hidden="true" />,
          disabled: menuDisabled || !!current.errors.length || model.issues.some(issue => issue.severity === 'error'),
          run: () => { try { downloadVariant(current); } catch (failure) { setError(errorMessage(failure)); } } },
      ] : [],
    ] },
    { label: 'Edit', sections: [
      [
        { label: 'Undo', icon: <Undo2 aria-hidden="true" />, disabled: menuDisabled || !history.past.length,
          run: () => stepHistory('undo') },
        { label: 'Redo', icon: <Redo2 aria-hidden="true" />, disabled: menuDisabled || !history.future.length,
          run: () => stepHistory('redo') },
      ],
      [{ label: 'New token', icon: <Plus aria-hidden="true" />, disabled: !canCreate || view !== 'tokens', run: () => create(false) },
        { label: 'New group', icon: <Plus aria-hidden="true" />, disabled: !canCreate || view !== 'tokens', run: () => create(true) },
        { label: 'Add group value', icon: <Plus aria-hidden="true" />, disabled: !canAddGroupValue || view !== 'tokens', run: () => create(false, '$root') },
        { label: 'Edit token', icon: <Pencil aria-hidden="true" />, disabled: !inspected || menuDisabled || view !== 'tokens', run: showInspector },
        ...editActions.map(({ label, run }) => ({ label: label + '…', icon: <SquarePen aria-hidden="true" />,
          disabled: !!current || !checked.size || menuDisabled || view !== 'tokens', run })),
        { label: 'Move selected tokens…', icon: <ArrowRightLeft aria-hidden="true" />, disabled: !!current || !checked.size || menuDisabled || view !== 'tokens', run: () => setRelocate({ paths: [...checked], operation: 'move' }) },
        { label: 'Duplicate selected tokens…', icon: <Copy aria-hidden="true" />, disabled: !!current || !checked.size || menuDisabled || view !== 'tokens',
          run: () => setRelocate({ paths: [...checked], operation: 'duplicate' }) },
        { label: 'Delete selected tokens…', icon: <Trash2 aria-hidden="true" />, disabled: !!current || !checked.size || menuDisabled || view !== 'tokens', destructive: true, run: () => deletePaths([...checked]) }],
      [
      { label: 'Copy selected tokens', icon: <Copy aria-hidden="true" />,
        disabled: !!activeResolver || view !== 'tokens' || menuDisabled || !checked.size && !selected,
        run: () => copyPaths(checked.size ? [...checked] : [selected]) },
      { label: 'Paste into group…', icon: <ClipboardPaste aria-hidden="true" />,
        disabled: !!activeResolver || view !== 'tokens' || menuDisabled || !folder.files.size,
        run: () => { void pasteIntoGroup(group); } },
    ]] },
    { label: 'View', sections: [[
      { label: 'Workspace issues', icon: <AlertCircle aria-hidden="true" />,
        disabled: menuDisabled || diagnosticsCount === 0, run: () => setDiagnosticsOpen(true) },
      { label: treeLabel, icon: treeIcon, disabled: view !== 'tokens' || menuDisabled, run: toggleTree },
      { label: inspectorLabel, icon: inspectorOpen ? <X aria-hidden="true" /> : <Pencil aria-hidden="true" />, disabled: view !== 'tokens' || menuDisabled, run: toggleInspector },
      { label: 'Source files', icon: <FolderOpen aria-hidden="true" />, disabled: menuDisabled, run: () => setView('workspace') },
    ]] },
    { label: 'Variants', sections: [[
      current ? { label: 'Manage variants', icon: <Settings2 aria-hidden="true" />, disabled: menuDisabled, run: manageVariants } :
        { label: 'Set up variants…', icon: <Settings2 aria-hidden="true" />, disabled: menuDisabled, run: setUpVariants },
      { label: comparing ? 'Return to active variant' : 'Compare variants', icon: <ArrowRightLeft aria-hidden="true" />,
        disabled: !current || menuDisabled, run: () => { setView('tokens'); setComparing(!comparing); } },
    ]] },
  ];

  function openInspector(path: string) {
    select(path);
    showInspector();
  }

  function showInspector() {
    setInspectorOpen(true);
    if (!desktop) setMobileTree(false);
    requestAnimationFrame(() => { inspectorCloseButton.current?.focus({ preventScroll: true }); });
  }

  function closeInspector() {
    if (busy) return;
    setVariantEdit(undefined);
    setVariantDirty(false);
    if (draft && !draft.create && draft.mode === 'inspector') cancel(false);
    setInspectorOpen(false);
    const opener = detailsButton.current ?? grid.current?.querySelector<HTMLElement>(
      '[data-token-row="' + CSS.escape(selected) + '"] [data-edit-column="' + activeColumn + '"]');
    opener?.focus({ preventScroll: true });
  }

  function toggleInspector() {
    if (inspectorOpen) closeInspector();
    else showInspector();
  }

  return <div data-component-assets className="workspace">
    <div className="workspace-top">
      <header className="workspace-header">
        <CommandBar menus={menus} />
        <span className="workspace-document" data-workspace-name title={data.name}>{data.name}</span>
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
        <div className="workspace-review">
          {submittedUrl && !dirty ? <ButtonLink href={submittedUrl} target="_blank" rel="noreferrer"
            aria-label="View pull request">View PR</ButtonLink> :
            <Button size="small" disabled={menuDisabled || !dirty || !hasChanges} onClick={() => { void reviewForSave(); }}
              aria-label={reviewLabel}>Review<span className="hidden lg:inline"> changes</span></Button>}
        </div>
      </header>
      {linkedProposal && <div className="workspace-proposal">
        <p className="me-auto">Linked changes apply to matching tokens in this workspace.</p>
        <Button variant="text" disabled={busy} onClick={() => setLinkedProposal('')}>Dismiss</Button>
        <Button size="small" disabled={busy || !!draft} onClick={reviewLinkedProposal}>Review linked changes</Button>
      </div>}
      {error && !draft && !review && !finalReview && !importChanges && <Alert variant="destructive" className="shrink-0 rounded-none border-x-0">
        <AlertDescription className="max-h-32 overflow-auto whitespace-pre-wrap">{error}</AlertDescription>
      </Alert>}
    </div>
    <NavigationRail label="Foundry" className="workspace-rail" width="default"
      footer={<IconButton label={themeLabel} title={themeLabel} onClick={toggleTheme}>
        {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </IconButton>}>
      <NavigationRailItem label="Tokens" icon={<Layers />} aria-current={view === 'tokens' ? 'page' : undefined}
        disabled={menuDisabled} onClick={() => setView('tokens')} />
      <NavigationRailItem label="Workspace" icon={<Settings2 />} aria-current={view === 'workspace' ? 'page' : undefined}
        disabled={menuDisabled} onClick={() => setView('workspace')} />
    </NavigationRail>
    <section className="workspace-management" aria-label="Workspace management" hidden={view !== 'workspace'}>
      <h2>Workspace</h2>
      <section aria-label="Source" ref={sourceManagement}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3>Source files</h3>
            <p>{data.name} · {saveTarget?.kind === 'pull-request' ? 'GitHub repository' :
              saveTarget?.kind === 'folder' ? 'Local folder' : 'Local workspace'}</p>
          </div>
          <Button size="small" variant="tonal" data-new-source disabled={menuDisabled} onClick={() => setSourceFileAction({ kind: 'create' })}>
            <Plus aria-hidden="true" /> New source file
          </Button>
        </div>
        <ul className="mt-2 grid gap-0.5">{data.files.map(file => <li key={file.path} className="flex min-w-0 items-center gap-1">
          <Button variant="text" size="xsmall" className="min-w-0" data-source-file={file.path} disabled={menuDisabled}
            onClick={() => setSourceLocation({ file: file.path, path: [] })}><code>{file.path}</code></Button>
          <CommandMenu label={'Actions for ' + file.path} icon={<MoreHorizontal aria-hidden="true" />} disabled={menuDisabled}
            sections={[[{
              label: 'Rename or move…', icon: <Pencil aria-hidden="true" />, run: () => setSourceFileAction({ kind: 'relocate', file: file.path }),
            }], [{
              label: 'Remove file…', icon: <Trash2 aria-hidden="true" />, destructive: true, disabled: data.files.length < 2,
              run: () => setSourceFileAction({ kind: 'remove', file: file.path }),
            }]]} />
        </li>)}</ul>
      </section>
      <section aria-label="Changes">
        <h3>Changes</h3><p>{dirty && hasChanges ? 'Unsaved changes' : 'No pending changes'}</p>
      </section>
      <section aria-label="Integrations">
        <h3>Integrations</h3>
        {Connector ? <Connector disabled={menuDisabled} canReplace={canReplace} connect={(connection) =>
          activate(connection.workspace, { kind: 'pull-request', connection })} /> :
          <CommandMenu label="Integrations" sections={[[{
            label: 'Open GitHub repository…', icon: <GitPullRequest aria-hidden="true" />, disabled: true,
            title: 'GitHub integration is available in the hosted editor.', run: () => undefined,
          }]]} />}
      </section>
    </section>
    <WorkspacePanes hidden={view !== 'tokens'} groupsOpen={treeVisible} inspectorOpen={inspectorOpen} grid={grid} groups={
      <aside id="groups" aria-label="Groups" hidden={!treeVisible} className="workspace-sidebar" onCopy={event => copySelection(event, true)} onPaste={pasteSelection}>
        <div className="workspace-sidebar-heading">
          <h2 className="me-auto min-w-0 truncate text-sm font-medium" title="Token groups">Groups</h2>
          <GroupActions path={displayedGroup} disabled={menuDisabled || !folder.definitions.size} variant={!!current}
            authored={canCreate} addGroupValue={canAddGroupValue ? () => create(false, '$root') : undefined}
            metadata={() => setMetadataLocation({ kind: 'group', path: group })} create={() => create(true)}
            rename={() => setRelocate({ paths: [group], operation: 'rename' })}
            move={() => setRelocate({ paths: [group], operation: 'move' })}
            duplicate={() => setRelocate({ paths: [group], operation: 'duplicate' })}
            copy={() => copyPaths([group])} paste={() => { void pasteIntoGroup(group); }}
            remove={() => deletePaths([group])} />
        </div>
        <fieldset disabled={!!draft || busy || variantDirty}>
          <FolderTree key={data.name} ref={groupsTree} graph={graph} current={displayedGroup} select={selectGroup} independentExpansion />
        </fieldset>
      </aside>
    } inspector={
      <SideSheet id="token-inspector" hidden={!inspectorOpen} variant="detached" className="workspace-inspector"
        title="Token details" onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) closeInspector(); }}
        headerAction={<IconButton ref={inspectorCloseButton} size="xsmall" label="Close inspector" disabled={busy} onClick={closeInspector}><X aria-hidden="true" /></IconButton>}>
        {inspectorOpen && (inspectorInitial ? <div className="grid gap-4" key={selected}>
          <code className="wrap-anywhere">{selected}</code>
          {inspected?.inheritedFrom && <div className="grid gap-1 text-xs text-muted-foreground">
            <p className="wrap-anywhere">Inherited from {inspected.inheritedFrom.path} · {inspected.inheritedFrom.file}</p>
            <Button variant="text" size="xsmall" className="justify-self-start" disabled={menuDisabled}
              onClick={() => { if (inspected.inheritedFrom) jump(inspected.inheritedFrom.path); }}>Go to source token</Button>
          </div>}
          {!inspected?.inheritedFrom && inspected?.overrides && <p className="wrap-anywhere text-xs text-muted-foreground">
            Overrides {inspected.overrides.path} · {inspected.overrides.file}
          </p>}
          {inspected?.deprecated && <p className="wrap-anywhere text-xs">Deprecated{typeof inspected.deprecated === 'string' ? ' · ' + inspected.deprecated : ''}</p>}
          {current ? <>
            <div className="grid gap-1 text-sm">
              <p className="font-medium">{winner?.modifier ? winner.context + ' override' : 'Shared value'}</p>
              <TokenValue value={graph.resolved.get(selected)} swatch={inspected?.type === 'color'} wrap />
            </div>
            <div className="flex flex-wrap gap-1">
              {sharedOrigin && <Button size="xsmall" variant="tonal" disabled={menuDisabled}
                onClick={() => { setError(''); setVariantEdit({ path: selected, origin: sharedOrigin }); }}>Edit shared value</Button>}
              {winner?.modifier && <Button size="xsmall" variant="tonal" disabled={menuDisabled}
                onClick={() => { setError(''); setVariantEdit({ path: selected, origin: winner }); }}>Edit {winner.context} override</Button>}
              {overrideTargets.map(origin => <Button key={origin.modifier} size="xsmall" variant="text" disabled={menuDisabled}
                onClick={() => { setError(''); setVariantEdit({ path: selected, origin, insert: true }); }}>Override for {origin.context}</Button>)}
            </div>
            {variantEdit && variantValue !== undefined && <>
              <p className="text-xs font-medium">{variantEdit.origin.modifier ? 'Editing ' + variantEdit.origin.context + ' override' : 'Editing shared value'}</p>
              <TokenEditForm key={JSON.stringify(variantEdit)} valueOnly initialDraft={{ ...inspectorInitial, type: variantType,
                original: variantValue, value: displayInput(variantType, variantValue) }}
              graph={graph} busy={busy} onEdit={() => setVariantDirty(true)}
              cancel={() => { setVariantEdit(undefined); setVariantDirty(false); }} error={error} commit={commitVariant} /></>}
            {!!origins.length && <details className="text-xs"><summary className="cursor-pointer">Where this value comes from</summary>
              <ul className="mt-1 grid gap-1">{origins.toReversed().map((origin, index) =>
                <li key={JSON.stringify([origin, index])}><Button size="xsmall" variant="text" disabled={busy}
                  onClick={() => setSourceLocation({ file: origin.file, path: origin.parts, ...(variantScope ? { resolver: variantScope } : {}) })}>
                  {index === 0 ? 'Current value' : 'Earlier value'} · {labelOrigin(origin)}</Button></li>)}</ul>
            </details>}
          </> : <TokenEditForm initialDraft={inspectorInitial} graph={graph} busy={busy || !!draft && !inspectorDraft}
            inspectorActive={!!inspectorDraft} onEdit={() => setDraft(inspectorInitial)} cancel={() => cancel(false)} error={inspectorDraft ? error : ''}
            commit={commit} />}
          <ReferenceDetails path={selected} graph={graph} jump={jump} disabled={menuDisabled} />
        </div> : <p className="workspace-inspector-empty">Select a token to see its details.</p>)}
      </SideSheet>
    }>
      <main ref={workspacePane} aria-label="Token library" className="workspace-main @container/grid" onCopy={copySelection} onPaste={pasteSelection}>
        <section aria-label="Token commands" className="workspace-tools">
    {activeResolver && model && current && variantScope && <div>
      {resolvers.length > 1 && <label className="flex flex-wrap items-center gap-2 text-sm">Variant configuration
        <NativeSelect aria-label="Variant configuration" disabled={menuDisabled} value={activeResolver.path} onChange={event => { setResolverFile(event.target.value); setPrimary({}); setSecondary({}); setVariantEdit(undefined); clearSelection(); }}>
          {resolvers.map(resolver => <NativeSelectOption key={resolver.path} value={resolver.path}>{resolver.path}</NativeSelectOption>)}
        </NativeSelect>
      </label>}
      <ResolverPane key={activeResolver.path} workspace={data} file={activeResolver.path} disabled={menuDisabled} {...{ model, current, alternative, primary, secondary, comparing, setComparing, definitionOpen, setDefinitionOpen }}
        scope={variantScope} setPrimary={value => { setPrimary(value); setVariantEdit(undefined); clearSelection(); }} setSecondary={setSecondary}
        prepareReview={async (pending, scope) => {
          setBusy(true);
          try {
            return await runWorkspaceReview({ kind: 'resolver', workspace: data, draft: pending, scope });
          } finally {
            setBusy(false);
          }
        }} editSource={setSourceLocation} reviewing={!!review} review={(next, onApply, focusAfterApply) => {
          afterReviewApplied.current = () => {
            onApply?.();
            resolverFocusAfterApply.current = focusAfterApply ?? null;
          };
          setError('');
          setReview(next);
        }} />
    </div>}

          <section aria-label="Group context" className="workspace-heading">
            <IconButton size="xsmall" label={treeLabel} title={treeLabel} aria-controls="groups" aria-expanded={treeVisible}
              disabled={menuDisabled} onClick={toggleTree}>{treeIcon}</IconButton>
            <div className="workspace-path flex min-w-0 items-center gap-1">
              <h2 data-workspace-group-title tabIndex={-1} title={displayedGroup || 'All tokens'}>
                {parentPath(displayedGroup) && <span className="workspace-ancestors">{parentPath(displayedGroup).split('.').join(' / ')} / </span>}
                <span className="workspace-group-name">{leafName(displayedGroup) || 'All tokens'}</span>
              </h2>
              {!current && <Button className="hidden shrink-0 sm:inline-flex" size="xsmall" variant="text"
                disabled={menuDisabled} onClick={setUpVariants}>Set up variants</Button>}
            </div>
            <SearchBar ref={tokenSearch} label="Search tokens in group" placeholder="Search tokens" leading={<Search aria-hidden="true" />}
              className="workspace-search" title={group ? 'Search in ' + group : 'Search all tokens'}
              action={query ? <IconButton className="md-search-action" size="xsmall" label="Clear token search" disabled={menuDisabled}
                onClick={() => {
                  if (tokenSearch.current) tokenSearch.current.value = '';
                  searchTokens('');
                  tokenSearch.current?.focus();
                }}><X aria-hidden="true" /></IconButton> : undefined}
              disabled={menuDisabled} onChange={event => searchTokens(event.currentTarget.value)} />
          </section>
          <div className="workspace-command-row">
            <div className="workspace-filters flex min-w-0 gap-1">
              {diagnosticsCount > 0 && <Button size="xsmall" variant="text" className="tabular-nums"
                disabled={menuDisabled} onClick={() => setDiagnosticsOpen(true)}>
                <AlertCircle aria-hidden="true" /> Issues ({diagnosticsCount})
              </Button>}
              {unresolvedCount > 0 && <Button size="xsmall" className="tabular-nums" variant={showOnlyUnresolved ? 'tonal' : 'outlined'}
                pressed={showOnlyUnresolved} disabled={menuDisabled} onClick={() => {
                  setOnlyUnresolved(!showOnlyUnresolved);
                  setPage(0);
                  select('');
                  resetScroll();
                }}><AlertCircle aria-hidden="true" /> Unresolved ({unresolvedCount})</Button>}
            </div>
            {!current ? <div className="workspace-actions" aria-label="Selected tokens">
              {editActions.map(({ action, label, run }) => <Button key={action} size="xsmall"
                variant={checked.size && suggestedEdit === action ? 'tonal' : 'text'} title={checked.size ? label + ' · ' + selectedTokenLabel : label}
                disabled={menuDisabled || !checked.size} onClick={event => { bulkTrigger.current = event.currentTarget; run(); }}>{label}</Button>)}
              <Button size="xsmall" variant="text" disabled={menuDisabled || !checked.size} title="Move selected tokens"
                onClick={() => setRelocate({ paths: [...checked], operation: 'move' })}>Move</Button>
              <Button size="xsmall" variant="text" disabled={menuDisabled || !checked.size} title="Duplicate selected tokens"
                onClick={() => setRelocate({ paths: [...checked], operation: 'duplicate' })}>Duplicate</Button>
              <Button size="xsmall" variant="text" disabled={menuDisabled || !checked.size} title="Delete selected tokens"
                onClick={() => deletePaths([...checked])}>Delete</Button>
            </div> : <Button size="xsmall" variant="text" ref={detailsButton} aria-label="Edit token" title="Edit token"
              aria-controls="token-inspector" aria-expanded={inspectorOpen} disabled={menuDisabled}
              onClick={showInspector}><Pencil aria-hidden="true" /><span className="workspace-edit-label">Edit token</span></Button>}
            <Button size="xsmall" variant="filled" disabled={menuDisabled || !(current ? sourceChoices.size : folder.files.size)} onClick={() => create(false)}>
              <Plus aria-hidden="true" /> New token
            </Button>
          </div>
        </section>
        <div ref={grid} aria-busy={busy} className="min-h-0 flex-1 [&>[data-slot=table-container]]:h-full [&>[data-slot=table-container]]:overflow-auto">
          {current && alternative ? <VariantComparison {...{ current, alternative }} group={displayedGroup} query={search} /> :
          <TokenGrid narrow={!desktop} variant={!!current} group={displayedGroup} {...{ rows, graph, selected, activeColumn, checked, setChecked, select, edit, draft, setDraft, busy, cancel, commit, error }}
            metadata={path => setMetadataLocation({ kind: 'token', path })} restoreInherited={restoreInherited} inspect={openInspector} move={path => setRelocate({ paths: [path], operation: 'move' })}
            duplicate={path => setRelocate({ paths: [path], operation: 'duplicate' })} copy={path => copyPaths([path])} remove={path => deletePaths([path])} />}
        </div>
        <footer className="workspace-footer">
          <span>{filtered.length.toLocaleString('en')} {filtered.length === 1 ? 'token' : 'tokens'}</span>
          {draft && !draft.create && draft.mode === 'inline' && error ?
            <output id="inline-edit-error" role="alert" className="text-destructive">{error}</output> :
            <output>{saveStatus}</output>}
          <div className="workspace-footer-end">
            {pages > 1 && <div className="workspace-pagination">
              <IconButton size="xsmall" label="Previous page" disabled={shownPage === 0 || !!draft}
                onClick={() => { setPage(shownPage - 1); select(''); resetScroll(); }}><ChevronLeft aria-hidden="true" /></IconButton>
              <span>Page {shownPage + 1} of {pages}</span>
              <IconButton size="xsmall" label="Next page" disabled={shownPage + 1 === pages || !!draft}
                onClick={() => { setPage(shownPage + 1); select(''); resetScroll(); }}><ChevronRight aria-hidden="true" /></IconButton>
            </div>}
            <div className="workspace-selection-count">
              <span aria-live="polite" className="tabular-nums">
                {checked.size > 0 && <>{selectionCount} selected{hiddenChecked > 0 && ` · ${hiddenChecked} not shown`}</>}
              </span>
              {checked.size > 0 && <IconButton size="xsmall" label="Clear selection" title="Clear selection" disabled={menuDisabled}
                onClick={clearCheckedSelection}><X aria-hidden="true" /></IconButton>}
            </div>
          </div>
        </footer>
      </main>
    </WorkspacePanes>
    {newResolver && <ActionDialog open={!review} title="Set up variants" onOpenChange={open => { if (!open) setNewResolver(false); }}>
      <form className="grid gap-3" onSubmit={event => {
        event.preventDefault();
        const name = resolverName.trim();
        const stem = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'resolver';
        const prefix = saveTarget?.kind === 'pull-request' && saveTarget.connection.root ? saveTarget.connection.root + '/' : '';
        const file = prefix + stem + '.resolver.json';
        if (data.files.some(source => source.path === file)) {
          setResolverError('A document named ' + file + ' is already open. Choose another name.');
          return;
        }
        const sources = data.files.filter(source => !isResolverFile(source) && !source.parseIssue);
        const json = newResolverDocument(name);
        if (sources.length) {
          json['sets'] = { foundation: { sources: sources.map(source => ({ $ref: serializeTokenPointer(file, source.path, []).slice(0, -1) })) } };
          json['resolutionOrder'] = [{ $ref: '#/sets/foundation' }];
        }
        try {
          const next = reviewCreateSource(data, file, JSON.stringify(json, null, 2) + '\n');
          afterReviewApplied.current = () => { setNewResolver(false); setView('tokens'); setResolverFile(file); setDefinitionOpen(true); };
          setReview(next);
        } catch (failure) {
          setResolverError(errorMessage(failure));
        }
      }}>
        <TextField label="Configuration name" required data-initial-focus value={resolverName} onChange={event => setResolverName(event.target.value)} />
        {resolverError && <Alert variant="destructive"><AlertDescription>{resolverError}</AlertDescription></Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="text" data-dialog-close="">Cancel</Button>
          <Button type="submit" disabled={!resolverName.trim()}>Set up variants</Button>
        </div>
      </form>
    </ActionDialog>}
    <ActionDialog open={importChanges} busy={busy} title="Import proposal" onOpenChange={(open) => {
      if (!busy && !open) { setImportChanges(false); setError(''); }
    }} description="Choose a file with edits to the tokens you have open. You’ll review the changes before applying them."
      actions={<Button disabled={busy} onClick={() => proposalInput.current?.click()}>Choose file…</Button>}>
      {importChanges && error && <Alert variant="destructive"><AlertDescription className="max-h-36 overflow-auto whitespace-pre-wrap">{error}</AlertDescription></Alert>}
    </ActionDialog>
    {diagnosticsOpen && <DiagnosticsDialog graph={diagnosticGraph} close={() => setDiagnosticsOpen(false)} editSource={setSourceLocation}
      sourceFor={(issue, location) => {
        if (!current || location.file !== model?.file || issue.target.kind === 'source' || issue.offset !== undefined) return location;
        const source = winningOrigins(current, issue.path).at(-1);
        return source ? { ...location, file: source.file, path: [...source.parts, ...location.path.slice(issue.path.split('.').length)],
          ...(variantScope ? { resolver: variantScope } : {}) } : location;
      }}
      jump={({ kind, path }) => { setView('tokens'); if (kind === 'token') jump(path); else selectGroup(path); }} />}
    {metadataLocation && <MetadataDialog workspace={data} location={metadataLocation} reviewing={!!review}
      close={() => setMetadataLocation(null)} prepare={(file, changes) => reviewMetadata(data, file, metadataLocation.path, changes)}
      review={next => { setError(''); setReview(next); }} />}
    {paste && <PasteDialog workspace={data} entries={paste.entries} group={paste.group}
      reviewing={!!review} close={() => setPaste(null)} review={next => {
        afterReviewApplied.current = () => {
          setPaste(null);
          pastedGroupFocus.current = true;
        };
        setError('');
        setReview(next);
      }} />}
    {bulkEdit && <BulkEditDialog workspace={data} {...bulkEdit}
      reviewing={!!review} close={() => setBulkEdit(null)} review={next => {
        afterReviewApplied.current = () => {
          bulkFocusAfterReview.current = true;
          setBulkEdit(null);
        };
        setError('');
        setReview(next);
      }} />}
    {sourceFileAction && <SourceFileDialog action={sourceFileAction} workspace={data}
      root={saveTarget?.kind === 'pull-request' ? saveTarget.connection.root : ''}
      reviewing={!!review} close={() => setSourceFileAction(null)} review={next => {
        afterReviewApplied.current = () => {
          const destination = next.structure?.paths[0]?.to;
          if (sourceFileAction.kind === 'relocate' && sourceFileAction.file === activeResolver?.path && destination) {
            setResolverFile(destination);
          }
          sourceFocusAfterReview.current = destination ?? (sourceFileAction.kind === 'create'
            ? next.next.files.find(file => !data.files.some(existing => existing.path === file.path))?.path ?? ''
            : '');
          setSourceFileAction(null);
        };
        setError('');
        setReview(next);
      }} />}
    {sourceLocation && <SourceDialog location={sourceLocation} reviewing={!!review} close={() => setSourceLocation(null)}
      original={requireValue(data.files.find(file => file.path === sourceLocation.file), 'source file').text}
      prepare={(text, signal) => runWorkspaceReview({
        kind: 'source', workspace: data, file: sourceLocation.file, scope: sourceLocation.resolver, text,
      }, signal)} review={next => { setError(''); setReview(next); }} />}
    {relocate && <MoveDialog {...relocate} graph={graph} reviewing={!!review} close={() => setRelocate(null)}
      prepare={moves => relocate.operation === 'duplicate' ? reviewDuplicate(data, moves) : reviewMoves(data, moves, relocate.operation === 'rename')}
      review={pending => {
        afterReviewApplied.current = () => setRelocate(null);
        setError('');
        if (pending.structure) pending.structure.title = 'Review ' + pending.structure.title.toLowerCase();
        setReview(pending);
      }} />}
    {draft?.create && <ActionDialog open={!review} busy={busy} title={draft.groupOnly ? 'New group' : draft.name === '$root' ? 'Add group value' : 'New token'}
      description={displayedGroup || 'All tokens'} onOpenChange={(open) => { if (!open && !busy) cancel(); }}>
      <TokenEditForm initialDraft={draft} {...{ graph, busy, cancel, error, commit }} {...(current && model ? { sourceChoices, referenceFile: model.file } : {})} />
    </ActionDialog>}
    <ReviewChanges {...{ review, busy, error }} close={closeReview} save={saveReview} onClosed={() => {
      resolverFocusAfterApply.current?.focus();
      resolverFocusAfterApply.current = null;
      const sourcePath = sourceFocusAfterReview.current;
      if (sourcePath !== null) {
        sourceFocusAfterReview.current = null;
        const files = sourceManagement.current?.querySelectorAll<HTMLButtonElement>('[data-source-file]');
        const destination = files && [...files].find(button => button.dataset['sourceFile'] === sourcePath);
        (destination ?? sourceManagement.current?.querySelector<HTMLButtonElement>('[data-new-source]'))?.focus();
      }
      if (pastedGroupFocus.current) {
        pastedGroupFocus.current = false;
        workspacePane.current?.querySelector<HTMLElement>('[data-workspace-group-title]')?.focus();
      }
      if (bulkFocusAfterReview.current) {
        bulkFocusAfterReview.current = false;
        bulkTrigger.current?.focus();
      }
      if (!refocusAfterReview.current) return;
      refocusAfterReview.current = false;
      setFocusRequest(request => request && { ...request });
    }} />
    <ReviewChanges review={finalReview} busy={busy} error={error}
      notice={revisionReview === 'stale' ? 'The default branch changed. Review the latest revision before opening a pull request.' :
        revisionReview === 'refreshed' ? 'This diff and its resolved values use the latest revision.' : ''}
      confirm={revisionReview === 'stale' ? 'Review latest revision' : saveTarget?.kind === 'folder' ? 'Save to folder' : saveTarget ? 'Create pull request' : 'Download patch'}
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
