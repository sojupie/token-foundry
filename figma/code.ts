import { isBundle, isFigmaValue, matchesVariableType, sameSourceValue, sameLocalValue } from '../integrations/figma/contract.ts';
import { isFigmaEasing, isCubicEasing, sourceEasing, roundedEasing, easingPoints } from '../integrations/figma/easing.ts';
import type { FigmaBundle, FigmaValue, VariableRow } from '../integrations/figma/contract.ts';
import { acknowledgedPull, changedValues, importedValue, isAcknowledgement, isLocalValue, isPullChoice, pullConflicts, pullValues } from '../integrations/figma/merge.ts';
import type { FigmaAcknowledgement, LocalValue, PullChoice } from '../integrations/figma/merge.ts';
import { isRecord, isUnknownArray } from '../lib/json.ts';
import { libraryAdapter } from './library-adapter.ts';
import { readStored, writeStored } from './storage.ts';
import { nativeScale, nativeUnitConflict, resolveNativeUnit, sourceDuration, sourceNumeric, sourceNumber, writeNative } from './native-values.ts';
import { forgetConnection, rememberConnection, restoreConnection } from './connection.ts';
import { isTokenFormEntries, restoreTokenForms, saveTokenForms } from './forms.ts';
import type { TokenForm } from './forms.ts';
import { identifySubmission, isOlderReceipt } from '../integrations/figma/submission.ts';
import { observeSubmission } from './submission-state.ts';
import { isAllowedFoundryOrigin } from '../integrations/figma/transport.ts';
import { isCuratedFigmaVariable, variableScopes } from '../integrations/figma/scopes.ts';

const owner = 'foundry-token-path';
const initialOwner = 'foundry-import-initial';
const collectionOwner = 'foundry-collection';
const mappingVersion = '4:' + (libraryAdapter?.name ?? 'generic');
let bundle: FigmaBundle | undefined;
const sourceScales = new WeakMap<FigmaBundle, ReadonlyMap<string, number>>();
function numberScale(path: string, source = bundle) {
  if (!source) return libraryAdapter?.numberScale?.(path) ?? 1;
  let scales = sourceScales.get(source);
  if (!scales) { scales = new Map(source.variables.map(row => [row.path, row.type === 'TIMING' ? row.unit === 'ms' ? 0.001 : 1 : row.type === 'EASING' ? 1 : libraryAdapter?.numberScale?.(row.path) ?? 1])); sourceScales.set(source, scales); }
  return scales.get(path) ?? 1;
}
function assertNativeRoundTrip(row: VariableRow, value: LocalValue, source: FigmaBundle) {
  const scale = numberScale(row.path, source);
  if (typeof value === 'number' && sourceNumeric(Math.fround(value * scale), scale, row) !== value) {
    throw Object.assign(new Error('This ' + (row.type === 'TIMING' ? 'timing' : 'numeric') + ' value does not round-trip through the native mapping. Your exact input is retained. Use Foundry to edit the source value.'), { code: row.type === 'TIMING' ? 'timing-precision' : 'number-precision' });
  }
  if (row.type === 'EASING' && isCubicEasing(value) && !sameLocalValue(sourceEasing(roundedEasing(value), isFigmaEasing(row.value) ? row.value : undefined), value)) {
    throw Object.assign(new Error('These control points do not round-trip through the native mapping. Your exact input is retained. Use Foundry to edit the source value.'), { code: 'easing-precision' });
  }
}
let queue = Promise.resolve();
let currentRequest: { type: string; serial?: number; client?: string } | undefined;
function post(message: unknown, options?: { origin: string }) {
  figma.ui.postMessage(isRecord(message) && currentRequest ? { ...message, request: currentRequest.type,
    ...(currentRequest.serial === undefined ? {} : { serial: currentRequest.serial }), ...(currentRequest.client ? { client: currentRequest.client } : {}) } : message, options);
}
const connectionAPI = { fileKey: figma.fileKey, root: figma.root, variables: figma.variables, clientStorage: figma.clientStorage, ui: { postMessage: post } };
let pendingPull: { id: string; next: FigmaBundle; local: ReadonlyMap<string, LocalValue>; receipt?: FigmaAcknowledgement; journal?: PullJournal } | undefined;
let pullId = 0;
let lastReceipt = '';
let snapshotHead = '';
let workspaceId = '';
let conceptFile = false;
let snapshotWorkspace = '';
let intentId = '';
let intentSequence = 0;
let consumedHere = false;
let startupError = '';
interface SavedSnapshot { bundle: FigmaBundle; receipt: string; workspace?: string }
const isSavedSnapshot = (value: unknown): value is SavedSnapshot => isRecord(value) && isBundle(value['bundle']) && typeof value['receipt'] === 'string' && (value['workspace'] === undefined || typeof value['workspace'] === 'string');
type StoredValues = { path: string; value: LocalValue }[];
interface PullJournal { next: FigmaBundle; beforeRevision: string; local: StoredValues; desired: StoredValues; receipt?: FigmaAcknowledgement }
const isStoredValues = (value: unknown): value is StoredValues => isUnknownArray(value) && value.every(row => isRecord(row) && typeof row['path'] === 'string' && isLocalValue(row['value']));
const isPullJournal = (value: unknown): value is PullJournal => isRecord(value) && isBundle(value['next']) && typeof value['beforeRevision'] === 'string' &&
  isStoredValues(value['local']) && isStoredValues(value['desired']) && (value['receipt'] === undefined || isAcknowledgement(value['receipt']));
