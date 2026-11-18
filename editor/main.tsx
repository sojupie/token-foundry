import { startTransition, StrictMode, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ClipboardEvent, ComponentType } from 'react';
import { errorMessage, isJsonObject, requireValue } from '../lib/json.ts';
import type { JsonObject } from '../lib/json.ts';
import { penpotSets } from '../lib/penpot-import.ts';
import { diagnosticKey } from '../lib/document-diagnostics.ts';
import type { DocumentGraph } from '../lib/document.ts';
import type { TokenNode } from '../lib/token-types.ts';
import { authoredResolverValue, compileResolver, isResolverFile, resolverInputs, resolverLayer, resolverValueAt, winningOrigins } from '../lib/resolver.ts';
import type { ResolverOrigin } from '../lib/resolver.ts';
import type { MoveDestination } from '../lib/workspace.ts';
import { serializeTokenPointer } from '../lib/token-path.ts';
import { copyEntries, decodeClipboard, encodeClipboard } from '../lib/structure.ts';
import type { ClipboardEntry } from '../lib/structure.ts';
import { PasteDialog } from './paste-dialog.tsx';
import { ContextInputs, ResolverPane, VariantComparison, downloadEditableSources, downloadVariant, labelOrigin, originName, variantLabel } from './resolver-pane.tsx';
import type { Inputs } from './resolver-pane.tsx';
import { openWorkspace, reviewAgainstLatest, reviewCreateSource, reviewDelete, reviewDuplicate, reviewEdit, reviewMove, reviewMoves, reviewRenameWithEdit, reviewMetadataChanges, workspaceChanges } from '../lib/workspace.ts';
import type { ResolverEditScope, Review, Workspace } from '../lib/workspace.ts';
import { countTokenIssues, queryTokenRows, tokenRowIndex } from './lib/token-rows.ts';
import { createGridSelection } from './lib/grid-selection.ts';
import { useVariantResolution } from './lib/variant-resolution.ts';
import { runWorkspaceReview } from './lib/workspace-review.ts';
import type { ResolverEdit } from './lib/workspace-review.ts';
import type { CellPosition, Draft, EditableColumn, GridColumn } from './lib/draft.ts';
import type { WorkspaceConnection, WorkspaceConnectorProps } from './lib/connector.ts';
import { OpenGitHub } from '../integrations/github/connect.tsx';
import { createRoot } from 'react-dom/client';
import { AlertCircle, ArrowDownToLine, ArrowRightLeft, ArrowUpRight, ChevronLeft, ChevronRight, ClipboardPaste, Copy, FileText, FileUp, FolderOpen, GitPullRequest, Keyboard, Layers, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Redo2, Search, Settings2, Shapes, SlidersHorizontal, Sun, TextCursorInput, Trash2, Undo2, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ChipSelect, Disclosure, Button, ButtonLink, IconButton, NavigationRail, NavigationRailItem, SearchBar, SideSheet, Select, SelectOption } from '@token-catalog/forge-react';
import { BulkEditDialog, selectionEditLabels } from './bulk-edit-dialog.tsx';
import { ReviewChanges } from './review-dialog.tsx';
import type { SelectionEdit } from './bulk-edit-dialog.tsx';
import { DiagnosticsDialog } from './diagnostics-dialog.tsx';
import { VariantSetupDialog } from './variant-setup-dialog.tsx';
import { SourceFileDialog } from './source-file-dialog.tsx';
import type { SourceFileAction } from './source-file-dialog.tsx';
import { SourceDialog } from './source-dialog.tsx';
import type { SourceLocation } from './source-dialog.tsx';
import { MoveDialog } from './move-dialog.tsx';
import type { MoveOperation } from './move-dialog.tsx';
import { FolderTree } from './folder-tree';
import type { FolderTreeHandle } from './folder-tree.tsx';
import { WorkspacePanes } from './pane-resize.tsx';
import type { GridData } from './token-grid';
import { RenderData, useRenderData } from './lib/render-data.ts';
import { TokenGrid } from './token-grid';
import { CommandBar, CommandMenu } from './command-bar.tsx';
import { KeyTips } from './key-tips.tsx';
import { useWorkspaceRovingButtons } from './roving-buttons.ts';
import type { KeyTipsHandle } from './key-tips.tsx';
import type { Menu } from './command-bar.tsx';
import { MetadataDialog } from './metadata-dialog.tsx';
import type { MetadataLocation } from './metadata-dialog.tsx';
import { GroupActions } from './group-actions.tsx';
import { ReferenceDetails } from './reference-details.tsx';
import { tokenDisplayName } from './lib/value-shape.ts';
import { TokenValue } from './token-value.tsx';
import { TokenEditForm } from './token-edit-form.tsx';
import { ActionDialog } from '@/components/ui/dialog';
import { displayInput, inputFormat, readInput, validateInputValue } from './lib/token-input';
import { canEditType, defaultValue } from './lib/value-shape.ts';
import { referenceProblems, leafName, parentPath, referenceLabel } from '../lib/document.ts';
import { download, downloadPatch, openExample, openFiles, openMaterialExample } from './lib/sources.ts';
import { openLocalFolder } from './lib/local-folder.ts';
import './workspace.css';
import './components/ui/primitives.css';
import '@token-catalog/forge-react/styles.css';

