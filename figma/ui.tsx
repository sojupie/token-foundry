import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppBar, IconButton, NavigationBar, NavigationItem, Progress, Snackbar } from '@token-catalog/forge-react';
import { Alert, AlertDescription } from '../editor/components/ui/alert.tsx';
import { DesktopCloud, GitCompareArrows, Layers, RefreshCw } from '../editor/icons.tsx';
import { isBundle, isFigmaValue, isTokenProposal, maximumBytes, sameLocalValue, sameSourceValue } from '../integrations/figma/contract.ts';
import { parseEasingInput } from '../integrations/figma/easing.ts';
import type { FigmaBundle, FigmaValue, TokenProposal, VariableRow } from '../integrations/figma/contract.ts';
import { proposalReview, readBundle } from '../integrations/figma/projection.ts';
import { changedValues, importedValue, isAcknowledgement, isLocalValue, isPullConflict, pullValues } from '../integrations/figma/merge.ts';
import type { LocalValue, PullChoice, PullConflict } from '../integrations/figma/merge.ts';
import { parseVariableValue } from '../integrations/figma/conflict-review.tsx';
import { openWorkspace } from '../lib/workspace.ts';
import { isRecord, isUnknownArray } from '../lib/json.ts';
import { figmaRelayOrigin, parseConnection, parseInviteCode } from '../integrations/figma/transport.ts';
import { isNativeUnitConflict, type NativeUnitConflict } from './native-values.ts';
import { conflictInputKind } from '../integrations/figma/recovery.ts';
import type { ConflictDraft } from '../integrations/figma/recovery.ts';
import { identifySubmission, isOlderReceipt } from '../integrations/figma/submission.ts';
import { ObsoleteSync, StaleWorkspace, SyncOrder } from './sync-order.ts';
import { isTokenFormEntries, readTokenFormsCopy, splitTokenForms, tokenFormsCopy } from './forms.ts';
import type { TokenForm } from './forms.ts';
import { ChangesView } from './components/changes-view.tsx';
import { ConnectionView } from './components/connection-view.tsx';
import { TokensView } from './components/tokens-view.tsx';
import { SyncStatus } from './components/sync-status.tsx';
import {
  DEFAULT_FOUNDRY_ORIGIN,
  displayValue,
  hex,
  isConflict,
  parseColor,
  randomToken,
  remoteRequest,
  retryableConnectionError,
  reviewDrafts,
  syncFigmaTheme,
  workspaceIdentity,
  type FileContext,
  type NativeSnapshot,
  type PluginView,
  type PluginWorkspace,
  type PullReviewState,
  type ServerConflictReview,
  type SourceConnectionPrompt,
  ConnectionError,
} from './ui-types.ts';
import '@token-catalog/forge-react/styles.css';
import './ui.css';

const uiClient = randomToken();
const send = (message: Record<string, unknown>) => parent.postMessage({ pluginMessage: { ...message, client: uiClient } }, '*');