const readJournal = () => readStored(figma.root, 'foundry-operation-head', isPullJournal);
const storedValues = (values: ReadonlyMap<string, LocalValue>): StoredValues => [...values].map(([path, value]) => ({ path, value }));

function readBundle(): FigmaBundle | undefined {
  snapshotHead = figma.root.getPluginData('foundry-snapshot-head');
  const saved = readStored(figma.root, 'foundry-snapshot-head', isSavedSnapshot);
  if (saved) { lastReceipt = saved.receipt; snapshotWorkspace = saved.workspace ?? ''; return saved.bundle; }
  const count = Number(figma.root.getPluginData('foundry-snapshot-count'));
  if (!count) return undefined;
  const value: unknown = JSON.parse(Array.from({ length: count }, (_, index) => figma.root.getPluginData('foundry-snapshot-' + index)).join(''));
  if (!isBundle(value)) throw new Error('The saved source snapshot is invalid.');
  return value;
}

function saveBundle(next: FigmaBundle, receipt = lastReceipt) {
  writeStored(figma.root, 'foundry-snapshot-head', { bundle: next, receipt, ...(workspaceId ? { workspace: workspaceId } : {}) });
  snapshotHead = figma.root.getPluginData('foundry-snapshot-head');
  lastReceipt = receipt;
  snapshotWorkspace = workspaceId;
  bundle = next;
}

function refreshSnapshot() {
  if (snapshotHead === figma.root.getPluginData('foundry-snapshot-head') || readJournal() || figma.root.getPluginData('foundry-operation')) return;
  bundle = readBundle(); pendingPull = undefined;
}

function activateWorkspace(next: string) {
  if (next && (workspaceId && next !== workspaceId || !workspaceId && snapshotWorkspace && next !== snapshotWorkspace)) { lastReceipt = ''; consumedHere = false; }
  workspaceId = next;
}

async function managed() {
  const allCollections = await figma.variables.getLocalVariableCollectionsAsync();
  const collections = allCollections.filter(c => c.getPluginData(collectionOwner) === '1');
  if (collections.length > 1) throw new Error('More than one Foundry collection exists. Restore the original library file.');
  const collection = collections[0];
  const all = await figma.variables.getLocalVariablesAsync();
  const variables = all.filter(v => v.getPluginData(owner));
  const rows = new Map<string, Variable>();
  for (const variable of variables) {
    const path = variable.getPluginData(owner);
    if (rows.has(path) || variable.variableCollectionId !== collection?.id) throw new Error('Duplicate or moved managed variable: ' + path);
    rows.set(path, variable);
  }
  return { collection, rows, all };
}

function localValues(rows: ReadonlyMap<string, Variable>, mode: string, motionSource?: FigmaBundle): Map<string, LocalValue> {
  const paths = new Map([...rows].map(([path, variable]) => [variable.id, path]));
  const source = new Map(readJournal()?.next.variables.map(row => [row.path, row]) ?? []);
  for (const row of bundle?.variables ?? []) source.set(row.path, row);
  for (const row of motionSource?.variables ?? []) if (row.type === 'TIMING' || row.type === 'EASING') source.set(row.path, row);
  const values = new Map<string, LocalValue>();
  for (const [path, variable] of rows) {
    const value = variable.valuesByMode[mode];
    if (value === undefined) continue;
    if (typeof value === 'object' && 'type' in value && value.type === 'VARIABLE_ALIAS') {
      const target = paths.get(value.id);
      if (!target) throw new Error('The alias for ' + path + ' points outside the source snapshot.');
      values.set(path, { alias: target });
    } else if (typeof value === 'number') values.set(path, sourceNumber(variable, mode, source.get(path)) ?? value);
    else if (typeof value === 'object' && 'r' in value) values.set(path, { ...value, a: 'a' in value ? value.a : 1 });
    else if (isFigmaEasing(value)) { const original = source.get(path)?.value; values.set(path, sourceEasing(value, isFigmaEasing(original) ? original : undefined)); }
    else if (typeof value !== 'object') values.set(path, value);
    else throw new Error('The variable uses a value Figma cannot round-trip: ' + path);
  }
  return values;
}

function createdBaseline(variable: Variable | undefined, revision: string): LocalValue | undefined {
  const text = variable?.getPluginData(initialOwner);
  if (!text) return undefined;
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || typeof value['revision'] !== 'string' || !isLocalValue(value['value'])) throw new Error('The saved initial variable value is damaged. Restore the matching file version before resuming.');
  return value['revision'] === revision ? value['value'] : undefined;
}

function scopes(row: VariableRow): VariableScope[] {
  return variableScopes(row);
}