const pageSize = 100;
const defaultVariantInputs: Inputs = {};

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
  const [workspace, setData] = useState(openExample);
  const [initiallyExpanded, setInitiallyExpanded] = useState<string>();
  const [history, setHistory] = useState(emptyHistory);
  const [group, setGroup] = useState('');
  const [query, setQuery] = useState('');
  const [onlyUnresolved, setOnlyUnresolved] = useState(false);
  const [gridSelection] = useState(createGridSelection);
  const { selected, activeColumn, checked } = useSyncExternalStore(gridSelection.subscribe, gridSelection.getSnapshot);
  const { setSelected, setActiveColumn, setChecked } = gridSelection;
  const [paste, setPaste] = useState<{ entries: ClipboardEntry[]; group: string } | null>(null);
  const pastedGroupFocus = useRef(false);
  const groupsTree = useRef<FolderTreeHandle>(null);
  const clipboard = useRef({ text: '', tabOnly: false });
  const [bulkEdit, setBulkEdit] = useState<{ paths: readonly string[]; action: SelectionEdit } | null>(null);
  const bulkTrigger = useRef<HTMLButtonElement>(null);
  const bulkFocusAfterReview = useRef(false);
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
  const [view, setView] = useState<'tokens' | 'workspace' | 'variants'>('tokens');
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
  const [penpotOpen, setPenpotOpen] = useState(false);
  const [penpotFile, setPenpotFile] = useState<{ name: string; text: string; sets: string[] } | null>(null);
  const [penpotSet, setPenpotSet] = useState('');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const keyTips = useRef<KeyTipsHandle>(null);
  const [metadataLocation, setMetadataLocation] = useState<MetadataLocation | null>(null);
  const variantsHeading = useRef<HTMLHeadingElement>(null);
  const sourceManagement = useRef<HTMLElement>(null);
  const sourceFocusAfterReview = useRef<string | null>(null);
  const [sourceFileAction, setSourceFileAction] = useState<SourceFileAction | null>(null);
  const [sourceLocation, setSourceLocation] = useState<SourceLocation | null>(null);
  const [primary, setPrimary] = useState<Inputs>({});
  const [secondary, setSecondary] = useState<Inputs>({});
  const [comparing, setComparing] = useState(false);
  const [editingSet, setEditingSet] = useState<string>();
  const [variantDirty, setVariantDirty] = useState(false);
  const [variantEdit, setVariantEdit] = useState<{ path: string; origin: ResolverOrigin; insert?: true }>();
  const [resolverFile, setResolverFile] = useState('');
  const [newResolver, setNewResolver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const proposalInput = useRef<HTMLInputElement>(null);
  const penpotInput = useRef<HTMLInputElement>(null);
  const workspacePane = useRef<HTMLElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const [inspectorFooter, setInspectorFooter] = useState<HTMLDivElement | null>(null);
  const inspectorCloseButton = useRef<HTMLButtonElement>(null);
  const inspectorOpener = useRef<HTMLElement | null>(null);
  const tokenSearch = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const pendingRename = useRef<{ after: CellPosition | null | undefined } | null>(null);
  const refocusAfterReview = useRef(false);
  const [focusRequest, setFocusRequest] = useState<CellPosition | null>(null);
  const resolvers = useMemo(() => workspace.files.filter(isResolverFile), [workspace.files]);
  const librarySources = useMemo(() => workspace.files.filter(file => !file.parseIssue && !isResolverFile(file)), [workspace.files]);
  const activeResolver = resolvers.find(file => file.path === resolverFile) ?? resolvers[0];
  const model = useMemo(() => activeResolver && compileResolver(activeResolver, workspace.files.filter(file => !file.parseIssue)), [activeResolver, workspace.files]);
  const largeWorkspace = useMemo(() => workspace.files.reduce((sum, file) => sum + file.text.length, 0) >= 64_000, [workspace.files]);
  const activeVariant = useVariantResolution(model, primary, largeWorkspace);
  const resolution = activeVariant.value;
  const defaultEditingSet = useMemo(() => model && resolverInputs(model, defaultVariantInputs).errors.length ?
    (model.order.find(entry => entry.kind === 'set')?.name ?? model.sets.keys().next().value) : undefined, [model]);
  const editChoices = useMemo(() => {
    if (!model) return [];
    return [...model.modifiers.values()].map(modifier => ({ modifier, options:
      [...modifier.contexts].filter(([, sources]) => sources.length).map(([name]) => ({
        name, value: JSON.stringify([modifier.name, name]),
      })),
    })).filter(({ options }) => options.length);
  }, [model]);
  const scopeKey = editingSet ?? defaultEditingSet ?? '';
  const editChoice = useMemo(() => editChoices.flatMap(({ modifier, options }) => options.map(option => ({ modifier, ...option })))
    .find(option => option.value === scopeKey && !model?.sets.has(scopeKey)), [editChoices, model, scopeKey]);
  const setName = model?.sets.has(scopeKey) ? scopeKey : undefined;
  const editingLabel = setName ?? editChoice?.name;
  const editModel = useMemo(() => model ? resolverLayer(model,
    setName !== undefined ? { set: setName } : editChoice ? { option: { modifier: editChoice.modifier.name, context: editChoice.name } } : {}) : undefined,
    [model, setName, editChoice]);
  const setResolution = useVariantResolution(editModel, defaultVariantInputs, largeWorkspace);
  const current = editModel ? setResolution.value : resolution;
  const data = workspace;
  const filesByPath = useMemo(() => new Map(data.files.map(file => [file.path, file])), [data.files]);
  const comparisonVariant = useVariantResolution(comparing ? model : undefined, secondary, largeWorkspace);
  const alternative = comparisonVariant.value;
  const resolvingVariant = activeVariant.pending || comparisonVariant.pending || setResolution.pending;
  const graph = current?.graph ?? data.graph;
  const preview = resolution && !resolution.errors.length ? resolution : undefined;
  const activeValueGraph = editModel ? preview?.graph : undefined;
  const previewLabel = preview ? variantLabel(preview) : undefined;
  const resolvedHeading = previewLabel && model?.modifiers.size ? 'Resolved in ' + previewLabel :
    editModel ? 'Resolved in this set' : 'Resolved value';
  const displayedGroup = nearestGroup(graph, group);
  const variantScope: ResolverEditScope | undefined = model && resolution ? { file: model.file, contexts: [
    { label: variantLabel(resolution), inputs: primary },
    ...(alternative && [...alternative.contexts].some(([name, value]) => resolution.contexts.get(name) !== value)
      ? [{ label: variantLabel(alternative), inputs: secondary }] : []),
  ] } : undefined;
  const diagnosticBase = model ? preview?.graph ?? data.graph : graph;
  const diagnosticGraph = useMemo(() => diagnosticBase === data.graph ? data.graph : {
    ...diagnosticBase,
    documentDiagnostics: [...new Map([...diagnosticBase.documentDiagnostics, ...data.graph.documentDiagnostics]
      .map(issue => [diagnosticKey(issue), issue])).values()],
  }, [diagnosticBase, data.graph]);
  const diagnosticsCount = useMemo(() => {
    let count = diagnosticGraph.documentDiagnostics.length;
    for (const [path, issue] of diagnosticGraph.issues) count += referenceProblems(diagnosticGraph, path, issue).length;
    for (const issues of diagnosticGraph.validation.values()) count += issues.length;
    return count;
  }, [diagnosticGraph]);
  const inspected = graph.tokens.get(selected);
  const readingDefinition = !!selected && (inspectorOpen || !!draft && !draft.create);
  const origins = current && readingDefinition ? winningOrigins(current, selected) : [];
  const winner = origins.at(-1);
  const previewOrigin = preview && readingDefinition ? winningOrigins(preview, selected).at(-1) : undefined;
  const needsDefinitionContext = !!(editModel && preview && readingDefinition &&
    (winner?.file !== previewOrigin?.file || winner?.parts.length !== previewOrigin?.parts.length ||
      winner?.parts.some((part, index) => part !== previewOrigin?.parts[index]) ||
      editChoice && preview.contexts.get(editChoice.modifier.name) !== editChoice.name));
  const definitionModel = useMemo(() => model && editModel
    ? { ...model, order: [...model.order.filter(entry => !editChoice || entry.name !== editChoice.modifier.name), ...editModel.order] }
    : undefined, [editChoice, editModel, model]);
  const definitionInputs = useMemo(() => editChoice ? { ...primary, [editChoice.modifier.name]: editChoice.name } : primary,
    [editChoice, primary]);
  const definitionResolution = useVariantResolution(needsDefinitionContext ? definitionModel : undefined, definitionInputs, largeWorkspace);
  const definitionContext = !needsDefinitionContext ? preview : definitionResolution.pending ? undefined : definitionResolution.value;
  const referenceGraph = editModel ? definitionContext?.graph : graph;
  const sharedOrigin = origins.findLast(origin => !origin.modifier);
  const groupOrigins = useMemo(() => {
    const originsForGroup = new Map<string, ResolverOrigin>();
    for (const origin of current?.origins.get(displayedGroup) ?? []) {
      if (!origin.modifier || editChoice) originsForGroup.set(JSON.stringify([origin.file, origin.parts]), origin);
    }
    return originsForGroup;
  }, [current, displayedGroup, editChoice]);
  const sourceChoices = useMemo(() => new Map([...groupOrigins].map(([key, origin]) => [key, labelOrigin(origin)])), [groupOrigins]);
  const overrideTargets = inspectorOpen && !editModel && current && model && inspected?.type ? [...model.modifiers.values()].flatMap(modifier => {
    const option = current.contexts.get(modifier.name);
    const site = option === undefined ? undefined : modifier.contextSites.get(option);
    const tree = site ? filesByPath.get(site.file)?.tree : undefined;
    const list = site && resolverValueAt(tree, site.parts);
    return site && option !== undefined && Array.isArray(list) && (winner?.modifier !== modifier.name || winner.context !== option) ?
      [{ file: site.file, parts: [...site.parts, String(list.length)], modifier: modifier.name, context: option }] : [];
  }) : [];
  const definitionEdit = variantEdit?.path === selected ? variantEdit :
    editModel && winner && !inspected?.inheritedFrom ? { path: selected, origin: winner, insert: undefined } : undefined;
  const variantOriginal = definitionEdit && (definitionEdit.insert ? current?.graph.resolved.get(definitionEdit.path) :
    resolverValueAt(filesByPath.get(definitionEdit.origin.file)?.tree, definitionEdit.origin.parts));
  const authoredVariant = isJsonObject(variantOriginal) ? variantOriginal : undefined;
  const variantValue = definitionEdit?.insert ? variantOriginal :
    authoredVariant && (Object.hasOwn(authoredVariant, '$value') ? authoredVariant['$value'] : { $ref: authoredVariant['$ref'] });
  const declaredType = typeof authoredVariant?.['$type'] === 'string' ? authoredVariant['$type'] : undefined;
  const variantType = definitionEdit?.insert ? inspected?.type : declaredType ?? inspected?.type;
  const definitionDescription = typeof authoredVariant?.['$description'] === 'string' ? authoredVariant['$description'] : '';
  const inspectorDraft = draft && !draft.create && draft.mode === 'inspector' ? draft : null;
  const inspectorInitial: Draft | null = inspected && inspectorOpen ? {
    create: false, mode: 'inspector', column: 'value', path: selected, name: leafName(selected),
    type: inspected.node.$type, original: inspected.value, value: displayInput(inspected.type, inspected.value),
    originalDescription: inspected.node.$description ?? '', description: inspected.node.$description ?? '',
  } : null;
  const folder = requireValue(graph.groups.get(displayedGroup), 'current group');
  const search = query.trim().toLowerCase();
  const unresolvedPaths = diagnosticBase.issues;
  const unresolvedCount = useMemo(() => countTokenIssues(graph, unresolvedPaths, folder.start, folder.end),
    [graph, unresolvedPaths, folder]);
  const showOnlyUnresolved = onlyUnresolved && unresolvedCount > 0;
  const filtered = useMemo(() => search || showOnlyUnresolved
    ? queryTokenRows(graph, folder.start, folder.end, search, showOnlyUnresolved ? unresolvedPaths : undefined)
    : undefined, [graph, folder, search, showOnlyUnresolved, unresolvedPaths]);
  const rowCount = filtered?.length ?? folder.end - folder.start;
  const pages = Math.max(1, Math.ceil(rowCount / pageSize));
  const shownPage = Math.min(page, pages - 1);
  const rows = useMemo(() => {
    const offset = shownPage * pageSize;
    return filtered ? filtered.slice(offset, offset + pageSize) :
      graph.rows.slice(folder.start + offset, Math.min(folder.start + offset + pageSize, folder.end));
  }, [filtered, folder, graph, shownPage]);
  const gridData = useMemo(() => new RenderData<GridData>({
    rows, graph, activeValueGraph, resolution: preview, definition: editModel ? current : undefined,
  }), [rows, graph, activeValueGraph, preview, editModel, current]);
  const workspaceData = useRenderData(data);
  const reviewData = useRenderData(review);
  const finalReviewData = useRenderData(finalReview);
  const modelData = useMemo(() => model ? new RenderData(model) : undefined, [model]);
  const resolutionData = useMemo(() => resolution ? new RenderData(resolution) : undefined, [resolution]);
  const alternativeData = useMemo(() => alternative ? new RenderData(alternative) : undefined, [alternative]);
  const referenceData = useRenderData(referenceGraph ?? graph);
  const selectionCount = checked.size.toLocaleString('en');
  const selectedTokenLabel = selectionCount + (checked.size === 1 ? ' token' : ' tokens');
  const hiddenChecked = checked.size - rows.filter(([path]) => checked.has(path)).length;
  const saveStatus = busy ? 'Working…' : status || (dirty ? 'Unsaved changes' : '');
  const hasChanges = useMemo(() => workspaceChanges(data).length > 0, [data]);

  function activate(next: Workspace, target: SaveTarget | null = null, initialBranch?: string) {
    setView('tokens');
    setData(next);
    setInitiallyExpanded(initialBranch);
    setResolverFile('');
    setPrimary({});
    setSecondary({});
    setEditingSet(undefined);
    setComparing(false);
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
      const { workspace: opened, save } = await openLocalFolder(directory);
      activate(opened, { kind: 'folder', save });
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

  async function loadMd3(benchmark = false) {
    if (!canReplace()) return;
    setBusy(true);
    setError('');
    try {
      if (benchmark) {
        const response = await fetch('/__md3-sample.json');
        if (!response.ok) throw new Error('The Material 3 benchmark could not be loaded.');
        const file = new File([await response.blob()], 'md3-token-set.json', { type: 'application/json' });
        activate(await openFiles([file], false));
      } else activate(await openMaterialExample(), null, 'md');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }

  async function loadProposal(file: File) {
    if (draft || review || busy) return;
    setBusy(true);
    setError('');
    try {
      setReview(await runWorkspaceReview({ kind: 'proposal', workspace: data, text: await file.text() }));
      setImportChanges(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function loadPenpot(file: File) {
    setBusy(true);
    setError('');
    try {
      const text = await file.text();
      const sets = penpotSets(text);
      setPenpotFile({ name: file.name, text, sets });
      setPenpotSet(sets.length === 1 ? sets[0] ?? '' : '');
    } catch (failure) { setPenpotFile(null); setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function reviewPenpotFile() {
    if (!penpotFile || !penpotSet || busy) return;
    setError('');
    setBusy(true);
    try {
      setReview(await runWorkspaceReview({ kind: 'penpot', workspace: data, text: penpotFile.text, set: penpotSet }));
      setPenpotOpen(false);
      setPenpotFile(null);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function reviewLinkedProposal() {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      setReview(await runWorkspaceReview({ kind: 'proposal', workspace: data, text: linkedProposal }));
      setLinkedProposal('');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  useLayoutEffect(() => {
    if (!focusRequest) return undefined;
    // Wait for the next grid layout before restoring focus after an edit or jump.
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

  const clearTokenSearch = useCallback(() => {
    if (tokenSearch.current) tokenSearch.current.value = '';
    setQuery('');
  }, []);

  const clearSelection = useCallback((preserveSearch = false) => {
    setFocusRequest(null);
    setDraft(null);
    setVariantEdit(undefined);
    setSelected('');
    setChecked(previous => previous.size ? new Set() : previous);
    setPage(0);
    if (!preserveSearch) clearTokenSearch();
    setOnlyUnresolved(false);
  }, [clearTokenSearch, setChecked, setSelected]);

  const resetScroll = useCallback(() => {
    grid.current?.querySelector('[data-slot="table-container"]')?.scrollTo(0, 0);
  }, []);

  function searchTokens(value: string) {
    // The input owns its text. Updating the results can wait until the browser can paint it.
    startTransition(() => {
      setQuery(value);
      setPage(0);
      select('');
    });
    resetScroll();
  }

  const selectGroup = useCallback((path: string) => {
    if (variantDirty) return;
    if (path === displayedGroup) { setMobileTree(false); return; }
    setGroup(path);
    setMobileTree(false);
    setError('');
    clearSelection();
    resetScroll();
  }, [variantDirty, displayedGroup, clearSelection, resetScroll]);

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

  function copyTokenPath(path: string) {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(path).then(() => setStatus('Token path copied.'), () => setError('Could not copy the token path.'));
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
      !(event.target instanceof Element) || !event.target.closest('#token-grid')) return;
    event.preventDefault();
    setChecked(new Set());
    select('');
  });
  const enterGridFromPage = useEffectEvent((event: KeyboardEvent) => {
    if (view !== 'tokens' || event.defaultPrevented || menuDisabled || event.altKey || event.ctrlKey ||
      event.metaKey || event.shiftKey || event.isComposing || document.querySelector('dialog:modal')) return;
    const tokenGrid = document.getElementById('token-grid');
    if (!tokenGrid) return;
    const target = event.target;
    // Leave the initial Tab to the skip links. An arrow from the page
    // itself starts keyboard navigation in the grid.
    const fromPage = target === document.body && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key);
    const fromControls = event.key === 'Escape' && target instanceof Element &&
      (target === document.body || rovingButtons.ref.current?.contains(target)) &&
      !target.closest('#token-grid, .workspace-inspector, [role="menu"], [role="listbox"], input, select, textarea, [contenteditable]');
    if (fromPage || fromControls) {
      event.preventDefault();
      if (!desktop && mobileTree) focusTokenArea('token-grid');
      else tokenGrid.focus();
    }
  });
  const retainGridFocusOnBlankClick = useEffectEvent((event: MouseEvent) => {
    const target = event.target;
    if (menuDisabled || !(target instanceof Element) ||
      target.closest('button, a, input, textarea, select, label, summary, [contenteditable], [role="separator"], [role="listbox"]') ||
      document.querySelector('dialog:modal') || window.getSelection()?.isCollapsed === false) return;
    const cell = workspacePane.current?.querySelector<HTMLElement>('#token-grid [data-token-row] [tabindex="0"]');
    cell?.focus({ preventScroll: true });
  });
  useEffect(() => {
    const pane = workspacePane.current;
    const onKeyDown = (event: KeyboardEvent) => handleGridShortcut(event);
    // Scope workspace shortcuts to the token pane alongside React Aria's grid shortcuts.
    const onPageKeyDown = (event: KeyboardEvent) => enterGridFromPage(event);
    const onPaneClick = (event: MouseEvent) => retainGridFocusOnBlankClick(event);
    pane?.addEventListener('keydown', onKeyDown);
    pane?.addEventListener('click', onPaneClick);
    window.addEventListener('keydown', onPageKeyDown);
    return () => {
      pane?.removeEventListener('keydown', onKeyDown);
      pane?.removeEventListener('click', onPaneClick);
      window.removeEventListener('keydown', onPageKeyDown);
    };
  }, []);

  function jump(path: string) {
    const parent = parentPath(path);
    const targetGraph = graph.tokens.has(path) ? graph : preview?.graph;
    const target = targetGraph?.groups.get(parent);
    if (!targetGraph?.tokens.has(path) || !target) return;
    if (targetGraph !== graph) setEditingSet('');
    const start = target.start;
    setGroup(parent);
    groupsTree.current?.reveal(parent);
    clearTokenSearch();
    setOnlyUnresolved(false);
    setPage(Math.floor((tokenRowIndex(targetGraph, path) - start) / pageSize));
    setFocusRequest({ path, column: 'name' });
    select(path);
  }

  function edit(path: string, column: EditableColumn, link = false) {
    if (busy || draft || variantDirty) return;
    if (current && column === 'name' && canStructure(path)) {
      setRelocate({ paths: [path], operation: 'rename' });
      return;
    }
    if (current && (!editModel || column === 'name' || !winningOrigins(current, path).length || graph.tokens.get(path)?.inheritedFrom)) {
      openInspector(path);
      return;
    }
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
    if (busy) return;
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
    const historySources = direction === 'undo' ? history.past.at(-1) : history.future.at(-1);
    if (!historySources) return;
    const restored = { ...openWorkspace(data.name, historySources), baseline: data.baseline };
    const previousSnapshot = snapshot(data);
    setHistory(direction === 'undo'
      ? { past: history.past.slice(0, -1), future: [...history.future, previousSnapshot] }
      : { past: [...history.past, previousSnapshot], future: history.future.slice(0, -1) });
    setData(restored);
    setDirty(workspaceChanges(restored).length > 0);
    selectGroup(current ? group : nearestGroup(restored.graph, group));
    setStatus('');
  }

  function finishChange(next: Workspace, path: string, applied: Draft, after?: CellPosition | null) {
    applyWorkspace(next);
    setStatus('');
    if (applied.groupOnly) selectGroup(path);
    else if (applied.create) {
      clearTokenSearch();
      const index = tokenRowIndex(next.graph, path);
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
          const index = tokenRowIndex(next.graph, nextPath);
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
    if (draft && current) {
      applyWorkspace(review.next);
      if (draft.create) {
        if (draft.groupOnly) selectGroup(review.path);
        else setSelected(review.path);
      }
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

  async function checkVariantEdit(payload: ResolverEdit, path: string, applied?: () => void) {
    if (!variantScope) return;
    setBusy(true);
    try {
      const next = await runWorkspaceReview({ kind: 'resolver-edit', workspace: data, ...payload, scope: variantScope });
      afterReviewApplied.current = applied ?? null;
      next.path = path;
      setReview(next);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }

  function commitVariant(change: Draft, target = definitionEdit, after?: CellPosition | null): boolean {
    if (!model || !current || !target || busy) return false;
    const { path, origin, insert } = target;
    const token = graph.tokens.get(path);
    const actual = resolverValueAt(filesByPath.get(origin.file)?.tree, origin.parts);
    const node: JsonObject = { ...(insert ? token?.authoredNode : isJsonObject(actual) ? actual : undefined) };
    const sourceType = typeof node['$type'] === 'string' ? node['$type'] : undefined;
    const editingValue = !change.create && change.column === 'value' && change.mode !== 'inspector' && change.mode !== 'link';
    const type = editModel ? (editingValue ? token?.type : change.type || graph.groups.get(parentPath(path))?.type || token?.referenceType) : variantType;
    try {
      const valueChanged = insert || change.value !== displayInput(sourceType ?? token?.type, change.original);
      const typeChanged = !!editModel && !editingValue &&
        (change.create || change.mode === 'inspector' || change.mode === 'link' || change.column === 'type') &&
        (change.type || undefined) !== sourceType;
      const description = change.description.trim() || undefined;
      const descriptionChanged = !!editModel && description !== (node['$description'] || undefined);
      if (!valueChanged && !typeChanged && !descriptionChanged) {
        if (draft) {
          cancel(after === undefined);
          if (after) { setSelected(after.path); setFocusRequest(after); }
        }
        return true;
      }
      if (insert || typeChanged) node['$type'] = insert ? type : change.type || undefined;
      if (descriptionChanged) node['$description'] = description;
      if (valueChanged || typeChanged) {
        const value = valueChanged ? readInput(change.value, type, change.original) : change.original;
        validateInputValue(type, value);
        if (valueChanged) {
          node['$value'] = authoredResolverValue(definitionContext ?? current, model.file, origin.file,
            requireValue(value, 'token value'), token?.authoredNode['$value'], node['$value']);
          delete node['$ref'];
        }
      }
      const content = insert ? path.split('.').reduceRight<JsonObject>((child, key) => ({ [key]: child }), node) : node;
      setError('');
      void checkVariantEdit({ file: origin.file, parts: origin.parts, value: content, insert }, path, () => {
        setVariantEdit(undefined); setVariantDirty(false);
        if (draft && !change.create && after !== null) {
          refocusAfterReview.current = true;
          if (after) setSelected(after.path);
          setFocusRequest(after ?? { path, column: change.column });
        }
      });
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
      if (change.create && current && model) {
        const path = [displayedGroup, name].filter(Boolean).join('.');
        if (graph.tokens.has(path) || graph.groups.has(path)) throw new Error('That name already exists in this group.');
        const origin = requireValue(groupOrigins.get(change.file), 'source for this group');
        const type = change.type || folder.type;
        const raw = change.groupOnly ? undefined : readInput(change.value, type, undefined);
        const node: JsonObject = raw === undefined ? {} : { $type: type, $value: authoredResolverValue(current, model.file, origin.file, raw),
          ...(change.description.trim() ? { $description: change.description.trim() } : {}) };
        if ('$value' in node) validateInputValue(type, node['$value']);
        void checkVariantEdit({ file: origin.file, parts: [...origin.parts, name], value: node }, path);
        return true;
      }
      if (!change.create && editModel && current) {
        const origin = requireValue(winningOrigins(current, change.path).at(-1), 'token definition');
        return commitVariant(change, { path: change.path, origin }, after);
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
      const finish = (updated: Review) => {
        if (change.create || token?.inheritedFrom || updated.contextImpact?.length || updated.validationErrors?.length) setReview(updated);
        else finishChange(updated.next, path, change, after);
      };
      if (graph.rows.length >= 1000 && (change.create || change.mode !== 'link')) {
        setBusy(true);
        void runWorkspaceReview({ kind: 'edit', workspace: data, file, change: tokenChange }).then(finish)
          .catch((failure: unknown) => setError(errorMessage(failure))).finally(() => setBusy(false));
      } else finish(reviewEdit(data, file, tokenChange));
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    }
  }

  async function restoreInherited(path: string) {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      setReview(await runWorkspaceReview({ kind: 'restore-inherited', workspace: data, path }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }

  function canStructure(path: string) {
    return !current || !!graph.tokens.get(path) && !graph.tokens.get(path)?.inheritedFrom && !!winningOrigins(current, path).length;
  }

  function prepareStructure(operation: 'move' | 'rename' | 'duplicate' | 'delete', changes: readonly { path: string; to?: string }[], target?: MoveDestination) {
    if (!current || !variantScope) throw new Error('Open an authored token definition first.');
    return runWorkspaceReview({ kind: 'resolver-structure', workspace: data, operation, changes, ...(target ? { target } : {}),
      scope: { review: variantScope, resolution: current } });
  }

  async function deleteDefinitions(paths: readonly string[]) {
    setBusy(true);
    try {
      const next = await prepareStructure('delete', paths.map(path => ({ path })));
      afterReviewApplied.current = () => clearSelection(true);
      setReview(next);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  function deletePaths(paths: string[]) {
    setError('');
    if (current) { void deleteDefinitions(paths); return; }
    if (graph.rows.length >= 1000) {
      setBusy(true);
      void runWorkspaceReview({ kind: 'delete', workspace: data, paths }).then(setReview)
        .catch((failure: unknown) => setError(errorMessage(failure))).finally(() => setBusy(false));
      return;
    }
    try { setReview(reviewDelete(data, paths)); }
    catch (failure) { setError(errorMessage(failure)); }
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
  const bulkable = useMemo(() => !current || [...checked].every(path => {
    const token = graph.tokens.get(path);
    return token && !token.inheritedFrom && winningOrigins(current, path).length > 0;
  }), [checked, current, graph]);
  const editActions = ([
    ['rename', 'Rename', TextCursorInput],
    ['value', 'Value', SlidersHorizontal],
    ['type', 'Type', Shapes],
    ['description', 'Description', FileText],
  ] as const).map(([action, caption, Icon]) => ({
    action, caption, icon: <Icon aria-hidden="true" />, label: selectionEditLabels[action],
    run: () => setBulkEdit({ paths: [...checked], action }),
  }));
  const structureActions = [
    { caption: 'Move', label: 'Move selected tokens', icon: <ArrowRightLeft aria-hidden="true" />,
      run: () => setRelocate({ paths: [...checked], operation: 'move' }) },
    { caption: 'Duplicate', label: 'Duplicate selected tokens', icon: <Copy aria-hidden="true" />,
      run: () => setRelocate({ paths: [...checked], operation: 'duplicate' }) },
    { caption: 'Delete', label: 'Delete selected tokens', icon: <Trash2 aria-hidden="true" />, destructive: true,
      run: () => deletePaths([...checked]) },
  ];
  const editingBlocked = busy || !!draft || variantDirty;
  const menuDisabled = editingBlocked || resolvingVariant;
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
  const rovingButtons = useWorkspaceRovingButtons(view, menuDisabled, !!checked.size && bulkable, canCreate);
  const canAddGroupValue = canCreate && !!displayedGroup && !graph.tokens.has(displayedGroup + '.$root');
  function setUpVariants() {
    setNewResolver(true);
  }
  const canCompare = !!model?.modifiers.size && !!resolution;
  function manageVariants() {
    setView('variants');
    requestAnimationFrame(() => variantsHeading.current?.focus());
  }
  function toggleComparison() {
    manageVariants();
    setComparing(true);
  }
  const showMd3Benchmark = import.meta.env.DEV && import.meta.env['VITE_MD3_SAMPLE'] === '1';
  const menus: Menu[] = [
    { label: 'File', sections: [
      [
        { label: 'Open token files…', icon: <FileUp aria-hidden="true" />, run: () => fileInput.current?.click(), disabled: busy },
        { label: 'Open token folder…', icon: <FolderOpen aria-hidden="true" />, run: () => { void loadFolder(); }, disabled: busy },
        { label: 'Open built-in example', icon: <FolderOpen aria-hidden="true" />, run: () => { if (canReplace()) activate(openExample()); }, disabled: busy },
        { label: 'Open Material 3 sample', icon: <FolderOpen aria-hidden="true" />, run: () => { void loadMd3(); }, disabled: busy },
        ...(showMd3Benchmark ? [{ label: 'Open Material 3 benchmark', icon: <FolderOpen aria-hidden="true" />,
          run: () => { void loadMd3(true); }, disabled: busy }] : []),
        { label: 'Import proposal…', icon: <FileUp aria-hidden="true" />,
          run: () => { setError(''); setImportChanges(true); }, disabled: !!activeResolver || menuDisabled },
        { label: 'Import Penpot tokens…', icon: <FileUp aria-hidden="true" />,
          run: () => { setError(''); setPenpotFile(null); setPenpotOpen(true); }, disabled: !!activeResolver || menuDisabled },
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
      model ? [
        { label: 'Download editable sources (.zip)', icon: <ArrowDownToLine aria-hidden="true" />, disabled: menuDisabled,
          run: () => { void downloadEditableSources(data, model).catch((failure: unknown) => setError(errorMessage(failure))); } },
        { label: resolution ? 'Download resolved tokens · ' + variantLabel(resolution) : 'Download resolved tokens', icon: <ArrowDownToLine aria-hidden="true" />,
          disabled: menuDisabled || !resolution || !!resolution.errors.length || model.issues.some(issue => issue.severity === 'error'),
          run: () => { if (resolution) try { downloadVariant(resolution); } catch (failure) { setError(errorMessage(failure)); } } },
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
        ...[...editActions, ...structureActions].map(command => ({
          label: command.label + '…', icon: command.icon, run: command.run,
          disabled: !bulkable || !checked.size || menuDisabled || view !== 'tokens',
          destructive: 'destructive' in command && command.destructive,
        }))],
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
      activeResolver ? { label: 'Manage variants', icon: <Settings2 aria-hidden="true" />, disabled: menuDisabled, run: manageVariants } :
        { label: 'Set up variants…', icon: <Settings2 aria-hidden="true" />, disabled: menuDisabled, run: setUpVariants },
      { label: 'Compare variants', icon: <ArrowRightLeft aria-hidden="true" />,
        disabled: !canCompare || menuDisabled, run: toggleComparison },
    ]] },
    { label: 'Help', sections: [[
      { label: 'Keyboard shortcuts', icon: <Keyboard aria-hidden="true" />, run: () => setShortcutsOpen(true) },
      { label: 'Show key tips', icon: <Keyboard aria-hidden="true" />, disabled: menuDisabled, run: () => keyTips.current?.show() },
    ]] },
  ];

  function openInspector(path: string) {
    select(path);
    showInspector();
  }

  function showInspector() {
    const active = document.activeElement;
    if (!inspectorOpen) {
      inspectorOpener.current = active instanceof HTMLElement &&
        (active === detailsButton.current || active.matches('[data-edit-column]') && grid.current?.contains(active)) ? active : null;
    }
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
    const previous = inspectorOpener.current;
    inspectorOpener.current = null;
    const opener = previous?.isConnected ? previous :
      grid.current?.querySelector<HTMLElement>('[data-token-row] [tabindex="0"]') ?? detailsButton.current;
    opener?.focus({ preventScroll: true });
  }

  function toggleInspector() {
    if (inspectorOpen) closeInspector();
    else showInspector();
  }

  const latestGridActions = useRef({ select, edit, cancel, commit, canStructure, restoreInherited, openInspector, copyPaths, deletePaths, jump, selectGroup });
  useLayoutEffect(() => {
    latestGridActions.current = { select, edit, cancel, commit, canStructure, restoreInherited, openInspector, copyPaths, deletePaths, jump, selectGroup };
  });
  const gridActions = useMemo(() => ({
    select: (path: string, column?: GridColumn) => latestGridActions.current.select(path, column),
    edit: (path: string, column: EditableColumn, link?: boolean) => latestGridActions.current.edit(path, column, link),
    cancel: (restore?: boolean) => latestGridActions.current.cancel(restore),
    commit: (change: Draft, after?: CellPosition | null) => latestGridActions.current.commit(change, after),
    canStructure: (path: string) => latestGridActions.current.canStructure(path),
    restoreInherited: (path: string) => { void latestGridActions.current.restoreInherited(path); },
    inspect: (path: string) => latestGridActions.current.openInspector(path),
    copy: (path: string) => latestGridActions.current.copyPaths([path]),
    remove: (path: string) => latestGridActions.current.deletePaths([path]),
    rename: (path: string) => setRelocate({ paths: [path], operation: 'rename' }),
    move: (path: string) => setRelocate({ paths: [path], operation: 'move' }),
    duplicate: (path: string) => setRelocate({ paths: [path], operation: 'duplicate' }),
    metadata: (path: string) => setMetadataLocation({ kind: 'token', path }),
  }), []);
  const jumpToToken = useCallback((path: string) => latestGridActions.current.jump(path), []);
  const goToGroup = useCallback((path: string) => latestGridActions.current.selectGroup(path), []);

  function focusTokenArea(id: 'token-grid' | 'token-controls') {
    setView('tokens');
    if (!desktop) { setMobileTree(false); setInspectorOpen(false); }
    requestAnimationFrame(() => (document.getElementById(id) ?? workspacePane.current)?.focus());
  }

  function jumpByKeyTip(key: string) {
    if (key === 'S') {
      tokenSearch.current?.focus();
    } else if (key === 'C' && view === 'tokens') {
      focusTokenArea('token-controls');
    } else if (key === 'G') {
      if (!treeVisible) toggleTree();
      requestAnimationFrame(() => {
        const groups = document.getElementById('groups');
        (groups?.querySelector<HTMLElement>('.folder-tree [aria-current="page"]') ?? groups)?.focus();
      });
    } else if (key === 'D') {
      showInspector();
    } else {
      return false;
    }
    return true;
  }

  return <div data-component-assets className="workspace" {...rovingButtons}>
    <KeyTips ref={keyTips} blocked={menuDisabled} jump={jumpByKeyTip} />
    <div className="workspace-top">
      <nav aria-label="Skip links" className="workspace-skip-links sr-only focus-within:not-sr-only">
        <ButtonLink size="small" href="#token-grid" onClick={event => {
          event.preventDefault();
          focusTokenArea('token-grid');
        }}>Skip to token grid</ButtonLink>
        {view === 'tokens' ? <>
          {treeVisible && <ButtonLink size="small" href="#groups">Skip to groups</ButtonLink>}
          {inspectorOpen && <ButtonLink size="small" href="#token-inspector">Skip to token details</ButtonLink>}
        </> : <ButtonLink size="small" href={view === 'variants' ? '#workspace-variants' : '#workspace-management'}>
          Skip to {view === 'variants' ? 'variants' : 'workspace'}
        </ButtonLink>}
      </nav>
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
        <input ref={penpotInput} type="file" accept=".json,application/json" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void loadPenpot(file);
          event.target.value = '';
        }} />
        <div className="workspace-review">
          {submittedUrl && !dirty ? <ButtonLink href={submittedUrl} target="_blank" rel="noreferrer"
            aria-label="View pull request">View PR</ButtonLink> :
            <Button size="small" disabled={menuDisabled || !dirty || !hasChanges} onClick={() => { void reviewForSave(); }}
              data-key-tip="R" aria-label={reviewLabel}>Review changes</Button>}
        </div>
      </header>
      {linkedProposal && <div className="workspace-proposal">
        <p className="me-auto">Linked changes apply to matching tokens in this workspace.</p>
        <Button variant="text" disabled={busy} onClick={() => setLinkedProposal('')}>Dismiss</Button>
        <Button size="small" disabled={busy || !!draft} onClick={() => { void reviewLinkedProposal(); }}>Review linked changes</Button>
      </div>}
      {error && !draft && !review && !finalReview && !importChanges && <Alert variant="destructive" className="shrink-0 rounded-none border-x-0">
        <AlertDescription className="max-h-32 overflow-auto whitespace-pre-wrap">{error}</AlertDescription>
      </Alert>}
    </div>
    <NavigationRail label="Foundry" className="workspace-rail" width="default"
      footer={<IconButton label={themeLabel} title={themeLabel} onClick={toggleTheme}>
        {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </IconButton>}>
      <NavigationRailItem data-key-tip="T" label="Tokens" icon={<Layers />} aria-current={view === 'tokens' ? 'page' : undefined}
        disabled={menuDisabled} onClick={() => focusTokenArea('token-grid')} />
      <NavigationRailItem data-key-tip="V" label="Variants" icon={<SlidersHorizontal />} aria-current={view === 'variants' ? 'page' : undefined}
        disabled={menuDisabled} onClick={manageVariants} />
      <NavigationRailItem data-key-tip="W" label="Workspace" icon={<Settings2 />} aria-current={view === 'workspace' ? 'page' : undefined}
        disabled={menuDisabled} onClick={() => {
          setView('workspace');
          requestAnimationFrame(() => document.getElementById('workspace-management')?.focus());
        }} />
    </NavigationRail>
    {view === 'workspace' && <main id="workspace-management" tabIndex={-1} className="workspace-management" aria-label="Workspace management">
      <h2>Workspace</h2>
      <section aria-label="Changes">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h3>Changes</h3><p>{dirty && hasChanges ? 'Unsaved changes' : 'No pending changes'}</p></div>
          <Button size="small" variant="tonal" disabled={menuDisabled || !dirty || !hasChanges}
            onClick={() => { void reviewForSave(); }}>Review pending changes</Button>
        </div>
      </section>
      <section aria-label="Integrations">
        <h3>Integrations</h3>
        {Connector ? <Connector disabled={menuDisabled} canReplace={canReplace} connect={(connection) =>
          activate(connection.workspace, { kind: 'pull-request', connection })} /> :
          <CommandMenu label="Manage integrations" sections={[[{
            label: 'Open GitHub repository…', icon: <GitPullRequest aria-hidden="true" />, disabled: true,
            title: 'GitHub integration is available in the hosted editor.', run: () => undefined,
          }]]} />}
      </section>
      <section aria-label="Source" ref={sourceManagement}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3>Source files</h3>
            <p>{data.name} · {saveTarget?.kind === 'pull-request' ? 'GitHub repository' :
              saveTarget?.kind === 'folder' ? 'Local folder' : 'Local workspace'}</p>
          </div>
          <Button size="small" variant="tonal" data-new-source data-key-tip="N" disabled={menuDisabled} onClick={() => setSourceFileAction({ kind: 'create' })}>
            <Plus aria-hidden="true" /> New source file
          </Button>
        </div>
        <ul className="mt-2 grid max-w-2xl gap-0.5">{data.files.map(file => <li key={file.path} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
          <Button variant="text" size="xsmall" className="min-w-0 justify-self-start" data-source-file={file.path} disabled={menuDisabled}
            onClick={() => setSourceLocation({ file: file.path, path: [] })}><code className="truncate" title={file.path}>{file.path}</code></Button>
          <CommandMenu label={'Actions for ' + file.path} icon={<MoreHorizontal aria-hidden="true" />} disabled={menuDisabled}
            sections={[[{
              label: 'Rename or move…', icon: <Pencil aria-hidden="true" />, run: () => setSourceFileAction({ kind: 'relocate', file: file.path }),
            }], [{
              label: 'Remove file…', icon: <Trash2 aria-hidden="true" />, destructive: true, disabled: data.files.length < 2,
              run: () => setSourceFileAction({ kind: 'remove', file: file.path }),
            }]]} />
        </li>)}</ul>
      </section>

    </main>}
    {view === 'variants' && <main id="workspace-variants" tabIndex={-1} className="workspace-management" aria-labelledby="workspace-variants-title">
      <div className="workspace-variant-management">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="workspace-variants-title" tabIndex={-1} ref={variantsHeading}>Variants</h2>
          <Button size="xsmall" variant="text" disabled={menuDisabled} onClick={() => {
            setView('tokens');
            requestAnimationFrame(() => workspacePane.current?.querySelector<HTMLElement>('[data-workspace-group-title]')?.focus());
          }}>Back to tokens</Button>
        </header>
        {!activeResolver && <section className="grid justify-items-start gap-2">
          <p className="copy-body tone-supporting">Set up variants to resolve different values for the same tokens, such as light and dark.</p>
          <Button size="small" data-key-tip="C" disabled={menuDisabled} onClick={setUpVariants}>Set up variants</Button>
        </section>}
        {activeResolver && resolvers.length > 1 && <label className="variant-field">Variant configuration
          <Select aria-label="Variant configuration" disabled={editingBlocked} value={activeResolver.path} onChange={event => { setResolverFile(event.target.value); setPrimary({}); setSecondary({}); setEditingSet(undefined); setComparing(false); setVariantEdit(undefined); clearSelection(); }}>
            {resolvers.map(resolver => <SelectOption key={resolver.path} value={resolver.path}>{resolver.path}</SelectOption>)}
          </Select>
        </label>}
        {!resolution && activeVariant.pending && <output className="copy-body tone-supporting">Loading variant configuration…</output>}
        {!resolution && activeVariant.error && <Alert variant="destructive"><AlertDescription>{activeVariant.error}</AlertDescription></Alert>}
        {model && resolution && resolutionData && !!model.modifiers.size && <section aria-label="Compare variants" className="resolver-section">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3>Variant comparison</h3>
            <Button size="xsmall" variant="text" data-key-tip="C" disabled={menuDisabled} onClick={() => setComparing(!comparing)}>
              {comparing ? 'Close comparison' : 'Compare variants'}
            </Button>
          </div>
          {comparing && <>
            <div className="flex flex-wrap gap-4">
              <ContextInputs model={model} disabled={editingBlocked} label="Preview" inputs={primary} update={setPrimary} />
              <ContextInputs model={model} disabled={editingBlocked} label="Compare with" inputs={secondary} update={setSecondary} />
            </div>
            {alternativeData ? <VariantComparison current={resolutionData} alternative={alternativeData} inspect={path => {
              setEditingSet('');
              setGroup(parentPath(path));
              clearTokenSearch();
              setOnlyUnresolved(false);
              const start = resolution.graph.groups.get(parentPath(path))?.start ?? 0;
              setPage(Math.max(0, Math.floor((tokenRowIndex(resolution.graph, path) - start) / pageSize)));
              resetScroll();
              setView('tokens');
              openInspector(path);
            }} /> : <output>Preparing comparison…</output>}
          </>}
        </section>}
        {activeResolver && modelData && resolutionData && variantScope && <ResolverPane key={activeResolver.path} workspace={workspaceData} file={activeResolver.path} disabled={menuDisabled} current={resolutionData} model={modelData} alternative={alternativeData}
          scope={variantScope}
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
          }} />}
      </div>
    </main>}
    <WorkspacePanes hidden={view !== 'tokens'} groupsOpen={treeVisible} inspectorOpen={inspectorOpen} grid={grid} groups={
      <aside id="groups" tabIndex={-1} aria-label="Groups" hidden={!treeVisible} className="workspace-sidebar" onCopy={event => copySelection(event, true)} onPaste={pasteSelection}>
        <div className="workspace-sidebar-heading">
          <h2 className="me-auto min-w-0 truncate copy-body copy-emphasis" title="Token groups"><span data-key-tip="G">Groups</span></h2>
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
          <FolderTree key={data.name} ref={groupsTree} rootLabel={editingLabel ? 'All in ' + editingLabel : 'All tokens'} groups={graph.groups} current={displayedGroup} select={goToGroup} independentExpansion initiallyExpanded={initiallyExpanded} />
        </fieldset>
      </aside>
    } inspector={
      <SideSheet id="token-inspector" tabIndex={-1} hidden={!inspectorOpen} variant="detached" className="workspace-inspector"
        title="Token details" onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) closeInspector(); }}
        footer={inspectorOpen && inspectorInitial && <div ref={setInspectorFooter} />}
        headerAction={<IconButton ref={inspectorCloseButton} size="xsmall" label="Close inspector" disabled={busy} onClick={closeInspector}><X aria-hidden="true" /></IconButton>}>
        {inspectorOpen && resolution && alternative && selected && <section aria-label="Compared values" className="mb-4 grid min-w-0 gap-2">
          <h3 className="copy-body copy-emphasis">Compared values</h3>
          {[{ label: variantLabel(resolution), result: resolution, side: 'Active' },
            { label: variantLabel(alternative), result: alternative, side: 'Compared' }].map(({ label, result, side }) => {
            const origin = winningOrigins(result, selected).at(-1);
            return <div key={side} className="grid min-w-0 gap-1 rounded-md border p-2 copy-body">
              <span>{side} · {label}</span>
              {result.graph.tokens.has(selected) ? <TokenValue value={result.graph.resolved.get(selected)} swatch wrap /> : <span>Token absent</span>}
              {origin && <span className="wrap-anywhere copy-small tone-supporting">{labelOrigin(origin)}</span>}
            </div>;
          })}
          {alternative.graph.tokens.has(selected) && <Button size="xsmall" variant="text" disabled={menuDisabled} onClick={() => {
            setPrimary(secondary); setSecondary(primary); setVariantEdit(undefined);
          }}>{editModel ? 'Make compared variant active' : 'Edit compared variant'}</Button>}
        </section>}
        {inspectorOpen && (inspectorInitial ? <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4" key={selected}>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <code title={selected} className="wrap-anywhere">{tokenDisplayName(selected)}</code>
            <IconButton size="xsmall" label="Copy token path" title="Copy token path" onClick={() => copyTokenPath(selected)}><Copy aria-hidden="true" /></IconButton>
          </div>
          {current && (definitionEdit?.origin ?? winner) && <p className="copy-body copy-emphasis">
            {definitionEdit?.insert ? 'Adding override for ' : 'Editing '}{variantEdit ? originName(variantEdit.origin) : editingLabel ?? originName(requireValue(winner, 'token definition'))}
          </p>}
          {inspected?.inheritedFrom && <div className="grid gap-1 copy-small tone-supporting">
            <p className="wrap-anywhere">Inherited from {inspected.inheritedFrom.path} · {inspected.inheritedFrom.file}</p>
            <Button variant="text" size="xsmall" className="justify-self-start" disabled={menuDisabled}
              onClick={() => { if (inspected.inheritedFrom) jump(inspected.inheritedFrom.path); }}>Go to source token</Button>
          </div>}
          {!inspected?.inheritedFrom && inspected?.overrides && <p className="wrap-anywhere copy-small tone-supporting">
            Overrides {inspected.overrides.path} · {inspected.overrides.file}
          </p>}
          {inspected?.deprecated && <p className="wrap-anywhere copy-small">Deprecated{typeof inspected.deprecated === 'string' ? ' · ' + inspected.deprecated : ''}</p>}
          {current ? <>
            <div className="grid gap-1 copy-body">
              {!editModel && <>
                <p className="copy-emphasis">{winner?.modifier ? winner.context + ' override' : 'Shared value'}</p>
                <TokenValue value={graph.resolved.get(selected)} swatch={inspected?.type === 'color'} wrap />
              </>}
              {activeValueGraph?.tokens.has(selected) && <div>
                <p className="copy-emphasis">{resolvedHeading}</p>
                <TokenValue value={activeValueGraph.resolved.get(selected)} swatch wrap />
              </div>}
            </div>
            {editModel && winner && !definitionEdit && <p className="wrap-anywhere copy-small tone-supporting">Defined in {originName(winner)}</p>}
            <div className="flex flex-wrap gap-1">
              {sharedOrigin && (!editModel || !!inspected?.inheritedFrom) && <Button size="xsmall" variant="tonal" disabled={menuDisabled}
                onClick={() => { setError(''); setVariantEdit({ path: selected, origin: sharedOrigin }); }}>{editModel ? 'Edit definition' : 'Edit shared value'}</Button>}
              {!editModel && winner?.modifier && <Button size="xsmall" variant="tonal" disabled={menuDisabled}
                onClick={() => { setError(''); setVariantEdit({ path: selected, origin: winner }); }}>Edit {winner.context} override</Button>}
              {overrideTargets.map(origin => <Button key={origin.modifier} size="xsmall" variant="text" disabled={menuDisabled}
                onClick={() => { setError(''); setVariantEdit({ path: selected, origin, insert: true }); }}>Override for {origin.context}</Button>)}
            </div>
            {definitionEdit && variantValue !== undefined && <>
              <Disclosure label="Definition details" className="copy-small" aria-label="Editing definition">
                <span className="wrap-anywhere">{labelOrigin(definitionEdit.origin)}</span>
                <code className="wrap-anywhere">{serializeTokenPointer(definitionEdit.origin.file, definitionEdit.origin.file, definitionEdit.origin.parts)}</code>
              </Disclosure>
              <TokenEditForm footer={inspectorFooter} key={JSON.stringify(definitionEdit)} valueOnly={!editModel} definition={!!editModel}
                initialDraft={{ ...inspectorInitial, type: editModel ? declaredType : variantType,
                  original: variantValue, value: displayInput(variantType, variantValue),
                  originalDescription: definitionDescription, description: definitionDescription }}
              graph={referenceGraph ?? graph} inspectorActive={variantDirty} busy={busy || resolvingVariant || definitionResolution.pending} onEdit={() => setVariantDirty(true)}
              cancel={() => { setVariantEdit(undefined); setVariantDirty(false); setError(''); }} error={error} commit={commitVariant} /></>}
            {!!origins.length && <Disclosure label="Where this value comes from" className="copy-small">
              <ul className="mt-1 grid gap-1">{origins.toReversed().map((origin, index) => {
                const label = (index === 0 ? 'Current value' : 'Earlier value') + ' · ' + labelOrigin(origin);
                return <li key={JSON.stringify([origin, index])} className="flex min-w-0 items-center justify-between gap-1">
                  <span className="min-w-0 wrap-anywhere">{label}</span>
                  <IconButton size="xsmall" label={'Open source for ' + label} title="Open source" disabled={busy} className="shrink-0"
                    onClick={() => setSourceLocation({ file: origin.file, path: origin.parts, ...(variantScope ? { resolver: variantScope } : {}) })}>
                    <ArrowUpRight aria-hidden="true" />
                  </IconButton>
                </li>;
              })}</ul>
            </Disclosure>}
          </> : <>
            {inspected && <p className="wrap-anywhere copy-small">Definition in {inspected.file}</p>}
            <TokenEditForm footer={inspectorFooter} initialDraft={inspectorInitial} graph={graph} busy={busy || resolvingVariant || !!draft && !inspectorDraft}
            inspectorActive={!!inspectorDraft} onEdit={() => setDraft(inspectorInitial)} cancel={() => cancel(false)} error={inspectorDraft ? error : ''}
            commit={commit} />
          </>}
          {referenceGraph && <ReferenceDetails path={selected} data={referenceData} jump={jumpToToken} disabled={menuDisabled} />}
        </div> : !selected || !alternative ? <p className="workspace-inspector-empty">Select a token to see its details.</p> : null)}
      </SideSheet>
    }>
      <main ref={workspacePane} id="token-library" tabIndex={-1} aria-label="Token library" className="workspace-main @container/grid" onCopy={copySelection} onPaste={pasteSelection}>
        <section aria-label="Token commands" className="workspace-tools">
          {resolvingVariant && <output className="block px-3 py-1 copy-body tone-supporting">Resolving variant…</output>}
          {(activeVariant.error || comparisonVariant.error || setResolution.error) && <Alert variant="destructive"><AlertDescription>
            {activeVariant.error || comparisonVariant.error || setResolution.error}
          </AlertDescription></Alert>}

          <section id="token-controls" tabIndex={-1} aria-label="Token controls" className="workspace-heading">
            <IconButton size="xsmall" label={treeLabel} title={treeLabel} data-key-tip={treeVisible ? undefined : "G"} data-key-tip-label="Show Groups" aria-controls="groups" aria-expanded={treeVisible}
              disabled={menuDisabled} onClick={toggleTree}>{treeIcon}</IconButton>
            <div className="workspace-path flex min-w-0 items-center gap-1">
              <h2 data-workspace-group-title data-key-tip="C" data-key-tip-label="Token controls" tabIndex={-1} title={displayedGroup || 'All tokens'}>
                {parentPath(displayedGroup) && <span className="workspace-ancestors">{parentPath(displayedGroup).split('.').join(' / ')} / </span>}
                <span className="workspace-group-name">{leafName(displayedGroup) || editingLabel || 'All tokens'}</span>
              </h2>
              {!activeResolver && <Button className="hidden shrink-0 sm:inline-flex" size="xsmall" variant="text"
                disabled={menuDisabled} onClick={setUpVariants}>Set up variants</Button>}
            </div>
            {model && <div className="workspace-variant-controls">
              <ChipSelect label="Editing set" selectedLabel={'Edit set · ' + (editingLabel || 'All tokens')}
                value={setName ?? editChoice?.value ?? ''} disabled={editingBlocked} onChange={event => {
                  setEditingSet(event.target.value); setGroup(''); clearSelection(); resetScroll();
                }}>
                <SelectOption value="">All tokens</SelectOption>
                {[...model.sets.keys()].map(name => <SelectOption key={name} value={name}>{name}</SelectOption>)}
                {editChoices.map(({ modifier, options }) => <optgroup key={modifier.name} label={modifier.name}>
                  {options.map(({ value, name }) => <SelectOption key={value} value={value}>{name}</SelectOption>)}
                </optgroup>)}
              </ChipSelect>
              {model.modifiers.size ? <ContextInputs model={model} disabled={editModel ? busy : editingBlocked} label="Preview"
                inputs={primary} update={value => {
                  setPrimary(value);
                  if (!editModel) clearSelection(true);
                }} /> : <Button size="xsmall" variant="text" disabled={menuDisabled} onClick={manageVariants}>Add variant options</Button>}
              {!!(resolution?.errors.length || model.issues.length || alternative?.errors.length) &&
                <Button size="xsmall" variant="text" disabled={menuDisabled} onClick={manageVariants}>Variant issues</Button>}
            </div>}
            <SearchBar ref={tokenSearch} data-key-tip="S" label="Search tokens in group" placeholder="Search tokens" leading={<Search aria-hidden="true" />}
              className="workspace-search" title={group ? 'Search in ' + group : 'Search all tokens'}
              action={<IconButton className={query ? "md-search-action" : "md-search-action invisible"} size="xsmall" label="Clear token search"
                disabled={menuDisabled || !query}
                onClick={() => {
                  if (tokenSearch.current) tokenSearch.current.value = '';
                  searchTokens('');
                  tokenSearch.current?.focus();
                }}><X aria-hidden="true" /></IconButton>}
              disabled={menuDisabled} onChange={event => searchTokens(event.currentTarget.value)} />
          </section>
          <div className="workspace-command-row">
            <div className="workspace-filters flex min-w-0 gap-1">
              {diagnosticsCount > 0 && <Button size="xsmall" variant="text" className="numeric-text"
                disabled={menuDisabled} onClick={() => setDiagnosticsOpen(true)}>
                <AlertCircle aria-hidden="true" /> Issues ({diagnosticsCount})
              </Button>}
              {unresolvedCount > 0 && <Button size="xsmall" className="numeric-text" variant={showOnlyUnresolved ? 'tonal' : 'outlined'}
                pressed={showOnlyUnresolved} disabled={menuDisabled} onClick={() => {
                  setOnlyUnresolved(!showOnlyUnresolved);
                  setPage(0);
                  select('');
                  resetScroll();
                }}><AlertCircle aria-hidden="true" /> Unresolved ({unresolvedCount})</Button>}
              {!!current && checked.size > 0 && !bulkable && <span className="copy-small tone-supporting">Select editable definitions for bulk changes.</span>}
            </div>
            <fieldset className="workspace-actions" aria-label="Edit selected tokens">
              <div className="workspace-command-set" role="toolbar" aria-label="Edit selected token fields"
                data-roving-buttons="bulk" data-key-tip="B" data-key-tip-label="Bulk edit">
                {editActions.map(({ action, caption, icon, label, run }) => <Button key={action} size="xsmall"
                  data-toolbar-tip={action === 'type' ? 'T' : caption.charAt(0)}
                  variant={checked.size && suggestedEdit === action ? 'tonal' : 'text'} aria-label={label} title={checked.size ? label + ' · ' + selectedTokenLabel : label}
                  disabled={menuDisabled || !checked.size || !bulkable}
                  onClick={event => { bulkTrigger.current = event.currentTarget; run(); }}>
                  {icon} {caption}
                </Button>)}
              </div>
              <div className="workspace-command-set" role="toolbar" aria-label="Move, duplicate or delete selected tokens"
                data-roving-buttons="bulk" data-key-tip="M" data-key-tip-label="Move, duplicate or delete">
                {structureActions.map(({ caption, icon, label, run }) => <Button key={caption} size="xsmall" variant="text"
                  data-toolbar-tip={caption === 'Duplicate' ? 'U' : caption === 'Delete' ? 'X' : 'M'}
                  disabled={menuDisabled || !checked.size || !bulkable} title={label} onClick={run}>
                  {icon} {caption}
                </Button>)}
              </div>
            </fieldset>
            <div className="workspace-token-actions" role="toolbar" aria-label="Token actions" data-roving-buttons>
              <Button size="xsmall" variant="text" ref={detailsButton} data-key-tip="D" data-key-tip-label="Edit token" aria-label="Edit token" title="Edit token"
                aria-controls="token-inspector" aria-expanded={inspectorOpen} disabled={menuDisabled}
                onClick={showInspector}><Pencil aria-hidden="true" /><span className="workspace-edit-label">Edit token</span></Button>
              <Button size="xsmall" variant="filled" data-key-tip="N" disabled={menuDisabled || !(current ? sourceChoices.size : folder.files.size)} onClick={() => create(false)}>
                <Plus aria-hidden="true" /> New token
              </Button>
            </div>
          </div>
        </section>
        <div ref={grid} aria-busy={busy || resolvingVariant} className="min-h-0 flex-1 [&>[data-slot=table-container]]:h-full [&>[data-slot=table-container]]:overflow-auto">
          {editModel && !current ? <output className="block p-4 copy-body">{setResolution.error ?? 'Loading token definitions…'}</output> :
          <TokenGrid narrow={!desktop} variant={!!current} data={gridData}
            {...{ previewLabel, resolvedHeading }} group={displayedGroup}
            {...{ gridSelection, draft, setDraft, error }} {...gridActions} busy={busy || resolvingVariant} />}
        </div>
        <footer className="workspace-footer">
          <span>{rowCount.toLocaleString('en')} {rowCount === 1 ? 'token' : 'tokens'}</span>
          {draft && !draft.create && draft.mode === 'inline' && error ?
            <output id="inline-edit-error" role="alert" className="tone-error">{error}</output> :
            <output>{saveStatus}</output>}
          <div className="workspace-footer-end">
            {pages > 1 && !alternative && <div className="workspace-pagination">
              <IconButton size="xsmall" label="Previous page" disabled={shownPage === 0 || !!draft}
                onClick={() => { setPage(shownPage - 1); select(''); resetScroll(); }}><ChevronLeft aria-hidden="true" /></IconButton>
              <span>Page {shownPage + 1} of {pages}</span>
              <IconButton size="xsmall" label="Next page" disabled={shownPage + 1 === pages || !!draft}
                onClick={() => { setPage(shownPage + 1); select(''); resetScroll(); }}><ChevronRight aria-hidden="true" /></IconButton>
            </div>}
            <div className="workspace-selection-count">
              <span aria-live="polite" className="numeric-text">
                {checked.size > 0 && <>{selectionCount} selected{hiddenChecked > 0 && ` · ${hiddenChecked} not shown`}</>}
              </span>
              {checked.size > 0 && <IconButton size="xsmall" label="Clear selection" title="Clear selection" disabled={menuDisabled}
                onClick={clearCheckedSelection}><X aria-hidden="true" /></IconButton>}
            </div>
          </div>
        </footer>
      </main>
    </WorkspacePanes>
    {newResolver && <VariantSetupDialog workspace={data} files={librarySources.map(file => file.path)}
      root={saveTarget?.kind === 'pull-request' ? saveTarget.connection.root : undefined}
      reviewing={!!review} close={() => setNewResolver(false)} create={(file, text) => {
        const next = reviewCreateSource(data, file, text);
        afterReviewApplied.current = () => {
          setNewResolver(false); setView('tokens'); setResolverFile(file); setEditingSet(undefined);
        };
        setReview(next);
      }} />}
    <ActionDialog open={importChanges} busy={busy} title="Import proposal" onOpenChange={(open) => {
      if (!busy && !open) { setImportChanges(false); setError(''); }
    }} description="Choose a file with edits to the tokens you have open. You’ll review the changes before applying them."
      actions={<Button disabled={busy} onClick={() => proposalInput.current?.click()}>Choose file…</Button>}>
      {importChanges && error && <Alert variant="destructive"><AlertDescription className="max-h-36 overflow-auto whitespace-pre-wrap">{error}</AlertDescription></Alert>}
    </ActionDialog>
    <ActionDialog open={penpotOpen} busy={busy} title="Import Penpot tokens" onOpenChange={(open) => {
      if (!busy && !open) { setPenpotOpen(false); setPenpotFile(null); setError(''); }
    }} description="Compare a Penpot token export with the open tokens. Review the changes before applying them."
      actions={<><Button variant="text" disabled={busy} onClick={() => penpotInput.current?.click()}>{penpotFile ? 'Choose another file…' : 'Choose file…'}</Button>
        <Button disabled={busy || !penpotFile || !penpotSet} onClick={() => { void reviewPenpotFile(); }}>Review changes</Button></>}>
      {penpotFile && <div className="grid gap-2 copy-body"><p>{penpotFile.name}</p>
        <label htmlFor="penpot-token-set">Token set</label>
        <Select id="penpot-token-set" value={penpotSet} onChange={event => setPenpotSet(event.target.value)}>
          <SelectOption value="">Select a token set</SelectOption>
          {penpotFile.sets.map(set => <SelectOption key={set} value={set}>{set}</SelectOption>)}
        </Select>
        <p>Only existing token values are imported. Check changes carefully if the export is older than the workspace.</p></div>}
      {penpotOpen && error && <Alert variant="destructive"><AlertDescription className="max-h-36 overflow-auto whitespace-pre-wrap">{error}</AlertDescription></Alert>}
    </ActionDialog>
    <ActionDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} title="Keyboard shortcuts"
      description="Tap Alt, then press the letters shown on screen. Use Command in place of Ctrl on macOS.">
      <div className="grid gap-4 copy-body">
        <section className="grid gap-2">
          <h3 className="token-editor-section-title">Workspace</h3>
          <dl className="shortcut-list grid gap-2">
            <div><dt className="copy-emphasis">Alt, then T / V / W</dt><dd>Open Tokens, Variants, or Workspace.</dd></div>
            <div><dt className="copy-emphasis">Alt, then C / G / S</dt><dd>Focus token controls, groups, or token search from Tokens.</dd></div>
            <div><dt className="copy-emphasis">Alt, then F / E / I / A / K</dt><dd>Open File, Edit, View, Variants, or Help.</dd></div>
            <div><dt className="copy-emphasis">Alt, then B / M / D / N / R / H</dt><dd>Show bulk edit or move and delete commands, edit or create a token, review changes, or open group actions. Available keys follow the current view.</dd></div>
          </dl>
        </section>
        <section className="grid gap-2">
          <h3 className="token-editor-section-title">Menus and toolbars</h3>
          <dl className="shortcut-list grid gap-2">
            <div><dt className="copy-emphasis">Tab / Shift + Tab</dt><dd>Move to the next or previous control group.</dd></div>
            <div><dt className="copy-emphasis">Left / Right</dt><dd>Move across a toolbar or the top menus.</dd></div>
            <div><dt className="copy-emphasis">Up / Down</dt><dd>Move through menu items or the navigation rail. Down also opens a focused top menu.</dd></div>
            <div><dt className="copy-emphasis">Home / End</dt><dd>Go to the first or last item in a menu or toolbar.</dd></div>
            <div><dt className="copy-emphasis">Enter / Space or a displayed letter</dt><dd>Activate a menu item. Escape closes the menu.</dd></div>
            <div><dt className="copy-emphasis">Escape from Tokens controls</dt><dd>Return to the last focused grid cell.</dd></div>
          </dl>
        </section>
        <section className="grid gap-2">
          <h3 className="token-editor-section-title">Token grid</h3>
          <dl className="shortcut-list grid gap-2">
            <div><dt className="copy-emphasis">Arrows / Ctrl + Arrows</dt><dd>Move between cells or jump to an edge of the visible grid.</dd></div>
            <div><dt className="copy-emphasis">Home / End</dt><dd>Jump to the first or last column. Add Ctrl to jump to the first or last cell on the page.</dd></div>
            <div><dt className="copy-emphasis">Space / Ctrl + Space / Shift + Space</dt><dd>Toggle the row with Space or Ctrl + Space. Shift + Space checks just that row.</dd></div>
            <div><dt className="copy-emphasis">Shift + Up / Down</dt><dd>Extend the checked range. Add Ctrl to extend to the first or last visible row.</dd></div>
            <div><dt className="copy-emphasis">Ctrl + A / Escape</dt><dd>Check all rows on the current page or clear the selection.</dd></div>
            <div><dt className="copy-emphasis">Enter / F2</dt><dd>Edit the focused cell. Enter or Tab applies an inline edit and moves forward. Shift reverses direction. Escape cancels.</dd></div>
            <div><dt className="copy-emphasis">Alt + Shift + Left / Right</dt><dd>Resize the focused column.</dd></div>
            <div><dt className="copy-emphasis">Alt + Down or Shift + F10</dt><dd>Open the focused row’s actions. The Context Menu key also works.</dd></div>
            <div><dt className="copy-emphasis">Ctrl + C / V</dt><dd>Copy or paste tokens in a source workspace.</dd></div>
            <div><dt className="copy-emphasis">Ctrl + Z / Y</dt><dd>Undo or redo. Ctrl + Shift + Z also redoes.</dd></div>
          </dl>
        </section>
        <section className="grid gap-2">
          <h3 className="token-editor-section-title">Link picker and panes</h3>
          <dl className="shortcut-list grid gap-2">
            <div><dt className="copy-emphasis">Up / Down</dt><dd>Move between the link picker’s search field and results.</dd></div>
            <div><dt className="copy-emphasis">Enter / Ctrl + Enter</dt><dd>Choose the first matching result from search or apply the selected link.</dd></div>
            <div><dt className="copy-emphasis">Left / Right or Home / End</dt><dd>Adjust a focused pane divider or set it to its minimum or maximum.</dd></div>
          </dl>
        </section>
      </div>
    </ActionDialog>
    {diagnosticsOpen && <DiagnosticsDialog graph={diagnosticGraph} close={() => setDiagnosticsOpen(false)} editSource={setSourceLocation}
      repair={(path, link) => { setView('tokens'); jump(path); if (link && !current) edit(path, 'value', true); else openInspector(path); }}
      sourceFor={(issue, location) => {
        if (!preview || location.file !== model?.file || issue.target.kind === 'source' || issue.offset !== undefined) return location;
        const source = winningOrigins(preview, issue.path).at(-1);
        return source ? { ...location, file: source.file, path: [...source.parts, ...location.path.slice(issue.path.split('.').length)],
          ...(variantScope ? { resolver: variantScope } : {}) } : location;
      }}
      jump={({ kind, path }) => { setView('tokens'); if (kind === 'token') jump(path); else selectGroup(path); }} />}
    {metadataLocation && <MetadataDialog workspace={data} location={metadataLocation} reviewing={!!review}
      close={() => setMetadataLocation(null)} prepare={changes => reviewMetadataChanges(data, metadataLocation.path, changes)}
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
    {bulkEdit && <BulkEditDialog workspace={data} {...bulkEdit} prepareRename={current ? moves => prepareStructure('rename', moves) : undefined}
      {...(variantScope && current ? { scope: { review: variantScope, resolution: current },
        definitions: editingLabel ? [editingLabel] : [...new Set(bulkEdit.paths.flatMap(path => {
          const origin = winningOrigins(current, path).at(-1);
          return origin ? [originName(origin)] : [];
        }))] } : {})}
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
    {relocate && <MoveDialog {...relocate} graph={graph} model={current ? model : undefined} files={data.files} offThread={largeWorkspace} scopeLabel={current ? editingLabel ?? 'All tokens' : undefined} reviewing={!!review} close={() => setRelocate(null)}
      prepare={(moves, target) => current ? prepareStructure(relocate.operation, moves, target) : graph.rows.length >= 1000 ?
        runWorkspaceReview({ kind: 'move', workspace: data, moves, operation: relocate.operation }) :
        relocate.operation === 'duplicate' ? reviewDuplicate(data, moves) : reviewMoves(data, moves, relocate.operation === 'rename')}
      review={pending => {
        afterReviewApplied.current = () => {
          setRelocate(null);
          if (current) {
            const destination = pending.structure?.destination;
            clearSelection(!destination);
            if (destination) {
              const option = destination.layer.option;
              setEditingSet(destination.layer.set ?? (option ? JSON.stringify([option.modifier, option.context]) : ''));
              setGroup(destination.group);
              resetScroll();
            }
          }
        };
        setError('');
        if (pending.structure) pending.structure.title = 'Review ' + pending.structure.title.toLowerCase();
        setReview(pending);
      }} />}
    {draft?.create && <ActionDialog open={!review} busy={busy} title={draft.groupOnly ? 'New group' : draft.name === '$root' ? 'Add group value' : 'New token'}
      description={displayedGroup || 'All tokens'} onOpenChange={(open) => { if (!open && !busy) cancel(); }}>
      <TokenEditForm initialDraft={draft} {...{ graph, busy, cancel, error, commit }} {...(current && model ? { sourceChoices, referenceFile: model.file } : {})} />
    </ActionDialog>}
    <ReviewChanges data={reviewData} {...{ busy, error }} close={closeReview} save={saveReview} onClosed={() => {
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
    <ReviewChanges data={finalReviewData} busy={busy} error={error}
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
