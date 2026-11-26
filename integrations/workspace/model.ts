import { isRecord, isUnknownArray } from '../../lib/json.ts';
import { openWorkspace } from '../../lib/workspace.ts';
import { mergeWorkspaceSources } from './merge.ts';
import { figmaBundle, proposalReview, sourceRevision } from '../figma/projection.ts';
import { proposalPull } from '../figma/proposal-pull.ts';
import { identifySubmission, submissionReceipt } from '../figma/submission.ts';
import { isTokenProposal, sameSourceValue, sourceFiles } from '../figma/contract.ts';
import type { FigmaBundle, SourceFile, TokenProposal } from '../figma/contract.ts';
import { importedValue, isAcknowledgement } from '../figma/merge.ts';
import type { FigmaAcknowledgement, PullChoice } from '../figma/merge.ts';
import { isConflictDraft, unmatchedConflictDrafts } from '../figma/recovery.ts';
import type { ConflictDraft } from '../figma/recovery.ts';
import { commitOid, proposalBranch, repositoryName } from '../github/contract.ts';
import { isProposal } from '../github/contract.ts';
import type { PullRequestProposal } from '../github/contract.ts';

export interface RepositoryPin { repository: string; root: string; revision: string; branch?: string; pullRequest?: string }
export interface WorkspaceInput { name: string; files: SourceFile[]; baseline: SourceFile[]; repository?: RepositoryPin }
export interface SourceSnapshot { revision: string; files: SourceFile[] }
export interface RepositorySaveResult { url: string; branch: string; revision: string }
export interface RepositorySave { id: string; source: string; root: string; request: PullRequestProposal; started?: true; result?: RepositorySaveResult }
export const isRepositorySaveResult = (value: unknown): value is RepositorySaveResult => isRecord(value) && typeof value['url'] === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/u.test(value['url']) &&
  typeof value['branch'] === 'string' && proposalBranch.test(value['branch']) && typeof value['revision'] === 'string' && commitOid.test(value['revision']);
const isRepositorySave = (value: unknown): value is RepositorySave => isRecord(value) && isIdentity(value['id']) && isIdentity(value['source']) && typeof value['root'] === 'string' && isProposal(value['request']) &&
  (value['started'] === undefined || value['started'] === true) &&
  (value['result'] === undefined || isRepositorySaveResult(value['result']));
interface SourceCursor {
  baseline: string; offered: string;
  acknowledged?: true;
  consumedReceipt?: string;
  nativeIntent?: { id: string; sequence: number };
  receipt?: FigmaAcknowledgement; submitted?: TokenProposal;
  submissions?: { proposal: TokenProposal; receipt: FigmaAcknowledgement }[];
}
export interface LinkedDocument extends SourceCursor { id: string; name: string; role: 'library' | 'concept' }
export interface DocumentReplica extends SourceCursor { id: string; document: string }
export interface IncomingChange { id: string; document: string; replica?: string; proposal: TokenProposal; review?: { revision: string; drafts: ConflictDraft[] } }
export interface WorkspaceEvent { version: number; kind: 'created' | 'edited' | 'paired' | 'received' | 'resolved' | 'disconnected'; at: number; document?: string }
export interface SharedWorkspace {
  format: 'token-foundry/workspace'; schemaVersion: 1; id: string; version: number; name: string;
  draft: string; baseline: string; sources: SourceSnapshot[]; repository?: RepositoryPin;
  documents: LinkedDocument[]; incoming: IncomingChange[]; activity: WorkspaceEvent[];
  repositorySave?: RepositorySave;
  replicas?: DocumentReplica[];
}
export interface DocumentConnection { id: string; expires: number; created?: number; baseline: string; offered: string; acknowledged?: boolean }
export interface WorkspaceView {
  id: string; name: string; version: number; draft: SourceSnapshot; baseline: SourceSnapshot; repository?: RepositoryPin;
  documents: (Omit<LinkedDocument, 'receipt' | 'submitted' | 'submissions'> & { expires?: number; connections?: DocumentConnection[] })[]; incoming: IncomingChange[]; activity: WorkspaceEvent[];
  repositorySave?: RepositorySave;
}
export interface SharedRecovery { id: string; origin: string; accepted: SourceSnapshot; checkpoint?: SourceSnapshot; repository?: RepositoryPin }
export class SourceSnapshotUnavailable extends Error {}
export const isIdentity = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const isRepositoryPin = (value: unknown): value is RepositoryPin => isRecord(value) && typeof value['repository'] === 'string' && repositoryName.test(value['repository']) &&
  typeof value['root'] === 'string' && typeof value['revision'] === 'string' && commitOid.test(value['revision']) &&
  (value['branch'] === undefined || typeof value['branch'] === 'string' && proposalBranch.test(value['branch'])) &&
  (value['pullRequest'] === undefined || typeof value['pullRequest'] === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/u.test(value['pullRequest']));