async function pull(next: FigmaBundle, choices?: readonly PullChoice[], expectedLocal?: ReadonlyMap<string, LocalValue>, acknowledgement?: FigmaAcknowledgement, journal?: PullJournal) {
  if (startupError) throw new Error(startupError);
  if (readJournal() && !journal) throw new Error('Resume the interrupted pull before importing another snapshot.');
  post({ type: 'progress', message: 'Reading existing Figma variables…' }, { origin: '*' });
  if (next.format !== 'token-foundry/figma' || next.version !== 1 || !/^[a-f0-9]{64}$/u.test(next.revision)) throw new Error('Invalid Foundry snapshot.');
  const { collection: existing, rows, all } = await managed();
  post({ type: 'progress', message: 'Checking ' + next.variables.length + ' source mappings…' }, { origin: '*' });
  if (existing && existing.modes.length !== 1) throw new Error('The source has one context, but Figma has additional modes. Map them explicitly before syncing.');
  const local = existing ? localValues(rows, existing.defaultModeId, journal ? next : undefined) : new Map<string, LocalValue>();
  if (expectedLocal && (expectedLocal.size !== local.size || [...expectedLocal].some(([path, value]) => !sameLocalValue(value, local.get(path))))) throw new Error('Figma values changed while you reviewed the conflicts. Pull again to review the current values.');
  if (bundle) for (const row of bundle.variables) if (!rows.has(row.path)) throw new Error('A source variable was deleted in Figma: ' + row.path + '. Restore it before pulling.');
  // Undo can restore an older document baseline after this device consumed its
  // receipt. Rebase that history entry only while the offered source still
  // contains the acknowledged values; a later source reversion is new intent.
  const incomingValues = new Map(next.variables.map(row => [row.path, importedValue(row)]));
  const usableAcknowledgement = acknowledgement && !isOlderReceipt(acknowledgement.id, lastReceipt) ? acknowledgement : undefined;
  const restoredHistory = usableAcknowledgement && bundle?.revision === usableAcknowledgement.sourceRevision &&
    usableAcknowledgement.values.every(item => sameLocalValue(incomingValues.get(item.path), item.value));
  const receipt = usableAcknowledgement?.id !== lastReceipt || restoredHistory ? usableAcknowledgement : undefined;
  const acknowledged = acknowledgedPull(bundle, next, local, receipt);
  const effective = acknowledged.local;
  let conflicts = pullConflicts(acknowledged.previous, next, effective);
  const planned = journal ? new Map(journal.desired.map(row => [row.path, row.value])) : undefined;
  if (journal) {
    if (bundle && bundle.revision !== journal.beforeRevision && bundle.revision !== journal.next.revision) throw new Error('The saved baseline changed after this pull began. Restore the matching file version before resuming.');
    const before = new Map(journal.local.map(row => [row.path, row.value]));
    const savedRows = new Map(journal.next.variables.map(row => [row.path, row]));
    const previousRows = new Map(bundle?.variables.map(row => [row.path, row]));
    conflicts = journal.desired.flatMap(row => {
      const current = local.get(row.path);
      // Earlier initial TIMING imports did not record the native zero default.
      // A changed value still conflicts; zero is the observed initial API value.
      const initial = before.get(row.path) ?? createdBaseline(rows.get(row.path), journal.next.revision) ??
        (!bundle?.variables.some(token => token.path === row.path) && savedRows.get(row.path)?.type === 'TIMING' ? 0 : undefined);
      const previousRow = previousRows.get(row.path); const nextRow = savedRows.get(row.path);
      const comparable = typeof initial === 'number' && previousRow?.type === 'TIMING' && nextRow?.type === 'TIMING'
        ? sourceDuration(initial * (previousRow.unit === 'ms' ? 0.001 : 1), nextRow) : initial;
      if (current === undefined || sameLocalValue(current, row.value) || sameLocalValue(current, comparable)) return [];
      return [{ path: row.path, before: initial ?? row.value, local: current, remote: row.value,
        ...(nextRow?.type === 'TIMING' ? { beforeUnit: previousRow?.unit ?? nextRow.unit, remoteUnit: nextRow.unit } : {}) }];
    });
  }
  if (conflicts.length && choices === undefined) {
    pendingPull = { id: String(++pullId), next, local, ...(receipt ? { receipt } : {}), ...(journal ? { journal } : {}) };
    post({ type: 'conflicts', id: pendingPull.id, conflicts, incoming: next, local: storedValues(effective), ...(planned ? { desired: storedValues(planned) } : {}) }, { origin: '*' });
    return;
  }
  const desired = planned ?? pullValues(acknowledged.previous, next, effective, choices);
  if (planned && choices) {
    const selected = new Map(choices.map(choice => [choice.path, choice.value]));
    if (selected.size !== choices.length || selected.size !== conflicts.length || conflicts.some(conflict => !selected.has(conflict.path))) throw new Error('Choose a value for every recovery conflict.');
    for (const [path, value] of selected) {
      if (value === null) throw new Error('A recovery value is required for ' + path + '.');
      desired.set(path, value);
    }
  }
  // Validate the full planned graph, including aliases and source editability.
  changedValues(next, desired);
  pullValues(next, next, desired);
  const incoming = new Map(next.variables.map(row => [row.path, row]));
  for (const [path, value] of desired) if (typeof value === 'number' && !Number.isFinite(Math.fround(value * numberScale(path, next)))) {
    throw new Error('The value for ' + path + ' exceeds the current native number range. Its source is retained; choose a representable value before importing.');
  }
  for (const [path, value] of desired) if (isCubicEasing(value) && easingPoints(value).some(point => !Number.isFinite(Math.fround(point)))) throw new Error('The cubic Bézier control points exceed the current native number range: ' + path + '.');
  // Incoming authored values retain precision in the new source snapshot.
  // Retained native/custom choices must survive projection against that snapshot
  // before a journal, Undo checkpoint or native value can be written.
  for (const [path, value] of desired) {
    const row = incoming.get(path);
    if (row && !sameLocalValue(value, importedValue(row))) assertNativeRoundTrip(row, value, next);
  }
  for (const [path, value] of desired) if (typeof value === 'object' && 'alias' in value && incoming.get(path)?.type === 'FLOAT' && numberScale(path, next) !== numberScale(value.alias, next)) throw new Error('This alias crosses incompatible native number units: ' + path + '. Map its uses explicitly before importing.');
  const metadataCurrent = existing?.getPluginData('foundry-mapping-version') === mappingVersion;
  const persisted = readStored(figma.root, 'foundry-snapshot-head', isSavedSnapshot);
  const persistedTarget = persisted?.bundle.revision === next.revision && sameSourceValue(persisted.bundle.files, next.files) &&
    (!receipt || receipt.sourceRevision !== next.revision || persisted.receipt === receipt.id);
  const resumedReversion = persisted && receipt && next.revision !== receipt.sourceRevision && persisted.bundle.revision === bundle?.revision && persisted.bundle.revision === receipt.sourceRevision &&
    sameSourceValue(persisted.bundle.files, bundle.files) && persisted.bundle.variables.length === next.variables.length &&
    persisted.bundle.variables.every(row => sameLocalValue(importedValue(row), desired.get(row.path)));
  if (existing && existing.name === next.name + ' · Tokens' && metadataCurrent && (persistedTarget || resumedReversion) &&
    !journal && !figma.root.getPluginData('foundry-operation') && [...desired].every(([path, value]) => sameLocalValue(local.get(path), value))) {
    // Native Undo/Redo also restores document metadata. When it already restored
    // this source and the desired values, acknowledge in memory without another
    // document write: a redundant metadata write would clear native Redo. After
    // restart, an acknowledged edit already undone locally can likewise advance
    // in memory until that reversion is saved. Its receipt retains the old source.
    bundle = next; lastReceipt = receipt?.id ?? lastReceipt; consumedHere = !!receipt; pendingPull = undefined;
    snapshotHead = figma.root.getPluginData('foundry-snapshot-head');
    await inspect();
    post({ type: 'pulled', revision: next.revision, count: next.variables.length, unchanged: true }, { origin: '*' });
    return;
  }
  if (existing && metadataCurrent && bundle?.revision === next.revision && !journal && !figma.root.getPluginData('foundry-operation') && effective === local && [...desired].every(([path, value]) => sameLocalValue(local.get(path), value))) {
    if (existing.name !== next.name + ' · Tokens') existing.name = next.name + ' · Tokens';
    await inspect();
    post({ type: 'pulled', revision: next.revision, count: next.variables.length, unchanged: true }, { origin: '*' });
    return;
  }
  const allNames = new Map(all.map(variable => [variable.name, variable.id]));
  for (const row of next.variables) {
    const previous = rows.get(row.path);
    if (previous && previous.resolvedType !== row.type) throw new Error('Variable type changed: ' + row.path + '. Migrate this binding explicitly.');
    const namedId = allNames.get(row.name);
    if (namedId && namedId !== previous?.id) throw new Error('A variable already uses the source name: ' + row.name);
  }
  writeStored(figma.root, 'foundry-operation-head', { next, beforeRevision: bundle?.revision ?? '', local: storedValues(local), desired: storedValues(desired), ...(receipt ? { receipt } : {}) });
  const collection = existing ?? figma.variables.createVariableCollection(next.name + ' · Tokens');
  collection.setPluginData(collectionOwner, '1');
  collection.name = next.name + ' · Tokens';
  const mode = collection.defaultModeId;
  if (!existing) collection.renameMode(mode, 'Source');
  const previous = new Map(bundle?.variables.map(row => [row.path, row]) ?? []);
  const createBatch = async (batch: VariableRow[], offset: number) => {
  for (const row of batch) {
    const previousVariable = rows.get(row.path);
    const variable = previousVariable ?? figma.variables.createVariable(row.name, collection, row.type);
    const expectedDescription = row.description + '\nSource: ' + row.file + ' · ' + row.path;
    if (metadataCurrent && sameSourceValue(previous.get(row.path), row) && variable.name === row.name && variable.description === expectedDescription) continue;
    variable.setPluginData(owner, row.path);
    if (!previousVariable) {
      const raw = variable.valuesByMode[mode];
      const initial = typeof raw === 'object' && 'r' in raw ? { ...raw, a: 'a' in raw ? raw.a : 1 } : raw;
      if (isFigmaValue(initial)) variable.setPluginData(initialOwner, JSON.stringify({ revision: next.revision, value: initial }));
    }
    variable.name = row.name;
    variable.description = expectedDescription;
    // Motion variables reject the scopes setter, including an empty array.
    if (row.type !== 'TIMING' && row.type !== 'EASING') variable.scopes = scopes(row);
    variable.hiddenFromPublishing = !isCuratedFigmaVariable(row.path);
    rows.set(row.path, variable);
  }
  post({ type: 'progress', message: 'Preparing variables: ' + Math.min(offset + batch.length, next.variables.length) + ' / ' + next.variables.length }, { origin: '*' });
  await new Promise<void>(resolve => { setTimeout(resolve, 0); });
  };
  const batches = Array.from({ length: Math.ceil(next.variables.length / 100) }, (_, index) => ({ rows: next.variables.slice(index * 100, index * 100 + 100), offset: index * 100 }));
  await batches.reduce(async (previousBatch, batch) => { await previousBatch; await createBatch(batch.rows, batch.offset); }, Promise.resolve());
  const current = localValues(rows, mode, journal ? next : undefined);
  if ([...local].some(([path, value]) => !sameLocalValue(current.get(path), value))) throw new Error('Figma values changed during the pull. Pull again to review the current values.');
  for (const row of next.variables) {
    const variable = rows.get(row.path);
    if (!variable) throw new Error('Variable missing: ' + row.path);
    const value = desired.get(row.path);
    if (value === undefined) throw new Error('The pull value is missing: ' + row.path);
    if (!sameLocalValue(current.get(row.path), value) || nativeScale(variable, mode) !== numberScale(row.path, next) || variable.getPluginData('foundry-value-scale-pending')) {
      const alias = typeof value === 'object' && 'alias' in value ? value.alias : undefined;
      const target = alias ? rows.get(alias) : undefined;
      if (alias && !target) throw new Error('Alias target missing: ' + alias);
      if (target) writeNative(variable, mode, figma.variables.createVariableAlias(target), numberScale(row.path, next));
      else if (isFigmaValue(value)) writeNative(variable, mode, value, numberScale(row.path, next));
      else throw new Error('The pull alias is missing: ' + row.path);
    }
    variable.hiddenFromPublishing = !isCuratedFigmaVariable(row.path);
    if (variable.getPluginData(initialOwner)) variable.setPluginData(initialOwner, '');
  }
  for (const [path, variable] of rows) {
    if (incoming.has(path)) continue;
    variable.description = 'Removed from source. Kept to preserve existing component bindings.\n' + variable.description;
    variable.hiddenFromPublishing = true;
  }
  collection.setPluginData('foundry-mapping-version', mappingVersion);
  saveBundle(next, receipt?.id);
  consumedHere = !!receipt;
  figma.root.setPluginData('foundry-operation-head', '');
  figma.root.setPluginData('foundry-operation', '');
  pendingPull = undefined;
  figma.commitUndo();
  await inspect();
  post({ type: 'pulled', revision: next.revision, count: next.variables.length }, { origin: '*' });
}