function App() {
  const syncOrder = useRef(new SyncOrder());
  const [view, setView] = useState<PluginView>('tokens');
  const [fileContext, setDocument] = useState<FileContext>({ id: '', name: '', fileKey: '', selection: [] });
  const [workspace, setWorkspace] = useState<PluginWorkspace>();
  const [savedConcept, setSavedConcept] = useState(false);
  const [foundryOrigin, setFoundryOrigin] = useState(DEFAULT_FOUNDRY_ORIGIN);
  const [sourceConnection, setSourceConnection] = useState<SourceConnectionPrompt>();
  const documentIdentity = useRef('');
  const restoredWorkspace = useRef<string | undefined>(undefined);
  const [pairing, setPairing] = useState<{ id: string; secret: string; started: number }>();
  const [serverReview, setServerReview] = useState<ServerConflictReview>();
  const reviewWrites = useRef(Promise.resolve());
  const syncing = useRef(false);
  const resumeRequired = useRef(false);
  const retry = useRef({ failures: 0, after: 0 });
  const retryConnection = useRef<{ code: string; resume: boolean } | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const receipt = useRef('');
  const nativeSnapshot = useRef<NativeSnapshot>({ local: new Map(), changed: 0, recovery: false, units: 0, acknowledgedReceipt: '' });
  const [sourceReviewNeeded, setSourceReviewNeeded] = useState(false);
  const [bundle, setBundle] = useState<FigmaBundle>();
  const [local, setLocal] = useState(new Map<string, unknown>());
  const reviewNative = useMemo(
    () => ({
      rows: bundle?.variables ?? [],
      values: new Map([...local].flatMap(([path, val]) => (isLocalValue(val) ? [[path, val] as const] : []))),
    }),
    [bundle, local],
  );
  const [changed, setChanged] = useState(0);
  const [nativeIssue, setNativeIssue] = useState('');
  const [message, setMessage] = useState('Connect a workspace or open a snapshot to begin.');
  const [alertMessage, setAlertMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [unitConflicts, setUnitConflicts] = useState<NativeUnitConflict[]>([]);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<VariableRow>();
  const [editBefore, setEditBefore] = useState<LocalValue>();
  const [editRevision, setEditRevision] = useState('');
  const [editProblem, setEditProblem] = useState('');
  const [editProblemAction, setEditProblemAction] = useState<'current' | 'foundry'>('current');
  const pendingEdit = useRef<string | undefined>(undefined);
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<'value' | 'alias'>('value');
  const forms = useRef<TokenForm[]>([]);
  const [formPaths, setFormPaths] = useState<string[]>([]);
  const [formAlternatives, setFormAlternatives] = useState<TokenForm[]>([]);
  const formSerial = useRef(0);
  const formConfirmations = useRef(new Map<number, (error?: string) => void>());
  const resumingConflict = useRef(false);
  const [formsReady, setFormsReady] = useState(false);
  const [formStatus, setFormStatus] = useState('');
  const [formError, setFormError] = useState(false);
  const pendingForm = useRef<{ path: string; form: TokenForm; result: LocalValue } | undefined>(undefined);
  const [connectionText, setConnectionText] = useState('');
  const [connection, setConnection] = useState<ReturnType<typeof parseConnection>>();
  const [savedConnection, setSavedConnection] = useState('');
  const [connectionProblem, setConnectionProblem] = useState('');
  const [conflicts, setConflicts] = useState<PullConflict[]>([]);
  const [pullDrafts, setPullDrafts] = useState<ConflictDraft[]>([]);
  const conflictForms = useRef(new Map<string, { form: TokenForm; owned: boolean }>());
  const conflictApplication = useRef<{ context: 'server' | 'pull'; revision?: string; forms: { key: string; form: TokenForm; value: LocalValue | null }[] } | undefined>(undefined);
  const [pullReview, setPullReview] = useState<PullReviewState>();
  const [exported, setExported] = useState<TokenProposal>();
  const [library, setLibrary] = useState('');
  const [libraryCompatible, setLibraryCompatible] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const formUpload = useRef<HTMLInputElement>(null);
  const proposalSerial = useRef(0);
  const nativeSerial = useRef(0);
  const nativeOperation = useRef<{ serial: number; generation: number; type: string } | undefined>(undefined);
  const nativeWaiters = useRef<(() => void)[]>([]);

  function releaseNativeWaiters() {
    const waiting = nativeWaiters.current;
    nativeWaiters.current = [];
    waiting.forEach(resolve => resolve());
  }

  async function waitForNative(generation: number) {
    syncOrder.current.assert(generation);
    if (nativeOperation.current) {
      await new Promise<void>(resolve => {
        nativeWaiters.current.push(resolve);
      });
      return waitForNative(generation);
    }
  }

  function mutateNative(payload: Record<string, unknown> & { type: string }) {
    const serial = ++nativeSerial.current;
    nativeOperation.current = { serial, generation: syncOrder.current.current(), type: payload.type };
    setBusy(true);
    send({ ...payload, serial });
  }

  function settleNative(data: Record<string, unknown>) {
    const operation = nativeOperation.current;
    if (!operation) return data['serial'] === undefined;
    if (data['request'] !== undefined && data['request'] !== operation.type) return false;
    if (data['serial'] !== operation.serial) return false;
    nativeOperation.current = undefined;
    queueMicrotask(releaseNativeWaiters);
    if (!syncOrder.current.active(operation.generation)) {
      if (!syncing.current) setBusy(false);
      return false;
    }
    return true;
  }

  const proposalIntent = useRef<{ serial: number; action: 'download' | 'send'; generation: number; target?: ReturnType<typeof parseConnection> } | undefined>(undefined);

  function invalidateSync() {
    syncOrder.current.begin();
    releaseNativeWaiters();
    proposalIntent.current = undefined;
    retryConnection.current = undefined;
    resumeRequired.current = false;
    setSourceConnection(undefined);
    setPairing(undefined);
    syncing.current = false;
    if (!nativeOperation.current) setBusy(false);
  }

  async function request(target: ReturnType<typeof parseConnection>, method: string, body: unknown, generation: number) {
    syncOrder.current.assert(generation);
    let result: unknown;
    try {
      result = await remoteRequest(target, method, body);
    } catch (error) {
      syncOrder.current.assert(generation);
      throw error;
    }
    syncOrder.current.assert(generation);
    if (isRecord(result)) syncOrder.current.accept(generation, workspaceIdentity(result['workspace'], documentIdentity.current));
    return result;
  }

  function requestProposal(action: 'download' | 'send') {
    const serial = ++proposalSerial.current;
    proposalIntent.current = { serial, action, generation: syncOrder.current.current(), ...(connection ? { target: connection } : {}) };
    send({ type: 'proposal', serial, ...(workspace ? { id: workspace.id } : {}) });
  }

  function persistForms(next: TokenForm[]) {
    const split = splitTokenForms(next);
    forms.current = [...split.forms, ...split.conflicts];
    setFormPaths(forms.current.map(form => form.row.path));
    setFormAlternatives(split.conflicts);
    setFormError(false);
    setFormStatus('Saving unfinished edits on this device…');
    const serial = ++formSerial.current;
    send({ type: 'save-token-forms', forms: forms.current, serial });
    return serial;
  }

  function confirmForms(next: TokenForm[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const serial = persistForms(next);
      const timer = setTimeout(() => {
        formConfirmations.current.delete(serial);
        reject(new Error('Device recovery was not confirmed. Keep editing from Changes.'));
      }, 15_000);
      formConfirmations.current.set(serial, error => {
        clearTimeout(timer);
        formConfirmations.current.delete(serial);
        if (error) reject(new Error(error));
        else resolve();
      });
    });
  }

  function retainForm(text: string, nextKind = kind) {
    setValue(text);
    setKind(nextKind);
    if (!selected || editBefore === undefined || workspace?.role === 'concept') return;
    persistForms([{ row: selected, before: editBefore, revision: editRevision, kind: nextKind, text }, ...forms.current.filter(form => form.row.path !== selected.path)]);
  }

  function retainConflictInput(drafts: ConflictDraft[], context: 'server' | 'pull') {
    const native = nativeSnapshot.current;
    const source = native.bundle;
    if (!source) return;
    let next = forms.current;
    for (const [key, previous] of conflictForms.current) {
      if (!key.startsWith(context + ':') || drafts.some(draft => draft.path === previous.form.row.path)) continue;
      if (previous.owned) next = next.filter(form => !sameSourceValue(form, previous.form));
      conflictForms.current.delete(key);
    }
    for (const draft of drafts) {
      const inputKind = conflictInputKind(draft);
      if (!inputKind) continue;
      const row = source.variables.find(token => token.path === draft.path);
      const before = native.local.get(draft.path);
      if (!row || !isLocalValue(before)) continue;
      const key = context + ':' + draft.path;
      const previous = conflictForms.current.get(key);
      if (previous?.owned) next = next.filter(form => !sameSourceValue(form, previous.form));
      const form: TokenForm = { row, before, revision: source.revision, kind: inputKind, text: draft.text };
      const exists = next.some(existing => sameSourceValue(existing, form));
      if (!exists) next = [form, ...next];
      conflictForms.current.set(key, { form, owned: !exists });
    }
    if (!sameSourceValue(next, forms.current)) persistForms(next);
  }

  function prepareConflictApplication(context: 'server' | 'pull', choices: PullChoice[], revision?: string) {
    const retained = [...conflictForms.current].flatMap(([key, entry]) => {
      if (!key.startsWith(context + ':')) return [];
      const choice = choices.find(item => item.path === entry.form.row.path);
      if (!choice) return [];
      let fulfilled = false;
      try {
        fulfilled = sameLocalValue(entry.form.kind === 'alias' ? { alias: entry.form.text } : parseVariableValue(entry.form.row, entry.form.text), choice.value);
      } catch { /* An explicit choice can supersede invalid draft input. */ }
      return entry.owned || fulfilled ? [{ key, form: entry.form, value: choice.value }] : [];
    });
    conflictApplication.current = { context, forms: retained, ...(revision ? { revision } : {}) };
  }

  function settleConflictApplication() {
    const pending = conflictApplication.current;
    const native = nativeSnapshot.current;
    if (!pending?.revision || native.bundle?.revision !== pending.revision || native.recovery || native.units || native.issue) return;
    let next = forms.current;
    for (const item of pending.forms) {
      const applied = item.value === null
        ? !native.bundle.variables.some(row => row.path === item.form.row.path)
        : sameLocalValue(native.local.get(item.form.row.path), item.value);
      if (!applied) continue;
      const shared = [...conflictForms.current].some(([key, entry]) => key !== item.key && sameSourceValue(entry.form, item.form));
      if (!shared) next = next.filter(form => !sameSourceValue(form, item.form));
      if (sameSourceValue(conflictForms.current.get(item.key)?.form, item.form)) conflictForms.current.delete(item.key);
    }
    if (pending.context === 'pull') setPullDrafts([]);
    conflictApplication.current = undefined;
    if (!sameSourceValue(next, forms.current)) persistForms(next);
  }

  function discardForm(path: string) {
    if (forms.current.some(form => form.row.path === path)) persistForms(forms.current.filter(form => form.row.path !== path));
    for (const [key, entry] of conflictForms.current) if (entry.form.row.path === path) conflictForms.current.delete(key);
    if (selected?.path === path) setSelected(undefined);
  }

  function resumeForm(form: TokenForm) {
    setView('tokens');
    setSelected(form.row);
    setEditBefore(form.before);
    setEditRevision(form.revision);
    setValue(form.text);
    setKind(form.kind);
    setEditProblem('');
  }

  function earlierConflictInput(draft: ConflictDraft): (() => void) | undefined {
    const inputKind = conflictInputKind(draft);
    if (!connection || !serverReview || !inputKind) return undefined;
    const native = nativeSnapshot.current;
    const row = native.bundle?.variables.find(token => token.path === draft.path);
    const before = native.local.get(draft.path);
    const existing = forms.current.find(form => form.row.path === draft.path && form.text === draft.text && form.kind === inputKind);
    const form: TokenForm | undefined = existing ?? (row && native.bundle && isLocalValue(before)
      ? { row, before, revision: native.bundle.revision, kind: inputKind, text: draft.text }
      : undefined);
    if (!form) return undefined;
    const target = connection;
    const review = serverReview;
    const generation = syncOrder.current.current();
    return () => {
      if (resumingConflict.current) return;
      resumingConflict.current = true;
      setBusy(true);
      void (async () => {
        try {
          await confirmForms([form, ...forms.current.filter(current => !sameSourceValue(current, form))]);
          syncOrder.current.assert(generation);
          conflictForms.current.delete('server:' + draft.path);
          await reviewWrites.current;
          const drafts = review.drafts.filter(current => current.path !== draft.path);
          await request(target, 'POST', { action: 'review', revision: review.current.revision, drafts }, generation);
          setServerReview(previous => previous && sameSourceValue(previous.proposal, review.proposal) ? { ...previous, drafts } : previous);
          if (!review.conflicts.length && !drafts.length) {
            prepareConflictApplication('server', []);
            const result = await request(target, 'POST', { proposal: review.proposal, choices: [], revision: review.current.revision }, generation);
            if (!isRecord(result) || result['accepted'] !== true) throw new Error('The workspace changed. Saved input remains available in Tokens.');
            await acceptRemote(result, target, generation, true);
          } else {
            setBusy(false);
            setNotice('Saved draft opened in Tokens. Finish the remaining review in Changes.');
          }
          if (forms.current.filter(current => current.row.path === form.row.path).length === 1) resumeForm(form);
          else {
            setView('tokens');
            setSelected(undefined);
          }
        } catch (error) {
          if (!syncOrder.current.active(generation) || error instanceof ObsoleteSync) return;
          conflictApplication.current = undefined;
          setBusy(false);
          syncing.current = false;
          setMessage(error instanceof Error ? error.message : String(error));
        } finally {
          resumingConflict.current = false;
        }
      })();
    };
  }

  function reviewFormBaseline() {
    const row = bundle?.variables.find(token => token.path === selected?.path);
    const current = row && local.get(row.path);
    if (!row || !isLocalValue(current) || !bundle) {
      setEditProblem('This token is absent from the current source. Your unfinished edit is still saved.');
      return;
    }
    setSelected(row);
    setEditBefore(current);
    setEditRevision(bundle.revision);
    setEditProblem('');
    persistForms([{ row, before: current, revision: bundle.revision, kind, text: value }, ...forms.current.filter(form => form.row.path !== row.path)]);
  }

  function downloadForms() {
    const url = URL.createObjectURL(new Blob([tokenFormsCopy(forms.current)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'foundry-token-edits.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importForms(file: File) {
    try {
      if (file.size > maximumBytes) throw new Error('The token edit copy exceeds the 8 MB limit.');
      const incoming = readTokenFormsCopy(await file.text());
      const collision = incoming.find(form => forms.current.some(existing => existing.row.path === form.row.path && !sameSourceValue(existing, form)));
      if (collision) throw new Error(`Finish or cancel the current edit for ${collision.row.path} before opening this copy.`);
      const merged = [...incoming, ...forms.current.filter(existing => !incoming.some(form => form.row.path === existing.row.path))];
      persistForms(merged);
      const split = splitTokenForms(merged);
      if (split.conflicts.length) {
        setSelected(undefined);
        setView('tokens');
      } else {
        const first = split.forms[0];
        if (first) resumeForm(first);
      }
    } catch (error) {
      setFormError(true);
      setFormStatus(error instanceof Error ? error.message : 'The token edit copy could not be read.');
    }
  }

  function connectionFailure(error: unknown) {
    if (error instanceof ObsoleteSync) return;
    const text = error instanceof Error ? error.message : String(error);
    setMessage(text);
    setAlertMessage(text);
    if (retryableConnectionError(error)) {
      const failures = Math.min(5, retry.current.failures + 1);
      retry.current = { failures, after: Date.now() + Math.min(60_000, 3000 * 2 ** failures) };
      setOffline(true);
    }
    if (error instanceof ConnectionError && [401, 403, 410].includes(error.status)) {
      invalidateSync();
      setConnection(undefined);
      setConnectionProblem('Reconnect this device to resume syncing.');
    }
    if (error instanceof ConnectionError && (error.code === 'source-baseline-unavailable' || [400, 422].includes(error.status))) {
      setSourceReviewNeeded(true);
    }
  }

  function connectionSucceeded() {
    retry.current = { failures: 0, after: 0 };
    setOffline(false);
    setAlertMessage('');
  }

  function retainReview(next: ServerConflictReview) {
    setServerReview(previous => previous && sameSourceValue(previous.proposal, next.proposal) ? { ...next, drafts: previous.drafts } : next);
  }

  async function acceptRemote(data: unknown, target: ReturnType<typeof parseConnection> | undefined, generation: number, confirmed = false, reviewSource = false) {
    await waitForNative(generation);
    if (!isRecord(data)) throw new Error('The workspace response was incomplete.');
    const identity = workspaceIdentity(data['workspace'], documentIdentity.current);
    const role = identity?.role ?? 'library';
    const next = await readBundle(JSON.stringify(data));
    await waitForNative(generation);
    syncOrder.current.accept(generation, identity);
    if (reviewSource) resumeRequired.current = false;
    else if (resumeRequired.current && target && identity?.role === 'library') {
      await pullRemote(target.url + '#' + target.secret, true);
      return;
    }
    if (
      identity &&
      identity.id === (workspace?.id ?? restoredWorkspace.current) &&
      isAcknowledgement(data['acknowledgement']) &&
      isOlderReceipt(data['acknowledgement'].id, nativeSnapshot.current.acknowledgedReceipt)
    ) {
      throw new StaleWorkspace('A newer source acknowledgement is already applied.');
    }
    connectionSucceeded();
    const native = nativeSnapshot.current;
    if (!confirmed && target && identity && (workspace?.id ?? restoredWorkspace.current) !== identity.id && native.bundle && !sameSourceValue(native.bundle.files, next.files) && role === 'library') {
      setSourceConnection({ data, target, name: next.name, count: next.variables.length, generation });
      setView('changes');
      setMessage('Review source change before connecting this file.');
      setBusy(false);
      syncing.current = false;
      return;
    }
    if (identity) {
      setWorkspace(identity);
      setSavedConcept(identity.role === 'concept');
    }
    setSourceConnection(undefined);
    setSavedConnection(next.name);
    if (target) {
      send({
        type: 'remember-connection',
        connection: target.url + '#' + target.secret,
        name: next.name,
        concept: role === 'concept',
        ...(typeof data['expires'] === 'number' ? { expires: data['expires'] } : {}),
      });
    }
    const pending = data['pending'];
    if (isRecord(pending) && isTokenProposal(pending['proposal']) && isBundle(pending['current']) && isUnknownArray(pending['conflicts']) && pending['conflicts'].every(isPullConflict)) {
      const updated = {
        proposal: pending['proposal'],
        current: pending['current'],
        conflicts: pending['conflicts'],
        drafts: reviewDrafts(pending['drafts']),
        updated: pending['reviewChanged'] === true,
      };
      if (!serverReview) setView('changes');
      retainReview(updated);
      setMessage('Conflicting token edits need review.');
      setBusy(false);
      syncing.current = false;
      return;
    }
    if (role === 'library' && (native.recovery || native.units || native.issue)) {
      setView('changes');
      setMessage(native.issue ?? 'Finish recovery before syncing this workspace.');
      setBusy(false);
      syncing.current = false;
      return;
    }
    if (identity && target && role === 'library' && native.bundle && native.changed > 0 && data['accepted'] !== true && !reviewSource) {
      const values = new Map<string, LocalValue>();
      for (const [path, localValue] of native.local) {
        if (!isLocalValue(localValue)) throw new Error('Review the unsupported value for ' + path + '.');
        values.set(path, localValue);
      }
      const proposal = await identifySubmission(changedValues(native.bundle, values), native.acknowledgedReceipt, identity.id, native.intentId, native.intentSequence);
      syncOrder.current.assert(generation);
      if (nativeOperation.current || native !== nativeSnapshot.current) {
        await acceptRemote(data, target, generation, confirmed, reviewSource);
        return;
      }
      if (proposal.changes.length) {
        syncing.current = true;
        const result = await request(target, 'POST', proposal, generation);
        if (isRecord(result) && result['accepted'] === false && isBundle(result['current']) && isUnknownArray(result['conflicts']) && result['conflicts'].every(isPullConflict)) {
          retainReview({
            proposal,
            current: result['current'],
            conflicts: result['conflicts'],
            drafts: reviewDrafts(result['drafts']),
            updated: result['reviewChanged'] === true,
          });
          setView('changes');
          setMessage('Choose which conflicting values to keep.');
          setBusy(false);
          syncing.current = false;
          return;
        }
        if (!isRecord(result) || result['accepted'] !== true) throw new Error('The workspace did not accept these edits.');
        await acceptRemote(result, target, generation, true);
        return;
      }
    }
    if (conflictApplication.current?.context === 'server') conflictApplication.current.revision = next.revision;
    setServerReview(undefined);
    if (isAcknowledgement(data['acknowledgement'])) receipt.current = data['acknowledgement'].id;
    if (role === 'concept') {
      setBundle(next);
      setLocal(new Map(next.variables.map(row => [row.path, row.alias ? { alias: row.alias } : row.value])));
      setChanged(0);
      setMessage('Connected to shared library tokens.');
      if (target) await request(target, 'POST', { action: 'acknowledge', revision: next.revision }, generation);
      setBusy(false);
      syncing.current = false;
      return;
    }
    setBusy(true);
    syncing.current = true;
    mutateNative({ type: 'pull', bundle: next, ...(isAcknowledgement(data['acknowledgement']) ? { acknowledgement: data['acknowledgement'] } : {}) });
  }

  const localChanges = useMemo(() => {
    if (!bundle || unitConflicts.length) return [];
    try {
      return changedValues(bundle, reviewNative.values).changes;
    } catch {
      return [];
    }
  }, [bundle, reviewNative.values, unitConflicts.length]);

  const modifiedPaths = useMemo(() => new Set(localChanges.map(change => change.path)), [localChanges]);

  const cleanFoundryOrigin = () => (foundryOrigin.trim() || DEFAULT_FOUNDRY_ORIGIN).replace(/\/+$/u, '');
  const openFoundryWorkspace = () => {
    if (workspace) send({ type: 'open-workspace', id: workspace.id, origin: cleanFoundryOrigin() });
  };

  function revertTokenByPath(path: string) {
    if (!bundle) return;
    const row = bundle.variables.find(candidate => candidate.path === path);
    if (!row || !row.editable || workspace?.role === 'concept') return;
    const current = reviewNative.values.get(row.path);
    if (current === undefined) return;
    const baseline = importedValue(row);
    if (forms.current.some(form => form.row.path === row.path)) persistForms(forms.current.filter(form => form.row.path !== row.path));
    for (const [key, entry] of conflictForms.current) if (entry.form.row.path === row.path) conflictForms.current.delete(key);
    setBusy(true);
    setEditProblem('');
    pendingEdit.current = row.path;
    mutateNative({
      type: 'edit',
      path: row.path,
      expected: current,
      revision: bundle.revision,
      ...(isRecord(baseline) && typeof baseline['alias'] === 'string' ? { alias: baseline['alias'] } : { value: baseline }),
    });
    setMessage(`Reverting ${row.path} in Figma…`);
  }

  async function pullRemote(code = connectionText, resume = false) {
    const generation = syncOrder.current.begin();
    proposalIntent.current = undefined;
    releaseNativeWaiters();
    resumeRequired.current = false;
    setBusy(true);
    syncing.current = true;
    retryConnection.current = { code, resume };
    try {
      let resolvedCode = code;
      if (!resume && resolvedCode.includes('/invites/')) {
        const invite = parseInviteCode(resolvedCode);
        if (!fileContext.id) throw new Error('Waiting for Figma file details. Try again in a moment.');
        setMessage('Redeeming pairing code…');
        const redeemed = await remoteRequest(invite, 'POST', { document: fileContext.id, name: fileContext.name || 'Figma file' });
        syncOrder.current.assert(generation);
        if (!isRecord(redeemed) || typeof redeemed['connection'] !== 'string') throw new Error('The pairing response did not include a device connection.');
        resolvedCode = redeemed['connection'];
        setConnectionText(resolvedCode);
      }
      const target = parseConnection(resolvedCode);
      setConnection(target);
      const saved = nativeSnapshot.current.bundle;
      const data = resume && saved
        ? await request(target, 'POST', { action: 'resume', revision: saved.revision, ...(nativeSnapshot.current.acknowledgedReceipt ? { acknowledgedReceipt: nativeSnapshot.current.acknowledgedReceipt } : {}) }, generation)
        : await request(target, 'GET', undefined, generation);
      await acceptRemote(data, target, generation);
      syncOrder.current.assert(generation);
      retryConnection.current = undefined;
    } catch (error) {
      if (!syncOrder.current.active(generation) || error instanceof ObsoleteSync) return;
      if (error instanceof StaleWorkspace) {
        retryConnection.current = undefined;
        setMessage(error.message);
        setBusy(false);
        syncing.current = false;
        return;
      }
      const retryable = retryableConnectionError(error);
      if (!retryable) {
        retryConnection.current = undefined;
        if (!(error instanceof ConnectionError && error.code === 'source-baseline-unavailable')) setConnection(undefined);
      }
      connectionFailure(error);
      setBusy(false);
      syncing.current = false;
    }
  }

  const onMessage = useEffectEvent((event: MessageEvent<unknown>) => {
    if (event.source && event.source !== parent && event.source !== window && event.source !== top) return;
    if (!isRecord(event.data) || !isRecord(event.data['pluginMessage'])) return;
    const data = event.data['pluginMessage'];
    if (data['client'] !== undefined && data['client'] !== uiClient) return;

    if (data['type'] === 'saved-token-forms' && isTokenFormEntries(data['forms'])) {
      if (!formSerial.current) {
        const split = splitTokenForms(data['forms']);
        forms.current = [...split.forms, ...split.conflicts];
        setFormPaths(forms.current.map(form => form.row.path));
        setFormAlternatives(split.conflicts);
        if (split.conflicts.length) {
          setSelected(undefined);
          setView('tokens');
        } else {
          const latest = split.forms[0];
          if (latest) resumeForm(latest);
        }
      }
      setFormsReady(true);
    } else if (data['type'] === 'token-forms-saved') {
      if (typeof data['serial'] === 'number') formConfirmations.current.get(data['serial'])?.();
      if (data['serial'] === formSerial.current) {
        setFormError(false);
        setFormStatus('Unfinished edits saved on this device.');
      }
    } else if (data['type'] === 'token-forms-error' && typeof data['message'] === 'string') {
      if (typeof data['serial'] === 'number') formConfirmations.current.get(data['serial'])?.(data['message']);
      else for (const complete of formConfirmations.current.values()) complete(data['message']);
      if (typeof data['serial'] !== 'number' || data['serial'] === formSerial.current) {
        setFormsReady(true);
        setFormError(true);
        setFormStatus(data['message']);
      }
    } else if (data['type'] === 'document' && typeof data['document'] === 'string' && typeof data['name'] === 'string') {
      documentIdentity.current = data['document'];
      setDocument({
        id: data['document'],
        name: data['name'],
        fileKey: typeof data['fileKey'] === 'string' ? data['fileKey'] : '',
        selection: isUnknownArray(data['selection'])
          ? data['selection'].filter(isRecord).flatMap(node =>
              typeof node['id'] === 'string' && typeof node['name'] === 'string' && typeof node['type'] === 'string'
                ? [{
                    id: node['id'],
                    name: node['name'],
                    type: node['type'],
                    tokens: isUnknownArray(node['tokens'])
                      ? node['tokens'].filter(isRecord).flatMap(token =>
                          typeof token['field'] === 'string' && typeof token['path'] === 'string'
                            ? [{ field: token['field'], path: token['path'], remote: token['remote'] === true }]
                            : [])
                      : [],
                  }]
                : [])
          : [],
      });
    } else if (data['type'] === 'saved-connection' && typeof data['code'] === 'string') {
      if (typeof data['problem'] === 'string') {
        setConnectionProblem(data['problem']);
        setMessage(data['problem']);
      }
      if (!data['code'] || connectionText) return;
      try {
        parseConnection(data['code']);
      } catch {
        return;
      }
      setSavedConcept(data['concept'] === true);
      restoredWorkspace.current = /\/figma\/workspaces\/([a-f0-9]{64})\/files\//u.exec(data['code'])?.[1];
      setConnectionText(data['code']);
      setSavedConnection(typeof data['name'] === 'string' ? data['name'] : 'Foundry');
      if (data['resume'] === true) {
        if (nativeSnapshot.current.recovery) {
          setConnection(parseConnection(data['code']));
          setView('changes');
          setMessage('Finish the interrupted update before syncing.');
        } else {
          void pullRemote(data['code'], true);
        }
      }
    } else if (data['type'] === 'connection-forgotten') {
      invalidateSync();
      retryConnection.current = undefined;
      connectionSucceeded();
      setConnectionText('');
      setConnection(undefined);
      setSavedConnection('');
      setConnectionProblem('');
      setBusy(false);
      setWorkspace(undefined);
      setSavedConcept(false);
      setServerReview(undefined);
      syncing.current = false;
      setNotice('Connection forgotten on this device.');
      setMessage('Connection forgotten on this device. Your Figma values stay intact.');
    } else if (data['type'] === 'connection-storage-error' && typeof data['message'] === 'string') {
      setConnectionProblem(data['message']);
    } else if (data['type'] === 'connection-saved') {
      setConnectionProblem('');
    } else if (data['type'] === 'state') {
      const previousNative = nativeSnapshot.current;
      nativeSnapshot.current = {
        ...(isBundle(data['bundle']) ? { bundle: data['bundle'] } : {}),
        changed: Number(data['changed']),
        recovery: data['recovery'] === true,
        ...(typeof data['intentId'] === 'string' ? { intentId: data['intentId'] } : {}),
        ...(typeof data['intentSequence'] === 'number' ? { intentSequence: data['intentSequence'] } : {}),
        acknowledgedReceipt: typeof data['acknowledgedReceipt'] === 'string' ? data['acknowledgedReceipt'] : '',
        local: new Map(isUnknownArray(data['local']) ? data['local'].filter(isRecord).flatMap(row => typeof row['path'] === 'string' ? [[row['path'], row['value']] as const] : []) : []),
        units: isUnknownArray(data['unitConflicts']) ? data['unitConflicts'].filter(isNativeUnitConflict).length : 0,
        ...(typeof data['issue'] === 'string' ? { issue: data['issue'] } : {}),
      };
      settleConflictApplication();
      setNativeIssue(typeof data['issue'] === 'string' ? data['issue'] : '');
      if (workspace?.role === 'concept') {
        if (!syncing.current && !nativeOperation.current) setBusy(false);
        return;
      }
      setBundle(isBundle(data['bundle']) ? data['bundle'] : undefined);
      setChanged(Number(data['changed']));
      setRecovery(data['recovery'] === true);
      const units = isUnknownArray(data['unitConflicts']) ? data['unitConflicts'].filter(isNativeUnitConflict) : [];
      setUnitConflicts(units);
      if (typeof data['issue'] === 'string') setMessage(data['issue']);
      else if (data['recovery'] === true) {
        setView('changes');
        setMessage('Finish the interrupted snapshot update.');
      } else if (isBundle(data['bundle'])) {
        const count = Number(data['changed']);
        setMessage(count ? `${count} local ${count === 1 ? 'change' : 'changes'} waiting to sync.` : 'Figma values up to date.');
      } else {
        setMessage('Connect a workspace or open a snapshot to begin.');
      }
      if (units.length) setView('changes');
      if (isUnknownArray(data['local'])) {
        setLocal(new Map(data['local'].filter(isRecord).filter(row => typeof row['path'] === 'string').map(row => [typeof row['path'] === 'string' ? row['path'] : '', row['value']])));
      }
      if (nativeOperation.current?.type === 'resolve-native-unit' && data['serial'] === nativeOperation.current.serial) settleNative(data);
      if (!syncing.current && !nativeOperation.current && !proposalIntent.current) setBusy(false);
      if (
        connection &&
        workspace?.role === 'library' &&
        previousNative.bundle &&
        nativeSnapshot.current.bundle &&
        (previousNative.bundle.revision !== nativeSnapshot.current.bundle.revision || previousNative.acknowledgedReceipt !== nativeSnapshot.current.acknowledgedReceipt) &&
        !nativeOperation.current &&
        !data['issue'] &&
        !data['recovery']
      ) {
        resumeRequired.current = true;
        if (!syncing.current && !pullReview && !sourceConnection && !sourceReviewNeeded) {
          void pullRemote(connection.url + '#' + connection.secret, true);
          return;
        }
      }
      if (
        connection &&
        workspace?.role === 'library' &&
        Number(data['changed']) > 0 &&
        !data['issue'] &&
        !data['recovery'] &&
        !syncing.current &&
        !nativeOperation.current &&
        Date.now() >= retry.current.after &&
        !document.hidden &&
        !serverReview &&
        !pullReview &&
        !recovery &&
        !sourceConnection &&
        !sourceReviewNeeded
      ) {
        syncing.current = true;
        setBusy(true);
        requestProposal('send');
      }
    } else if (data['type'] === 'pulled') {
      if (!settleNative(data)) return;
      if (!conflictApplication.current && [...conflictForms.current.values()].some(entry => forms.current.some(form => sameSourceValue(form, entry.form)))) setView('changes');
      setPullDrafts([]);
      setMessage(workspace ? 'Saved to workspace.' : 'Source snapshot applied.');
      setNotice(workspace ? 'Workspace synced.' : 'Snapshot applied.');
      setConflicts([]);
      setPullReview(undefined);
      setBusy(false);
      syncing.current = false;
      setSourceReviewNeeded(false);
      if (connection && typeof data['revision'] === 'string') {
        const target = connection;
        const generation = syncOrder.current.current();
        syncing.current = true;
        setBusy(true);
        void request(target, 'POST', { action: 'acknowledge', revision: data['revision'] }, generation)
          .then(async () => {
            connectionSucceeded();
            if (!workspace || resumeRequired.current) await pullRemote(target.url + '#' + target.secret, resumeRequired.current);
            else {
              syncing.current = false;
              setBusy(!!nativeOperation.current);
              send({ type: 'inspect' });
            }
            return undefined;
          })
          .catch((error: unknown) => {
            if (!syncOrder.current.active(generation) || error instanceof ObsoleteSync) return;
            connectionFailure(error);
            syncing.current = false;
            setBusy(!!nativeOperation.current);
          });
      }
      if (connection && workspace) {
        send({ type: 'remember-connection', connection: connection.url + '#' + connection.secret, name: workspace.name, concept: workspace.role === 'concept' });
      }
    } else if (data['type'] === 'pull-cancelled') {
      if (!settleNative(data)) return;
      conflictApplication.current = undefined;
      setConflicts([]);
      setPullReview(undefined);
      setMessage('Pull cancelled. No Figma values changed.');
      setBusy(false);
      syncing.current = false;
    } else if (data['type'] === 'edited') {
      if (!settleNative(data)) return;
      const sentForm = pendingForm.current;
      const current = forms.current.find(form => form.row.path === data['path']);
      if (sentForm && sentForm.path === data['path'] && current && !sameSourceValue(sentForm.form, current)) {
        const native = nativeSnapshot.current;
        const row = native.bundle?.variables.find(token => token.path === current.row.path);
        const before = native.local.get(current.row.path);
        if (row && native.bundle && isLocalValue(before) && sameLocalValue(before, sentForm.result)) {
          const retained = { ...current, row, before, revision: native.bundle.revision };
          persistForms([retained, ...forms.current.filter(form => form.row.path !== current.row.path)]);
          if (selected?.path === current.row.path) {
            setSelected(row);
            setEditBefore(before);
            setEditRevision(native.bundle.revision);
          }
        }
      } else if (typeof data['path'] === 'string') {
        discardForm(data['path']);
      }
      if (sentForm?.path === data['path']) pendingForm.current = undefined;
      if (data['path'] === pendingEdit.current) pendingEdit.current = undefined;
      if (!syncing.current) setBusy(false);
      setNotice('Value applied in Figma.');
      send({ type: 'inspect' });
    } else if (data['type'] === 'error' && typeof data['message'] === 'string') {
      if (data['request'] === 'proposal') {
        const intent = proposalIntent.current;
        if (!intent || data['serial'] !== intent.serial || !syncOrder.current.active(intent.generation)) return;
        proposalIntent.current = undefined;
      } else if (!settleNative(data)) return;
      conflictApplication.current = undefined;
      if (pendingEdit.current && pendingEdit.current === selected?.path) {
        setEditProblem(data['message']);
        setEditProblemAction(data['code'] === 'timing-precision' || data['code'] === 'easing-precision' || data['code'] === 'number-precision' ? 'foundry' : 'current');
      }
      pendingEdit.current = undefined;
      pendingForm.current = undefined;
      if (data['request'] !== 'edit') {
        nativeSnapshot.current = { ...nativeSnapshot.current, issue: data['message'] };
        setNativeIssue(data['message']);
      }
      setMessage(data['message']);
      setBusy(false);
      syncing.current = false;
      if (data['request'] === 'edit') send({ type: 'inspect' });
    } else if (data['type'] === 'progress' && typeof data['message'] === 'string') {
      if (data['serial'] === undefined || data['serial'] === nativeOperation.current?.serial) setMessage(data['message']);
    } else if (data['type'] === 'library-available' && typeof data['name'] === 'string') {
      setLibrary(data['name']);
      setLibraryCompatible(data['compatible'] === true);
    } else if (data['type'] === 'library-built') {
      if (!settleNative(data)) return;
      const collectionCount = typeof data['collections'] === 'number' ? data['collections'] : undefined;
      const styleCount = typeof data['styles'] === 'number' ? data['styles'] : undefined;
      setNotice(
        collectionCount !== undefined || styleCount !== undefined || Number(data['components']) === 0
          ? `Foundations synced: ${collectionCount ?? 0} mode collections, ${styleCount ?? 0} styles.`
          : `UI kit updated: ${Number(data['components'])} component families, ${Number(data['variants'])} variants.`
      );
      if (!syncing.current) setBusy(false);
    } else if (data['type'] === 'conflicts' && isUnknownArray(data['conflicts']) && typeof data['id'] === 'string' && isBundle(data['incoming'])) {
      if (!settleNative(data)) return;
      setConflicts(data['conflicts'].filter(isConflict));
      const effective = isUnknownArray(data['local'])
        ? new Map(data['local'].filter(isRecord).flatMap(row => typeof row['path'] === 'string' && isLocalValue(row['value']) ? [[row['path'], row['value']] as const] : []))
        : new Map<string, LocalValue>();
      const desired = isUnknownArray(data['desired'])
        ? new Map(data['desired'].filter(isRecord).flatMap(row => typeof row['path'] === 'string' && isLocalValue(row['value']) ? [[row['path'], row['value']] as const] : []))
        : undefined;
      setPullReview({ id: data['id'], incoming: data['incoming'], local: effective, ...(desired ? { desired } : {}) });
      setView('changes');
      setMessage('The same tokens changed in Figma and Foundry. Choose which values to keep.');
      setBusy(false);
    } else if (data['type'] === 'proposal' && 'proposal' in data) {
      const intent = proposalIntent.current;
      if (!intent || data['serial'] !== intent.serial || !syncOrder.current.active(intent.generation)) return;
      proposalIntent.current = undefined;
      const generation = intent.generation;
      const proposal = data['proposal'];
      if (!isTokenProposal(proposal)) {
        setMessage('The Figma change message was invalid.');
        setBusy(false);
        return;
      }
      setExported(proposal);
      if (!proposal.changes.length) {
        setMessage('No local changes to send.');
        setBusy(false);
        syncing.current = false;
        return;
      }
      if (intent.action === 'send') {
        const target = intent.target;
        if (!target) return;
        if (resumeRequired.current) {
          void pullRemote(target.url + '#' + target.secret, true);
          return;
        }
        void request(target, 'POST', proposal, generation)
          .then(async result => {
            if (workspace) {
              if (isRecord(result) && result['accepted'] === false && isBundle(result['current']) && isUnknownArray(result['conflicts']) && result['conflicts'].every(isPullConflict)) {
                retainReview({
                  proposal,
                  current: result['current'],
                  conflicts: result['conflicts'],
                  drafts: reviewDrafts(result['drafts']),
                  updated: result['reviewChanged'] === true,
                });
                setView('changes');
                setMessage('Choose which conflicting values to keep.');
                setBusy(false);
                syncing.current = false;
              } else if (isRecord(result) && result['accepted'] === true) {
                await acceptRemote(result, target, generation);
              } else {
                throw new Error('The workspace did not acknowledge these edits.');
              }
            } else {
              setMessage('Changes sent. Review the connection in Foundry.');
              setBusy(false);
              syncing.current = false;
            }
            return undefined;
          })
          .catch((error: unknown) => {
            if (!syncOrder.current.active(generation) || error instanceof ObsoleteSync) return;
            connectionFailure(error);
            setBusy(false);
            syncing.current = false;
          });
      } else {
        const url = URL.createObjectURL(new Blob([JSON.stringify(proposal, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'token-proposal.json';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('Downloaded token-proposal.json.');
        setMessage('Import token-proposal.json in Foundry to review and apply these changes.');
        setBusy(false);
      }
    }
  });

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => onMessage(event);
    window.addEventListener('message', receive);
    send({ type: 'inspect' });
    send({ type: 'restore-connection' });
    send({ type: 'restore-token-forms' });
    return () => window.removeEventListener('message', receive);
  }, []);

  useEffect(() => syncFigmaTheme(), []);

  const pulse = useEffectEvent(() => {
    if (document.hidden || Date.now() < retry.current.after || syncing.current || nativeOperation.current) return;
    if (resumeRequired.current && connection && !recovery && !pullReview && !sourceConnection && !sourceReviewNeeded) {
      void pullRemote(connection.url + '#' + connection.secret, true);
      return;
    }
    if (retryConnection.current && !busy && !recovery && !sourceConnection && !sourceReviewNeeded) {
      void pullRemote(retryConnection.current.code, retryConnection.current.resume);
      return;
    }
    if (pairing) {
      if (Date.now() - pairing.started > 10 * 60 * 1000) {
        setPairing(undefined);
        setMessage('Pairing timed out. Connect workspace again to continue.');
        return;
      }
      syncing.current = true;
      const generation = syncOrder.current.current();
      void fetch(figmaRelayOrigin + '/figma/pairing/' + pairing.id, {
        headers: { Authorization: 'Bearer ' + pairing.secret },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
        .then(async response => {
          if (!response.ok) throw new ConnectionError(response.status, 'The pairing check failed.');
          const result: unknown = await response.json();
          syncOrder.current.assert(generation);
          connectionSucceeded();
          if (isRecord(result) && typeof result['connection'] === 'string') {
            setPairing(undefined);
            setConnectionText(result['connection']);
            await pullRemote(result['connection']);
          }
          return undefined;
        })
        .catch((error: unknown) => {
          if (syncOrder.current.active(generation)) connectionFailure(error);
        })
        .finally(() => {
          if (syncOrder.current.active(generation)) syncing.current = false;
        });
    } else if (connection && workspace && !busy && !recovery && !pullReview && !unitConflicts.length && !nativeSnapshot.current.issue && !sourceConnection && !sourceReviewNeeded) {
      if (changed && workspace.role === 'library' && !serverReview) {
        syncing.current = true;
        setBusy(true);
        requestProposal('send');
      } else {
        syncing.current = true;
        const generation = syncOrder.current.current();
        const target = connection;
        const queryTarget = { ...target, url: target.url + '?since=' + (bundle?.revision ?? '') + '&receipt=' + receipt.current };
        void request(queryTarget, 'GET', undefined, generation)
          .then(async result => {
            if (!isRecord(result) || result['unchanged'] !== true) await acceptRemote(result, target, generation);
            else {
              const identity = workspaceIdentity(result['workspace'], documentIdentity.current);
              if (identity && identity.id !== workspace.id) throw new Error('The workspace response belongs to another draft.');
              if (identity) setWorkspace(previous => sameSourceValue(previous, identity) ? previous : identity);
              connectionSucceeded();
              send({ type: 'inspect' });
            }
            return undefined;
          })
          .catch((error: unknown) => {
            if (syncOrder.current.active(generation)) connectionFailure(error);
          })
          .finally(() => {
            if (syncOrder.current.active(generation)) syncing.current = false;
          });
      }
    }
  });

  useEffect(() => {
    const timer = setInterval(() => pulse(), 3000);
    const wake = () => {
      if (!document.hidden) {
        retry.current = { failures: 0, after: 0 };
        pulse();
      }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, []);

  function choose(row: VariableRow) {
    const saved = forms.current.filter(form => form.row.path === row.path);
    if (saved.length > 1) {
      setSelected(undefined);
      setView('tokens');
      return;
    }
    if (saved[0]) {
      resumeForm(saved[0]);
      return;
    }
    setSelected(row);
    setEditProblem('');
    const current = local.get(row.path);
    setEditBefore(isLocalValue(current) ? current : undefined);
    setEditRevision(bundle?.revision ?? '');
    if (isRecord(current) && typeof current['alias'] === 'string') {
      setKind('alias');
      setValue(current['alias']);
    } else {
      setKind('value');
      setValue(row.type === 'COLOR' && isFigmaValue(current) ? hex(current) : displayValue(current));
    }
  }

  function applyTokenEdit() {
    if (!selected) return;
    setEditProblemAction('current');
    try {
      if (editRevision !== bundle?.revision || !sameSourceValue(selected, bundle.variables.find(row => row.path === selected.path))) {
        throw new Error('This token changed in source while open. Review its current value before applying.');
      }
      if (editBefore === undefined || !sameLocalValue(editBefore, nativeSnapshot.current.local.get(selected.path))) {
        throw new Error('This value changed in Figma while this form was open. Review its current value before applying.');
      }
      if (kind === 'value' && selected.type === 'COLOR' && isFigmaValue(editBefore) && typeof editBefore === 'object' && value.toLowerCase() === hex(editBefore).toLowerCase()) {
        discardForm(selected.path);
        setNotice('No value change.');
        setMessage('No value change.');
        return;
      }
      let next: FigmaValue = value;
      if (kind === 'value' && selected.type === 'EASING') next = parseEasingInput(value);
      if (kind === 'value' && selected.type === 'COLOR') next = parseColor(value);
      if (kind === 'value' && (selected.type === 'FLOAT' || selected.type === 'TIMING')) {
        next = Number(value);
        if (!value.trim() || !Number.isFinite(next)) throw new Error('Enter a finite number.');
        if (selected.type === 'TIMING' && next < 0) throw new Error('Duration cannot be negative.');
      }
      if (kind === 'value' && selected.type === 'BOOLEAN') {
        if (!['true', 'false'].includes(value)) throw new Error('Choose true or false.');
        next = value === 'true';
      }
      if (sameLocalValue(editBefore, kind === 'alias' ? { alias: value } : next)) {
        discardForm(selected.path);
        setNotice('No value change.');
        setMessage('No value change.');
        return;
      }
      setBusy(true);
      setExported(undefined);
      setEditProblem('');
      pendingEdit.current = selected.path;
      pendingForm.current = { path: selected.path, form: { row: selected, before: editBefore, revision: editRevision, kind, text: value }, result: kind === 'alias' ? { alias: value } : next };
      mutateNative({ type: 'edit', path: selected.path, expected: editBefore, revision: editRevision, ...(kind === 'alias' ? { alias: value } : { value: next }) });
      setMessage('Applying value in Figma…');
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      setEditProblem(problem);
      setMessage(problem);
    }
  }

  const hasAttention = Boolean(unitConflicts.length || recovery || nativeIssue || sourceReviewNeeded || serverReview || conflicts.length);
  const nativeAttention = unitConflicts.length ? 'Unit review' : recovery ? 'Recovery needed' : nativeIssue ? 'Needs attention' : '';

  const subtitle = workspace
    ? `${workspace.role === 'library' ? 'Library' : 'Concept'}${bundle ? ` · ${bundle.variables.length} tokens` : ''}`
    : bundle
      ? `${bundle.name} · ${bundle.variables.length} tokens`
      : fileContext.name || 'No file selected';

  const changesBadgeVariant = hasAttention ? 'small' as const : changed > 0 || formPaths.length > 0 ? 'labeled' as const : undefined;
  const changesBadgeText = changed > 0 ? changed : formPaths.length > 0 ? formPaths.length : undefined;

  return <div className="plugin-shell" data-component-assets="">
    <Snackbar open={!!notice} message={notice} duration={6000} onOpenChange={open => { if (!open) setNotice(''); }} />

    <AppBar
      className="plugin-appbar"
      title={workspace?.name ?? 'Foundry'}
      subtitle={subtitle}
      actions={<>
        <SyncStatus hasFigma={!!fileContext.id || !!bundle} hasSnapshot={!!bundle} connected={!!workspace && !!connection}
          offline={offline} busy={busy} changed={changed} forms={formPaths.length}
          nativeAttention={nativeAttention} sourceAttention={!!(sourceReviewNeeded || sourceConnection || serverReview || conflicts.length)} />
        <IconButton size="small" label="Refresh Figma" title="Refresh Figma" disabled={busy} onClick={() => send({ type: 'inspect' })}>
          <RefreshCw aria-hidden="true" />
        </IconButton>
      </>}
    />

    <div className="plugin-progress-slot">{busy && <Progress className="plugin-progress" label={message || 'Working'} />}</div>

    <main className="plugin-main">
      {(connectionProblem || alertMessage) && (
        <Alert variant="destructive">
          <AlertDescription>{connectionProblem || alertMessage}</AlertDescription>
        </Alert>
      )}
      <output className="sr-only" aria-live="polite">{message}</output>

      {view === 'tokens' && (
        <TokensView
          bundle={bundle}
          local={local}
          workspace={workspace}
          fileContext={fileContext}
          modifiedPaths={modifiedPaths}
          forms={forms.current}
          formPaths={formPaths}
          formAlternatives={formAlternatives}
          formsReady={formsReady}
          formStatus={formStatus}
          formError={formError}
          selected={selected}
          value={value}
          kind={kind}
          editProblem={editProblem}
          editProblemAction={editProblemAction}
          busy={busy}
          query={query}
          filters={filters}
          page={page}
          onQueryChange={setQuery}
          onToggleFilter={key => {
            setFilters(current => (current.includes(key) ? current.filter(item => item !== key) : [...current, key]));
            setPage(0);
          }}
          onPageChange={setPage}
          onSelectRow={choose}
          onBackToList={() => { setSelected(undefined); setEditProblem(''); }}
          onRevertToken={row => revertTokenByPath(row.path)}
          onRefreshSelection={() => send({ type: 'inspect' })}
          onRetainForm={retainForm}
          onApplyEdit={applyTokenEdit}
          onReviewBaseline={reviewFormBaseline}
          onDiscardForm={discardForm}
          onRetrySaveForms={() => { persistForms(forms.current); }}
          onDownloadForms={downloadForms}
          onResolveFormAlternative={form => {
            persistForms([form, ...forms.current.filter(previous => previous.row.path !== form.row.path)]);
            resumeForm(form);
          }}
          onOpenWorkspace={openFoundryWorkspace}
          onGoToConnect={() => setView('workspace')}
        />
      )}

      {view === 'changes' && (
        <ChangesView
          bundle={bundle}
          workspace={workspace}
          connected={!!connection}
          busy={busy}
          offline={offline}
          recovery={recovery}
          nativeIssue={nativeIssue}
          changed={changed}
          localChanges={localChanges}
          sourceReviewNeeded={sourceReviewNeeded}
          sourceConnection={sourceConnection}
          serverReview={serverReview}
          pullReview={pullReview}
          conflicts={conflicts}
          pullDrafts={pullDrafts}
          reviewNative={reviewNative}
          unitConflicts={unitConflicts}
          formPaths={formPaths}
          exported={exported}
          onOpenWorkspace={openFoundryWorkspace}
          onDownloadChanges={() => { setBusy(true); requestProposal('download'); }}
          onResumePull={() => { setBusy(true); mutateNative({ type: 'resume-pull' }); }}
          onResolveNativeUnit={(path, expectedNative, nextValue) => {
            setBusy(true);
            mutateNative({ type: 'resolve-native-unit', path, expectedNative, value: nextValue });
          }}
          onConfirmSourceConnection={() => {
            if (!sourceConnection) return;
            setBusy(true);
            void acceptRemote(sourceConnection.data, sourceConnection.target, sourceConnection.generation, true)
              .catch((error: unknown) => {
                if (error instanceof ObsoleteSync) return;
                connectionFailure(error);
                setBusy(false);
              });
          }}
          onCancelSourceConnection={() => {
            invalidateSync();
            setConnection(undefined);
            setMessage('Kept current source snapshot.');
          }}
          onReviewSourceUpdates={() => {
            if (!connection) return;
            const target = connection;
            const generation = syncOrder.current.begin();
            setBusy(true);
            void request(target, 'GET', undefined, generation)
              .then(data => acceptRemote(data, target, generation, true, true))
              .catch((error: unknown) => {
                if (!syncOrder.current.active(generation) || error instanceof ObsoleteSync) return;
                connectionFailure(error);
                setBusy(false);
                syncing.current = false;
              });
          }}
          onServerDraftsChange={drafts => {
            if (!serverReview) return;
            retainConflictInput(drafts, 'server');
            setServerReview(previous => previous && sameSourceValue(previous.proposal, serverReview.proposal) ? { ...previous, drafts } : previous);
            const target = connection;
            const generation = syncOrder.current.current();
            if (target) {
              reviewWrites.current = reviewWrites.current
                .then(async () => {
                  await request(target, 'POST', { action: 'review', revision: serverReview.current.revision, drafts }, generation);
                  return undefined;
                })
                .catch((error: unknown) => {
                  if (syncOrder.current.active(generation) && !(error instanceof ObsoleteSync)) setMessage(error instanceof Error ? error.message : String(error));
                });
            }
          }}
          onApplyServerChoices={choices => {
            if (!connection || !serverReview) return;
            prepareConflictApplication('server', choices);
            setBusy(true);
            syncing.current = true;
            const target = connection;
            const generation = syncOrder.current.current();
            void reviewWrites.current
              .then(() => request(target, 'POST', { proposal: serverReview.proposal, choices, revision: serverReview.current.revision }, generation))
              .then(async result => {
                if (isRecord(result) && result['accepted'] === false) throw new Error('The workspace changed. Refresh its current values before applying choices.');
                await acceptRemote(result, target, generation);
                return undefined;
              })
              .catch((error: unknown) => {
                if (!syncOrder.current.active(generation) || error instanceof ObsoleteSync) return;
                conflictApplication.current = undefined;
                setMessage(error instanceof Error ? error.message : String(error));
                setBusy(false);
                syncing.current = false;
              });
          }}
          onCancelServerReview={() => setView('tokens')}
          onResumeEarlierInput={earlierConflictInput}
          onPullDraftsChange={drafts => {
            setPullDrafts(drafts);
            retainConflictInput(drafts, 'pull');
          }}
          onApplyPullChoices={choices => {
            if (!pullReview) return;
            try {
              const desired = pullReview.desired
                ? new Map(pullReview.desired)
                : pullValues(bundle, pullReview.incoming, pullReview.local, choices);
              if (pullReview.desired) {
                for (const choice of choices) {
                  if (choice.value === null) throw new Error(`A value is required for ${choice.path}.`);
                  desired.set(choice.path, choice.value);
                }
              }
              pullValues(pullReview.incoming, pullReview.incoming, desired);
              const proposal = changedValues(pullReview.incoming, desired);
              if (proposal.changes.length) {
                const checked = proposalReview(openWorkspace(pullReview.incoming.name, pullReview.incoming.files), pullReview.incoming, proposal);
                if (checked.validationErrors?.length) throw new Error(checked.validationErrors.join('\n'));
              }
              prepareConflictApplication('pull', choices, pullReview.incoming.revision);
              setBusy(true);
              mutateNative({ type: 'resolve-pull', id: pullReview.id, choices });
            } catch (cause) {
              setMessage(cause instanceof Error ? cause.message : String(cause));
            }
          }}
          onCancelPullReview={() => mutateNative({ type: 'cancel-pull' })}
          onReviewUnfinishedEdits={() => {
            const first = forms.current[0];
            setView('tokens');
            if (first && forms.current.filter(form => form.row.path === first.row.path).length === 1) resumeForm(first);
            else setSelected(undefined);
          }}
          onOpenToken={path => {
            const row = bundle?.variables.find(candidate => candidate.path === path);
            if (!row) return;
            setView('tokens');
            choose(row);
          }}
          onRevertToken={revertTokenByPath}
        />
      )}

      {view === 'workspace' && (
        <ConnectionView
          fileContext={fileContext}
          workspace={workspace}
          connected={!!connection}
          savedConnection={savedConnection}
          connectionText={connectionText}
          pairing={!!pairing}
          foundryOrigin={foundryOrigin}
          onFoundryOriginChange={setFoundryOrigin}
          busy={busy}
          nativeBusy={!!nativeOperation.current}
          recovery={recovery}
          unitConflictCount={unitConflicts.length}
          savedConcept={savedConcept}
          formsReady={formsReady}
          formCount={formPaths.length}
          hasBundle={!!bundle}
          library={library}
          libraryCompatible={libraryCompatible}
          nativeIssue={nativeIssue}
          onStartPairing={() => {
            invalidateSync();
            const pair = { id: randomToken(), secret: randomToken(), started: Date.now() };
            setPairing(pair);
            const cleanOrigin = cleanFoundryOrigin();
            send({
              type: 'open-foundry',
              connection: `${cleanOrigin}/#pair=${pair.id}&secret=${pair.secret}&document=${encodeURIComponent(fileContext.id)}&name=${encodeURIComponent(fileContext.name)}`,
            });
          }}
          onCancelPairing={invalidateSync}
          onConnectionCodeChange={nextCode => {
            invalidateSync();
            setConnectionText(nextCode);
            setSavedConnection('');
            setConnection(undefined);
            setWorkspace(undefined);
          }}
          onPullRemote={() => { void pullRemote(); }}
          onForgetConnection={() => {
            invalidateSync();
            setBusy(true);
            send({ type: 'forget-connection' });
          }}
          onOpenSnapshot={() => upload.current?.click()}
          onOpenTokenForms={() => formUpload.current?.click()}
          onDownloadForms={downloadForms}
          onOpenWorkspace={openFoundryWorkspace}
          onBuildLibrary={() => {
            setNotice('');
            setBusy(true);
            setMessage(`Syncing ${library} foundations…`);
            mutateNative({ type: 'build-library' });
          }}
        />
      )}

      <input
        ref={formUpload}
        type="file"
        hidden
        accept=".json"
        aria-label="Token edit copy"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importForms(file);
        }}
      />
      <input
        ref={upload}
        hidden
        type="file"
        accept=".json"
        aria-label="Foundry snapshot"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          if (savedConcept || workspace?.role === 'concept') {
            setMessage('Concept files use shared library tokens. Edit tokens in the library file.');
            return;
          }
          if (nativeOperation.current) {
            setMessage('Finish the current update before opening another snapshot.');
            return;
          }
          const generation = syncOrder.current.begin();
          proposalIntent.current = undefined;
          setBusy(true);
          setMessage('Reading source snapshot…');
          void file.text()
            .then(readBundle)
            .then(next => {
              syncOrder.current.assert(generation);
              setMessage('Importing snapshot into Figma…');
              mutateNative({ type: 'pull', bundle: next });
              return undefined;
            })
            .catch((error: unknown) => {
              if (!syncOrder.current.active(generation) || error instanceof ObsoleteSync) return;
              setMessage(error instanceof Error ? error.message : String(error));
              setBusy(false);
            });
        }}
      />
    </main>

    <NavigationBar label="Plugin views" className="plugin-nav" variant="vertical">
      <NavigationItem
        label="Tokens"
        icon={<Layers />}
        aria-current={view === 'tokens' ? 'page' : undefined}
        onClick={() => setView('tokens')}
      />
      <NavigationItem
        label="Changes"
        icon={<GitCompareArrows />}
        {...(changesBadgeVariant ? { badge: changesBadgeVariant } : {})}
        {...(changesBadgeText !== undefined ? { badgeText: changesBadgeText } : {})}
        aria-current={view === 'changes' ? 'page' : undefined}
        onClick={() => setView('changes')}
      />
      <NavigationItem
        label="Workspace"
        icon={<DesktopCloud />}
        {...(!connection && pairing ? { badge: 'small' as const } : {})}
        aria-current={view === 'workspace' ? 'page' : undefined}
        onClick={() => setView('workspace')}
      />
    </NavigationBar>
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('The plugin UI root is missing.');
createRoot(root).render(<App />);