export const isWorkspaceInput = (value: unknown): value is WorkspaceInput => isRecord(value) && typeof value['name'] === 'string' && !!value['name'].trim() &&
  sourceFiles(value['files']) && sourceFiles(value['baseline']) && (value['repository'] === undefined || isRepositoryPin(value['repository']));
const isSource = (value: unknown): value is SourceSnapshot => isRecord(value) && isIdentity(value['revision']) && sourceFiles(value['files']);
export const isSharedRecovery = (value: unknown): value is SharedRecovery => isRecord(value) && isIdentity(value['id']) && typeof value['origin'] === 'string' && isSource(value['accepted']) &&
  Object.keys(value).every(key => ['id', 'origin', 'accepted', 'checkpoint', 'repository'].includes(key)) &&
  (value['checkpoint'] === undefined || isSource(value['checkpoint'])) && (value['repository'] === undefined || isRepositoryPin(value['repository']));
const isCursor = (value: unknown): value is SourceCursor => isRecord(value) && isIdentity(value['baseline']) && isIdentity(value['offered']) &&
  (value['acknowledged'] === undefined || value['acknowledged'] === true) &&
  (value['consumedReceipt'] === undefined || typeof value['consumedReceipt'] === 'string') &&
  (value['nativeIntent'] === undefined || isRecord(value['nativeIntent']) && isIdentity(value['nativeIntent']['id']) && typeof value['nativeIntent']['sequence'] === 'number' && Number.isSafeInteger(value['nativeIntent']['sequence']) && value['nativeIntent']['sequence'] > 0) &&
  (value['receipt'] === undefined || isAcknowledgement(value['receipt'])) && (value['submitted'] === undefined || isTokenProposal(value['submitted'])) &&
  (value['submissions'] === undefined || isUnknownArray(value['submissions']) && value['submissions'].every(entry => isRecord(entry) && isTokenProposal(entry['proposal']) && isAcknowledgement(entry['receipt'])));