async function inspect() {
  refreshSnapshot();
  let document = figma.root.getPluginData('foundry-document-identity') || figma.fileKey;
  if (!document) { document = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); figma.root.setPluginData('foundry-document-identity', document); }
  const selection = figma.currentPage?.selection ?? [];
  const selected = await Promise.all(selection.map(async node => {
    const bindings = 'boundVariables' in node && node.boundVariables ? Object.entries(node.boundVariables) : [];
    const tokens = await Promise.all(bindings.flatMap(([field, values]) => (Array.isArray(values) ? values : [values]).flatMap((value: unknown) =>
      isRecord(value) && value['type'] === 'VARIABLE_ALIAS' && typeof value['id'] === 'string' ? [{ field, id: value['id'] }] : [])).map(async binding => {
      const variable = await figma.variables.getVariableByIdAsync(binding.id);
      return { field: binding.field, path: variable?.getPluginData(owner) || variable?.name || 'Unavailable variable', remote: variable?.remote ?? false };
    }));
    return { id: node.id, name: node.name, type: node.type, tokens };
  }));
  post({ type: 'document', document, fileKey: figma.fileKey ?? '', name: figma.root.name || 'Figma file', selection: selected }, { origin: '*' });
  const { collection, rows } = await managed();
  const sourceRows = new Map(bundle?.variables.map(row => [row.path, row]) ?? []);
  const unitConflicts = collection ? [...rows].flatMap(([path, variable]) => {
    const conflict = nativeUnitConflict(variable, collection.defaultModeId, sourceRows.get(path));
    return conflict ? [{ path, ...conflict }] : [];
  }) : [];
  const local = collection && !unitConflicts.length ? localValues(rows, collection.defaultModeId) : new Map<string, LocalValue>();
  let changed = 0;
  let issue = startupError || (collection && collection.modes.length !== 1 ? 'Additional Figma modes require an explicit source mapping. Changes cannot be sent until those modes are mapped.' : '');
  try { changed = bundle ? changedValues(bundle, local).changes.length : 0; }
  catch (error) { issue = error instanceof Error ? error.message : String(error); }
  if (bundle && !issue && !unitConflicts.length) {
    try {
      const observed = await observeSubmission(figma, bundle.revision, local, workspaceId, lastReceipt, consumedHere || !!workspaceId && snapshotWorkspace === workspaceId);
      intentId = observed.intentId; intentSequence = observed.intentSequence; lastReceipt = observed.receipt; consumedHere = false;
    } catch (error) { issue = error instanceof Error ? error.message : 'Native submission recovery could not be saved on this device.'; }
  }
  if (unitConflicts.length) issue = 'A value changed during native unit conversion. Choose its units before resuming the pull.';
  post({ type: 'state', bundle, changed, acknowledgedReceipt: lastReceipt, intentId, intentSequence,
    local: [...local].map(([path, value]) => ({ path, value })), collectionId: collection?.id,
    recovery: !!readJournal() || figma.root.getPluginData('foundry-operation') !== '', unitConflicts, ...(issue ? { issue } : {}) }, { origin: '*' });
  const sourcePaths = new Set(bundle?.variables.map(row => row.path));
  post({ type: 'library-available', name: libraryAdapter?.name ?? '', compatible: !!bundle && !!libraryAdapter && (libraryAdapter.required ?? []).every(path => sourcePaths.has(path)) }, { origin: '*' });
}