const isDocument = (value: unknown): value is LinkedDocument => isRecord(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string' &&
  ['library', 'concept'].includes(String(value['role'])) && isCursor(value);
const isReplica = (value: unknown): value is DocumentReplica => isRecord(value) && isIdentity(value['id']) && typeof value['document'] === 'string' && isCursor(value);
const isIncoming = (value: unknown): value is IncomingChange => isRecord(value) && typeof value['id'] === 'string' && typeof value['document'] === 'string' && isTokenProposal(value['proposal']) &&
  (value['replica'] === undefined || isIdentity(value['replica']));
const isConnection = (value: unknown): value is DocumentConnection => isRecord(value) && isIdentity(value['id']) && typeof value['expires'] === 'number' && Number.isFinite(value['expires']) &&
  (value['acknowledged'] === undefined || typeof value['acknowledged'] === 'boolean') &&
  isIdentity(value['baseline']) && isIdentity(value['offered']) && (value['created'] === undefined || typeof value['created'] === 'number' && Number.isFinite(value['created']));
const isDocumentView = (value: unknown) => isDocument(value) && isRecord(value) && (value['connections'] === undefined || isUnknownArray(value['connections']) && value['connections'].every(isConnection));
export const isSharedWorkspace = (value: unknown): value is SharedWorkspace => isRecord(value) && value['format'] === 'token-foundry/workspace' && value['schemaVersion'] === 1 &&
  isIdentity(value['id']) && Number.isSafeInteger(value['version']) && Number(value['version']) > 0 && typeof value['name'] === 'string' &&
  isIdentity(value['draft']) && isIdentity(value['baseline']) && isUnknownArray(value['sources']) && value['sources'].every(isSource) &&
  (value['repository'] === undefined || isRepositoryPin(value['repository'])) && isUnknownArray(value['documents']) && value['documents'].every(isDocument) &&
  (value['repositorySave'] === undefined || isRepositorySave(value['repositorySave'])) &&
  (value['replicas'] === undefined || isUnknownArray(value['replicas']) && value['replicas'].every(isReplica)) &&
  isUnknownArray(value['incoming']) && value['incoming'].every(isIncoming) &&
  isUnknownArray(value['activity']) && value['activity'].every(row => isRecord(row) && Number.isSafeInteger(row['version']) && typeof row['at'] === 'number' &&
    ['created', 'edited', 'paired', 'received', 'resolved', 'disconnected'].includes(String(row['kind'])) && (row['document'] === undefined || typeof row['document'] === 'string'));

export const isWorkspaceView = (value: unknown): value is WorkspaceView => isRecord(value) && isIdentity(value['id']) && typeof value['name'] === 'string' &&
  Number.isSafeInteger(value['version']) && isSource(value['draft']) && isSource(value['baseline']) &&
  (value['repositorySave'] === undefined || isRepositorySave(value['repositorySave'])) &&
  (value['repository'] === undefined || isRepositoryPin(value['repository'])) && isUnknownArray(value['documents']) && value['documents'].every(isDocumentView) &&
  isUnknownArray(value['incoming']) && value['incoming'].every(isIncoming) &&
  isUnknownArray(value['activity']) && value['activity'].every(row => isRecord(row) && Number.isSafeInteger(row['version']) && typeof row['kind'] === 'string' && typeof row['at'] === 'number');

export function workspaceView(state: SharedWorkspace): WorkspaceView {
  return { id: state.id, name: state.name, version: state.version, draft: workspaceSource(state), baseline: workspaceSource(state, state.baseline),
    ...(state.repository ? { repository: state.repository } : {}), documents: state.documents.map(({ submitted, receipt, submissions, consumedReceipt, nativeIntent, ...file }) => {
      void submitted; void receipt; void submissions; void consumedReceipt; void nativeIntent; return file;
    }), incoming: state.incoming, activity: state.activity, ...(state.repositorySave ? { repositorySave: state.repositorySave } : {}) };
}

export function workspaceSource(state: SharedWorkspace, revision = state.draft): SourceSnapshot {
  const source = state.sources.find(item => item.revision === revision);
  if (!source) throw new SourceSnapshotUnavailable('This source revision is unavailable. Retain your draft and review the current workspace.');
  return source;
}
async function checkedSource(files: SourceFile[]): Promise<SourceSnapshot> {
  openWorkspace('Source', files); // Validates paths and duplicates; malformed source remains recoverable.
  if (new TextEncoder().encode(JSON.stringify(files)).length > 8 * 1024 * 1024) throw new Error('The workspace exceeds the configured 8 MB source limit.');
  return { revision: await sourceRevision(files), files };
}
async function projection(state: SharedWorkspace, revision = state.draft): Promise<FigmaBundle> {
  const source = workspaceSource(state, revision);
  const bundle = await figmaBundle(openWorkspace(state.name, source.files));
  if (bundle.revision !== source.revision) throw new Error('The stored source revision is invalid. Recover the original sources before syncing.');
  return bundle;
}
const cursorRevisions = (cursor: SourceCursor) => [cursor.baseline, cursor.offered, ...(cursor.receipt ? [cursor.receipt.sourceRevision] : [])];
function advance(state: SharedWorkspace, kind: WorkspaceEvent['kind'], document?: string): SharedWorkspace {
  const documents = state.documents.map(file => {
    const replicas = state.replicas?.filter(item => item.document === file.id) ?? [];
    const cursor = replicas.find(item => item.baseline !== state.draft) ?? replicas[0];
    if (!cursor || state.incoming.some(item => item.document === file.id && !item.replica)) return file;
    const { receipt, submitted, submissions, ...rest } = file; void receipt; void submitted; void submissions;
    return { ...rest, baseline: cursor.baseline, offered: cursor.offered };
  });
  const next = { ...state, documents, version: state.version + 1, activity: [...state.activity, { version: state.version + 1, kind, at: Date.now(), ...(document ? { document } : {}) }].slice(-100) };
  const needed = new Set([next.draft, next.baseline, ...(next.repositorySave ? [next.repositorySave.source] : []), ...next.documents.flatMap(cursorRevisions), ...(next.replicas ?? []).flatMap(cursorRevisions), ...next.incoming.map(item => item.proposal.sourceRevision)]);
  return { ...next, sources: next.sources.filter(source => needed.has(source.revision)) };
}
function withSource(state: SharedWorkspace, source: SourceSnapshot): SharedWorkspace {
  return { ...state, sources: [...state.sources.filter(item => item.revision !== source.revision), source] };
}
export async function createWorkspace(id: string, input: WorkspaceInput): Promise<SharedWorkspace> {
  if (!isIdentity(id) || !isWorkspaceInput(input)) throw new Error('The workspace is incomplete.');
  const [draft, baseline] = await Promise.all([checkedSource(input.files), checkedSource(input.baseline)]);
  return { format: 'token-foundry/workspace', schemaVersion: 1, id, version: 1, name: input.name, draft: draft.revision, baseline: baseline.revision,
    sources: draft.revision === baseline.revision ? [draft] : [draft, baseline], ...(input.repository ? { repository: input.repository } : {}),
    documents: [], incoming: [], activity: [{ version: 1, kind: 'created', at: Date.now() }] };
}
/** Independent browser/file edits merge against the source revision the client actually read. */
export async function saveWorkspace(state: SharedWorkspace, before: string, input: WorkspaceInput): Promise<SharedWorkspace> {
  if (!isWorkspaceInput(input)) throw new Error('The workspace draft is incomplete.');
  const previous = workspaceSource(state, before);
  const files = before === state.draft ? input.files : mergeWorkspaceSources(state.name, previous.files, input.files, workspaceSource(state).files);
  const [draft, baseline] = await Promise.all([checkedSource(files), checkedSource(input.baseline)]);
  if (state.repositorySave && !state.repositorySave.result && (baseline.revision !== state.baseline || !sameSourceValue(input.repository, state.repository))) throw new Error('Finish the interrupted repository save before changing its checkpoint. Your draft is retained.');
  if (draft.revision === state.draft && baseline.revision === state.baseline && sameSourceValue(input.repository, state.repository)) return state;
  // A stale client cannot silently move the repository checkpoint backwards.
  if (before !== state.draft && baseline.revision !== state.baseline) throw new Error('The repository baseline changed during this edit. Refresh the workspace before saving.');
  const { repository: oldPin, ...rest } = withSource(withSource(state, draft), baseline); void oldPin;
  return advance({ ...rest, draft: draft.revision, baseline: baseline.revision, ...(input.repository ? { repository: input.repository } : {}) }, 'edited');
}
export function renameWorkspace(state: SharedWorkspace, before: string, name: string) {
  if (!name.trim() || name.trim().length > 120) throw new Error('Use a workspace name between 1 and 120 characters.');
  if (state.name !== before && state.name !== name.trim()) throw new Error('The workspace was renamed in another client. Check its current name before changing it.');
  return state.name === name.trim() ? state : advance({ ...state, name: name.trim() }, 'edited');
}
/** Persist the exact reviewed request before calling GitHub. Replays keep that identity. */
export async function beginRepositorySave(state: SharedWorkspace, request: PullRequestProposal, root: string): Promise<SharedWorkspace> {
  if (!isProposal(request)) throw new Error('The reviewed repository save is incomplete.');
  const ordered: PullRequestProposal = { repository: request.repository, revision: request.revision,
    changes: request.changes.map(({ path, before, after }) => ({ path, before, after })).toSorted((left, right) => left.path.localeCompare(right.path, 'en')),
    ...(request.branch ? { branch: request.branch } : {}) };
  const id = await sourceRevision([{ path: 'repository-save.json', text: JSON.stringify([root, ordered]) }]);
  if (state.repositorySave?.id === id) return state;
  if (state.repositorySave && !state.repositorySave.result) throw new Error('Finish the previous repository save before submitting more changes.');
  const pin = state.repository;
  if (!pin || pin.repository !== request.repository || pin.root !== root || pin.revision !== request.revision || pin.branch !== request.branch) throw new Error('The repository checkpoint changed. Review the latest workspace before saving.');
  const files = new Map(workspaceSource(state, state.baseline).files.map(file => [file.path, file.text]));
  const seen = new Set<string>();
  for (const change of request.changes) {
    if (seen.has(change.path) || !change.path.startsWith(root + '/') || (files.get(change.path) ?? null) !== change.before || change.before === change.after) throw new Error('The reviewed changes do not match the repository baseline.');
    seen.add(change.path);
    if (change.after === null) files.delete(change.path); else files.set(change.path, change.after);
  }
  const reviewed = await checkedSource([...files].map(([path, text]) => ({ path, text })));
  if (reviewed.revision !== state.draft) throw new Error('The shared draft changed after review. Review the current changes before saving.');
  return advance({ ...state, repositorySave: { id, source: reviewed.revision, root, request: ordered } }, 'edited');
}
export function finishRepositorySave(state: SharedWorkspace, id: string, result: RepositorySaveResult): SharedWorkspace {
  const saved = state.repositorySave;
  if (!saved || saved.id !== id || !isRepositorySaveResult(result) || !result.url.startsWith('https://github.com/' + saved.request.repository + '/pull/')) throw new Error('The repository result does not match the reviewed save.');
  if (saved.result) {
    if (!sameSourceValue(saved.result, result)) throw new Error('The repository save already has a different result.');
    return state;
  }
  workspaceSource(state, saved.source);
  return advance({ ...state, baseline: saved.source, repository: { repository: saved.request.repository, root: saved.root, revision: result.revision, branch: result.branch, pullRequest: result.url },
    repositorySave: { ...saved, result } }, 'edited');
}
export function startRepositorySave(state: SharedWorkspace, id: string): SharedWorkspace {
  const operation = state.repositorySave;
  if (!operation || operation.id !== id || operation.result) throw new Error('This reviewed save was cancelled or completed. Review the current workspace before saving.');
  return operation.started ? state : advance({ ...state, repositorySave: { ...operation, started: true } }, 'edited');
}
export function cancelRepositorySave(state: SharedWorkspace, id: string): SharedWorkspace {
  const operation = state.repositorySave;
  if (!operation || operation.id !== id || operation.result || operation.started) throw new Error('A repository write may have started. Resume the reviewed save to verify its result.');
  const { repositorySave, ...next } = state; void repositorySave;
  return advance(next, 'edited');
}
export function pairDocument(state: SharedWorkspace, file: Pick<LinkedDocument, 'id' | 'name' | 'role'>): SharedWorkspace {
  if (!file.id || !file.name.trim() || !['library', 'concept'].includes(file.role)) throw new Error('Name the Figma file and choose its role.');
  const existing = state.documents.find(item => item.id === file.id);
  if (existing) {
    if (existing.role !== file.role) throw new Error('This file is already linked as a ' + existing.role + '. Reconnect it using its existing role.');
    return existing.name === file.name ? state : advance({ ...state, documents: state.documents.map(item => item.id === file.id ? { ...item, name: file.name } : item) }, 'paired', file.id);
  }
  if (state.documents.length >= 20) throw new Error('This workspace reached its configured 20-file limit.');
  return advance({ ...state, documents: [...state.documents, { ...file, baseline: state.draft, offered: state.draft }] }, 'paired', file.id);
}
export function disconnectDocument(state: SharedWorkspace, id: string): SharedWorkspace {
  // Keep both the durable document identity and its draft; access grants are revoked by the transport.
  if (!state.documents.some(item => item.id === id)) throw new Error('This Figma file is not linked to the workspace.');
  return advance(state, 'disconnected', id);
}
function cursorFor(state: SharedWorkspace, document: string, replica?: string): SourceCursor {
  const cursor = replica ? state.replicas?.find(item => item.id === replica && item.document === document) : state.documents.find(item => item.id === document);
  if (!cursor) throw new SourceSnapshotUnavailable('This file connection has no source baseline. Connect the file again and retain its local changes.');
  return cursor;
}
function withCursor(state: SharedWorkspace, document: string, replica: string | undefined, cursor: SourceCursor): SharedWorkspace {
  function update<T extends SourceCursor>(item: T): T {
    const next = { ...item, ...cursor };
    if (cursor.consumedReceipt === undefined) delete next.consumedReceipt;
    return next;
  }
  return replica ? { ...state, replicas: (state.replicas ?? []).map(item => item.id === replica && item.document === document ? update(item) : item) } :
    { ...state, documents: state.documents.map(item => item.id === document ? update(item) : item) };
}
export function registerReplica(state: SharedWorkspace, document: string, id: string, inheritLegacy = false): SharedWorkspace {
  if (!isIdentity(id)) throw new Error('The file connection identity is invalid.');
  const existing = state.replicas?.find(item => item.id === id);
  if (existing) { if (existing.document !== document) throw new Error('This connection belongs to another file.'); return state; }
  const file = state.documents.find(item => item.id === document);
  if (!file) throw new Error('This Figma file is not linked to the workspace.');
  const cursor: SourceCursor = inheritLegacy ? { baseline: file.baseline, offered: file.offered, ...(file.receipt ? { receipt: file.receipt } : {}), ...(file.submitted ? { submitted: file.submitted } : {}) } : { baseline: state.draft, offered: state.draft };
  return advance({ ...state, replicas: [...state.replicas ?? [], { id, document, ...cursor }], incoming: inheritLegacy ? state.incoming.map(item => item.document === document && !item.replica ? { ...item, id: id + ':' + item.proposal.sourceRevision, replica: id } : item) : state.incoming }, 'paired', document);
}
export function pruneReplicas(state: SharedWorkspace, active: ReadonlySet<string>): SharedWorkspace {
  const kept = state.replicas?.filter(item => active.has(item.id) || state.incoming.some(change => change.replica === item.id));
  return kept?.length === state.replicas?.length ? state : advance({ ...state, replicas: kept ?? [] }, 'disconnected');
}
export async function offerWorkspace(state: SharedWorkspace, id: string, replica?: string) {
  const file = state.documents.find(item => item.id === id);
  if (!file) throw new Error('This Figma file is not linked to the workspace.');
  const cursor = cursorFor(state, id, replica);
  const next = cursor.offered === state.draft ? state : advance(withCursor(state, id, replica, { ...cursor, offered: state.draft }), 'received', id);
  return { state: next, bundle: await projection(next), ...(cursor.receipt ? { acknowledgement: cursor.receipt } : {}) };
}
export function acknowledgeSource(state: SharedWorkspace, id: string, revision: string, replica?: string): SharedWorkspace {
  const cursor = cursorFor(state, id, replica);
  if (![cursor.offered, cursor.baseline].includes(revision)) throw new SourceSnapshotUnavailable('The Figma acknowledgement does not match its offered source revision.');
  return revision === cursor.baseline && cursor.acknowledged ? state : advance(withCursor(state, id, replica, { ...cursor, baseline: revision, acknowledged: true }), 'received', id);
}
export function resumeReplica(state: SharedWorkspace, document: string, replica: string, revision: string, consumedReceipt?: string): SharedWorkspace {
  // Another device may have updated this Figma file's saved source snapshot.
  // Its exact bytes must still be a known workspace revision before resuming.
  workspaceSource(state, revision);
  const cursor = cursorFor(state, document, replica);
  if (consumedReceipt) {
    const cursors: SourceCursor[] = [...state.documents.filter(file => file.id === document), ...state.replicas?.filter(item => item.document === document) ?? []];
    const known = cursors.some(item => item.receipt?.id === consumedReceipt || item.submissions?.some(entry => entry.receipt.id === consumedReceipt));
    if (!known) throw new SourceSnapshotUnavailable('The saved native acknowledgement is unavailable. Retain your native edits and review the current source.');
  }
  return cursor.baseline === revision && cursor.acknowledged && (!consumedReceipt || cursor.consumedReceipt === consumedReceipt) ? state :
    advance(withCursor(state, document, replica, { ...cursor, baseline: revision, acknowledged: true, ...(consumedReceipt ? { consumedReceipt } : {}) }), 'received', document);
}
export async function inspectIncoming(state: SharedWorkspace, document: string, replica?: string) {
  const pending = state.incoming.find(item => item.document === document && item.replica === replica);
  if (!pending) throw new Error('This Figma change has already been reviewed.');
  const base = await projection(state, pending.proposal.sourceRevision);
  const current = { ...openWorkspace(state.name, workspaceSource(state).files), baseline: workspaceSource(state, state.baseline).files };
  const result = await proposalPull(current, base, pending.proposal, undefined, submissionReceipt(pending.proposal, cursorFor(state, document, replica).receipt));
  return { proposal: pending.proposal, conflicts: result.conflicts, current: result.current, drafts: pending.review?.drafts ?? [],
    reviewChanged: !!pending.review && pending.review.revision !== state.draft };
}
export async function saveReviewDrafts(state: SharedWorkspace, document: string, revision: string, drafts: ConflictDraft[], replica?: string) {
  if (revision !== state.draft) throw new Error('The workspace changed. Review its current values before choosing.');
  const review = await inspectIncoming(state, document, replica);
  const paths = new Set(review.conflicts.map(item => item.path));
  if (!drafts.every(isConflictDraft) || new Set(drafts.map(item => item.path)).size !== drafts.length ||
    drafts.some(item => !paths.has(item.path) && !review.drafts.some(previous => sameSourceValue(previous, item)))) throw new Error('The choices do not match the current conflicting tokens.');
  return advance({ ...state, incoming: state.incoming.map(item => item.document === document && item.replica === replica ? { ...item, review: { revision, drafts } } : item) }, 'received', document);
}
/** Returns one durable queue item for a true conflict; independent edits are accepted and acknowledged immediately. */
export async function receiveChanges(state: SharedWorkspace, id: string, input: TokenProposal, choices?: PullChoice[], expectedDraft?: string, replica?: string) {
  const file = state.documents.find(item => item.id === id);
  if (!file || file.role !== 'library') throw new Error('Shared tokens can be edited from the linked library file.');
  if (!isTokenProposal(input)) throw new Error('The token changes are incomplete.');
  const proposal = input.submissionId ? await identifySubmission(input, input.acknowledgedReceipt, state.id) : input;
  if (input.submissionId && (input.workspaceId !== state.id || input.submissionId !== proposal.submissionId)) throw new Error('This submission does not match its workspace or token changes. Retain the native edits and review the current source.');
  const cursor = cursorFor(state, id, replica);
  const history = cursor.submissions ?? (cursor.submitted && cursor.receipt ? [{ proposal: cursor.submitted, receipt: cursor.receipt }] : []);
  const known = history.find(entry => sameSourceValue(entry.proposal, proposal));
  if (known) return { state, accepted: true, bundle: await projection(state), acknowledgement: known.receipt, conflicts: [] };
  if (cursor.submitted && sameSourceValue(cursor.submitted, proposal) && cursor.receipt) return { state, accepted: true, bundle: await projection(state), acknowledgement: cursor.receipt, conflicts: [] };
  if (!proposal.submissionId && cursor.receipt?.submissionId) throw new SourceSnapshotUnavailable('Reopen the updated Foundry plugin before sending more edits. Your native values are retained.');
  if (proposal.submissionId && cursor.receipt && proposal.acknowledgedReceipt !== cursor.receipt.id && proposal.acknowledgedReceipt !== (cursor.receipt.previousReceipt ?? '') && proposal.acknowledgedReceipt !== cursor.consumedReceipt) throw new SourceSnapshotUnavailable('This submission predates the current acknowledgement. Review the current source before sending another edit. Your native values are retained.');
  const existingReview = state.incoming.find(item => item.document === id && item.replica === replica);
  const nativeIntent = proposal.intentId && proposal.intentSequence ? { id: proposal.intentId, sequence: proposal.intentSequence } : undefined;
  if (cursor.nativeIntent && !sameSourceValue(existingReview?.proposal, proposal)) {
    if (!nativeIntent || nativeIntent.id === cursor.nativeIntent.id && nativeIntent.sequence <= cursor.nativeIntent.sequence)
      throw new SourceSnapshotUnavailable('Newer native edits were already received. Read the current source before sending these retained edits.');
    if (nativeIntent.id !== cursor.nativeIntent.id && proposal.acknowledgedReceipt !== cursor.receipt?.id && proposal.acknowledgedReceipt !== cursor.consumedReceipt)
      throw new SourceSnapshotUnavailable('Another plugin session advanced this file. Read its current source before sending these retained edits.');
  }
  if (existingReview && !sameSourceValue(existingReview.proposal, proposal)) throw new Error('Finish the existing conflict review before submitting another set of changes.');
  if (choices && expectedDraft !== state.draft) throw new Error('The workspace changed during this review. Review its current values again.');
  if (!existingReview && ![cursor.baseline, cursor.offered].includes(proposal.sourceRevision)) throw new SourceSnapshotUnavailable('The Figma changes use a different source baseline. Review the current workspace and retain your local changes.');
  const base = await projection(state, proposal.sourceRevision);
  const current = { ...openWorkspace(state.name, workspaceSource(state).files), baseline: workspaceSource(state, state.baseline).files };
  if (choices && existingReview?.review?.drafts.length) {
    const review = await inspectIncoming(state, id, replica);
    if (unmatchedConflictDrafts(review.conflicts, review.drafts).length) throw new Error('Review or discard the retained input for tokens that no longer conflict before applying choices.');
  }
  const result = await proposalPull(current, base, proposal, choices, submissionReceipt(proposal, cursor.receipt));
  if (result.conflicts.length || choices === undefined && unmatchedConflictDrafts(result.conflicts, existingReview?.review?.drafts ?? []).length) {
    const pending = state.incoming.find(item => item.document === id && item.replica === replica);
    if (pending && !sameSourceValue(pending.proposal, proposal)) throw new Error('Finish the existing conflict review before submitting another set of changes.');
    const queued = { ...state, incoming: [...state.incoming, { id: (replica ?? id) + ':' + proposal.sourceRevision, document: id, ...(replica ? { replica } : {}), proposal }] };
    const next = pending ? state : advance(nativeIntent ? withCursor(queued, id, replica, { ...cursor, nativeIntent }) : queued, 'received', id);
    return { state: next, accepted: false, conflicts: result.conflicts, current: result.current, drafts: pending?.review?.drafts ?? [],
      reviewChanged: !!pending?.review && pending.review.revision !== state.draft };
  }
  const submitted = await figmaBundle(proposalReview(openWorkspace(state.name, base.files), base, proposal).next);
  const receipt: FigmaAcknowledgement = { id: (replica ?? id) + ':' + (state.version + 1), sourceRevision: proposal.sourceRevision,
    ...(proposal.submissionId ? { submissionId: proposal.submissionId, previousReceipt: proposal.acknowledgedReceipt ?? '' } : {}),
    values: submitted.variables.filter(row => proposal.changes.some(change => change.path === row.path)).map(row => ({ path: row.path, value: importedValue(row) })) };
  const submissions = proposal.submissionId ? [...history.filter(entry => (entry.proposal.acknowledgedReceipt ?? '') === proposal.acknowledgedReceipt), { proposal, receipt }] : undefined;
  if (submissions && (submissions.length > 16 || new TextEncoder().encode(JSON.stringify(submissions)).length > 1024 * 1024)) throw new SourceSnapshotUnavailable('Read the latest source acknowledgement before sending more edits. Your native values are retained.');
  const source = await checkedSource((result.review?.next ?? current).files.map(({ path, text }) => ({ path, text })));
  const { consumedReceipt, ...settledCursor } = cursor; void consumedReceipt;
  const next = advance(withCursor({ ...withSource(state, source), draft: source.revision, incoming: state.incoming.filter(item => item.document !== id || item.replica !== replica) }, id, replica,
    { ...settledCursor, offered: source.revision, receipt, submitted: proposal, ...(submissions ? { submissions } : {}), ...(nativeIntent ? { nativeIntent } : {}) }), choices ? 'resolved' : 'received', id);
  return { state: next, accepted: true, bundle: await projection(next), acknowledgement: receipt, conflicts: [] };
}