async function handle(message: { type?: string; bundle?: FigmaBundle; path?: string; value?: FigmaValue; expected?: LocalValue; revision?: string; expectedNative?: number; alias?: string; id?: string; origin?: string; choices?: PullChoice[]; acknowledgement?: FigmaAcknowledgement; connection?: string; name?: string; expires?: number; concept?: boolean; forms?: TokenForm[]; serial?: number }) {
  if (message.type === 'pull' && !message.bundle) throw new Error('The source snapshot message is incomplete.');
  if (message.type === 'restore-token-forms' || message.type === 'save-token-forms') {
    try {
      if (message.type === 'restore-token-forms') post({ type: 'saved-token-forms', forms: await restoreTokenForms(figma) }, { origin: '*' });
      else {
        if (!message.forms || message.serial === undefined) throw new Error('The token forms message is incomplete.');
        await saveTokenForms(figma, message.forms); post({ type: 'token-forms-saved', serial: message.serial }, { origin: '*' });
      }
    } catch (error) { post({ type: 'token-forms-error', message: error instanceof Error ? error.message : 'The token forms could not be saved on this device.', ...(message.type === 'save-token-forms' && message.serial !== undefined ? { serial: message.serial } : {}) }, { origin: '*' }); }
    if (message.type === 'restore-token-forms') await inspect();
    return;
  }
  if (message.type === 'open-workspace' && message.id && /^[a-f0-9]{64}$/u.test(message.id)) {
    const targetOrigin = typeof message.origin === 'string' && isAllowedFoundryOrigin(message.origin) ? message.origin : 'https://sevan.tokenfoundry.lindstruct.com';
    figma.openExternal(targetOrigin + '/?workspace=' + message.id);
    return;
  }
  if (message.type === 'open-foundry' && message.connection) {
    const queryIndex = message.connection.indexOf('/#pair=');
    const targetOrigin = queryIndex > 0 ? message.connection.slice(0, queryIndex) : '';
    const suffix = queryIndex > 0 ? message.connection.slice(queryIndex) : '';
    const validSuffix = /^\/#pair=[a-f0-9]{64}&secret=[a-f0-9]{64}&document=[^&]+&name=[^&]+$/u;
    if (!isAllowedFoundryOrigin(targetOrigin) || !validSuffix.test(suffix)) throw new Error('The Foundry pairing link is invalid.');
    figma.openExternal(message.connection);
    return;
  }
  if (message.type === 'restore-connection' || message.type === 'remember-connection') {
    try {
      if (message.type === 'restore-connection') { await restoreConnection(connectionAPI, async (connection, concept) => { conceptFile = concept === true; activateWorkspace(/\/figma\/workspaces\/([a-f0-9]{64})\/files\//u.exec(connection)?.[1] ?? ''); await inspect(); }); }
      else if (message.connection) {
        await rememberConnection(connectionAPI, message.connection, message.name ?? '', message.expires, message.concept === true);
        conceptFile = message.concept === true;
        activateWorkspace(/\/figma\/workspaces\/([a-f0-9]{64})\/files\//u.exec(message.connection)?.[1] ?? '');
        post({ type: 'connection-saved' }, { origin: '*' });
      }
    } catch {
      post({ type: 'connection-storage-error', message: 'The connection could not be saved on this device. Keep its code to reconnect after closing the plugin.' }, { origin: '*' });
    }
    return;
  }
  if (message.type === 'forget-connection') { await forgetConnection(connectionAPI); conceptFile = false; return; }
  if (message.type === 'inspect') return inspect();
  if (conceptFile && message.type !== 'cancel-pull') throw new Error('Concept files use shared library tokens. Open the library file to edit token definitions.');
  refreshSnapshot();
  if (message.type === 'resolve-native-unit' && message.path && typeof message.value === 'number' && message.expectedNative !== undefined) {
    const { rows, collection } = await managed();
    const variable = rows.get(message.path);
    const source = bundle?.variables.some(row => row.path === message.path) || readJournal()?.next.variables.some(row => row.path === message.path);
    if (!variable || !collection || !source) throw new Error('The unit review no longer matches the source snapshot.');
    resolveNativeUnit(variable, collection.defaultModeId, message.expectedNative, message.value, numberScale(message.path, readJournal()?.next ?? bundle));
    return inspect();
  }
  if (message.type === 'resume-pull') {
    const journal = readJournal();
    if (!journal) throw new Error('There is no saved pull to resume. Pull the source snapshot again.');
    return pull(journal.next, undefined, undefined, journal.receipt, journal);
  }
  if (message.type === 'cancel-pull') {
    pendingPull = undefined;
    post({ type: 'pull-cancelled' }, { origin: '*' });
    return;
  }
  if (message.type === 'resolve-pull') {
    if (!pendingPull || message.id !== pendingPull.id || !message.choices) throw new Error('This conflict review is out of date. Pull again.');
    return pull(pendingPull.next, message.choices, pendingPull.local, pendingPull.receipt, pendingPull.journal);
  }
  if (message.type === 'build-library') {
    if (!libraryAdapter || !bundle) throw new Error('Open a source snapshot and build this plugin with the design system library adapter.');
    if (readJournal() || startupError || figma.root.getPluginData('foundry-operation')) throw new Error('Complete source recovery before building the UI kit.');
    const { rows, collection } = await managed();
    if (!collection || collection.modes.length !== 1) throw new Error('Map the source variables and modes before building the UI kit.');
    const paths = new Set(bundle.variables.map(row => row.path));
    const current = new Map([...rows].filter(([path]) => paths.has(path)));
    if (current.size !== paths.size || !(libraryAdapter.required ?? []).every(path => current.has(path))) throw new Error('Open the ' + libraryAdapter.name + ' source snapshot before building its UI kit.');
    if ([...current].some(([path, variable]) => nativeScale(variable, collection.defaultModeId) !== numberScale(path))) throw new Error('Open the source snapshot again to apply native number units before building the UI kit.');
    const result = await libraryAdapter.build(current);
    post({ type: 'library-built', ...result }, { origin: '*' });
    return;
  }
  if (message.type === 'pull' && message.bundle) {
    pendingPull = undefined;
    // Mark only the mutation phase in a later pull; retry can repair an interrupted import using stable path IDs.
    return pull(message.bundle, undefined, undefined, message.acknowledgement);
  }
  if (message.type === 'proposal') {
    if (readJournal() || startupError) throw new Error('Complete recovery before sending changes to Foundry.');
    if (!bundle) throw new Error('Pull a source snapshot first.');
    const { collection, rows } = await managed();
    if (!collection) throw new Error('The managed collection is missing.');
    if (collection.modes.length !== 1) throw new Error('Additional Figma modes require an explicit source mapping before exporting changes.');
    activateWorkspace(message.id ?? workspaceId);
    const local = localValues(rows, collection.defaultModeId);
    const observed = await observeSubmission(figma, bundle.revision, local, workspaceId, lastReceipt, consumedHere || !!workspaceId && snapshotWorkspace === workspaceId);
    intentId = observed.intentId; intentSequence = observed.intentSequence; lastReceipt = observed.receipt; consumedHere = false;
    post({ type: 'proposal', ...(message.serial === undefined ? {} : { serial: message.serial }), proposal: await identifySubmission(changedValues(bundle, local), lastReceipt, message.id ?? '', intentId, intentSequence) }, { origin: '*' });
    return;
  }
  if (message.type === 'edit' && message.path && bundle) {
    if (message.expected === undefined || message.revision !== bundle.revision) throw new Error('The source changed or this edit has no saved baseline. Select the token again before applying it.');
    if (readJournal() || startupError) throw new Error('Complete source recovery before editing token values.');
    const row = bundle.variables.find(item => item.path === message.path);
    if (!row?.editable) throw new Error('This token is read-only in Figma.');
    const { collection, rows } = await managed();
    const variable = rows.get(row.path);
    if (!collection || !variable) throw new Error('Pull the source snapshot first.');
    if (collection.modes.length !== 1) throw new Error('Additional Figma modes require an explicit source mapping before editing token values.');
    const target = message.alias ? rows.get(message.alias) : undefined;
    if (message.alias && (!target || target.resolvedType !== variable.resolvedType || !bundle.variables.some(item => item.path === message.alias))) throw new Error('Choose a compatible alias target from the current source snapshot.');
    if (target?.id === variable.id) throw new Error('A variable cannot reference itself.');
    if (target) {
      if (row.type === 'FLOAT' && numberScale(row.path) !== numberScale(message.alias ?? '')) throw new Error('This alias crosses incompatible native number units. Choose a target with the same mapping.');
      const seen = new Set([variable.id]);
      let current: Variable | undefined = target;
      const all = new Map((await figma.variables.getLocalVariablesAsync()).map(item => [item.id, item]));
      while (current) {
        if (seen.has(current.id)) throw new Error('This alias would create a circular reference.');
        seen.add(current.id);
        const value: VariableValue | undefined = current.valuesByMode[collection.defaultModeId];
        current = typeof value === 'object' && 'type' in value && value.type === 'VARIABLE_ALIAS' ? all.get(value.id) : undefined;
      }
    }
    if (message.value === undefined && !target) throw new Error('Enter a value or select an alias.');
    if (!target && !matchesVariableType(row.type, message.value)) throw new Error('The value does not match this token type. Your input is retained.');
    if (row.type === 'EASING' && !target) {
      if (!isCubicEasing(message.value)) throw new Error('Choose custom cubic Bézier control points for this source token.');
      if (easingPoints(message.value).some(point => !Number.isFinite(Math.fround(point)))) throw new Error('The cubic Bézier control points exceed the current native number range. Your input is retained.');
    }
    if (typeof message.value === 'number' && !Number.isFinite(Math.fround(message.value * numberScale(row.path)))) throw new Error('This value exceeds the current native number range. Your input is retained.');
    if (row.type === 'TIMING' && typeof message.value === 'number' && message.value < 0) throw new Error('Duration cannot be negative.');
    if (message.value !== undefined && !target) assertNativeRoundTrip(row, message.value, bundle);
    const next = target ? figma.variables.createVariableAlias(target) : message.value;
    if (next === undefined) throw new Error('Enter a value.');
    if (!sameLocalValue(message.expected, localValues(rows, collection.defaultModeId).get(row.path))) throw new Error('This value changed in Figma while this form was open. Select the token again to review its current value.');
    figma.commitUndo();
    writeNative(variable, collection.defaultModeId, next, numberScale(row.path));
    await inspect();
    post({ type: 'edited', path: row.path }, { origin: '*' });
    return;
  }
  throw new Error('The ' + (message.type ?? 'native') + ' request is unsupported or incomplete. Refresh Figma and retry.');
}

figma.showUI(__html__, { width: 520, height: 720, themeColors: true });
try { bundle = readBundle(); } catch { startupError = 'The saved source snapshot is damaged. Restore the file before importing.'; }
const receive: MessageEventHandler = (message: unknown) => {
  if (!isRecord(message)) return;
  const type = message['type'];
  if (typeof type !== 'string') return;
  const input = { type, ...(isBundle(message['bundle']) ? { bundle: message['bundle'] } : {}),
    ...(typeof message['client'] === 'string' && /^[a-f0-9]{64}$/u.test(message['client']) ? { client: message['client'] } : {}),
    ...(typeof message['connection'] === 'string' ? { connection: message['connection'] } : {}),
    ...(typeof message['name'] === 'string' ? { name: message['name'] } : {}),
    ...(typeof message['concept'] === 'boolean' ? { concept: message['concept'] } : {}),
    ...(isTokenFormEntries(message['forms']) ? { forms: message['forms'] } : {}),
    ...(typeof message['serial'] === 'number' && Number.isSafeInteger(message['serial']) && message['serial'] > 0 ? { serial: message['serial'] } : {}),
    ...(typeof message['expires'] === 'number' && Number.isFinite(message['expires']) ? { expires: message['expires'] } : {}),
    ...(typeof message['origin'] === 'string' ? { origin: message['origin'] } : {}),
    ...(typeof message['id'] === 'string' ? { id: message['id'] } : {}),
    ...(isAcknowledgement(message['acknowledgement']) ? { acknowledgement: message['acknowledgement'] } : {}),
    ...(isUnknownArray(message['choices']) && message['choices'].every(isPullChoice) ? { choices: message['choices'] } : {}),
    ...(typeof message['path'] === 'string' ? { path: message['path'] } : {}),
    ...(typeof message['alias'] === 'string' ? { alias: message['alias'] } : {}),
    ...(isFigmaValue(message['value']) ? { value: message['value'] } : {}),
    ...(isLocalValue(message['expected']) ? { expected: message['expected'] } : {}),
    ...(typeof message['revision'] === 'string' ? { revision: message['revision'] } : {}),
    ...(typeof message['expectedNative'] === 'number' && Number.isFinite(message['expectedNative']) ? { expectedNative: message['expectedNative'] } : {}) };
  queue = queue.then(async () => {
    currentRequest = input;
    try { await handle(input); return undefined; }
    catch (error) {
      const detail = error instanceof Error ? error.message : 'Figma could not complete the request.';
      console.error('Foundry controller error', detail);
      figma.notify(detail, { error: true, timeout: 8000 });
      await inspect().catch(() => undefined);
      post({ type: 'error', message: detail, ...(isRecord(error) && typeof error['code'] === 'string' ? { code: error['code'] } : {}) }, { origin: '*' });
      return undefined;
    } finally { currentRequest = undefined; }
  });
};
Reflect.set(figma.ui, 'onmessage', receive);
if (typeof figma.on === 'function') {
  figma.on('selectionchange', () => {
    queue = queue.then(() => inspect()).catch(() => undefined);
  });
}
