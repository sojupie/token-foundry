import { isJsonValue, isRecord, isUnknownArray } from '../../lib/json.ts';
import { isDraft } from './draft.ts';
import type { Draft, GridColumn } from './draft.ts';
import type { ResolverOrigin } from '../../lib/resolver.ts';
import type { SourceLocation } from '../source-dialog.tsx';
import { isSnapshot } from '../../integrations/github/contract.ts';
import type { RepositorySnapshot } from '../../integrations/github/contract.ts';
import type { RepositoryChoiceDraft } from '../../lib/repository-merge.ts';
import { isSharedRecovery } from '../../integrations/workspace/model.ts';
import type { SharedRecovery } from '../../integrations/workspace/model.ts';
import { isBulkDraft } from './bulk-draft.ts';
import type { BulkDraft, SelectionEdit } from './bulk-draft.ts';
import { isRepositoryChoiceDraft } from '../../lib/repository-merge.ts';
import { isIncomingReviewRecovery } from './figma-review.ts';
import type { IncomingReviewRecovery } from './figma-review.ts';

interface Source { path: string; text: string }
export interface RecoveryEditor {
  group: string; selected: string; column: GridColumn; inspector: boolean;
  resolverFile: string; primary: Record<string, string>; secondary: Record<string, string>; comparing: boolean; editingSet?: string;
  draft?: Draft; variant?: { draft: Draft; target: { path: string; origin: ResolverOrigin; insert?: true } };
  source?: { location: SourceLocation; text: string };
  bulk?: { paths: readonly string[]; action: SelectionEdit; form: BulkDraft };
  workspaceReview?: { open: boolean; choices: RepositoryChoiceDraft[] };
  figmaReviews?: { open: string; entries: IncomingReviewRecovery[] };
  stagedFigmaDraft?: Draft;
}
export interface RecoveryWork {
  name: string; files: Source[]; baseline: Source[]; github?: RepositorySnapshot; folder: boolean;
  editor?: RecoveryEditor;
  repositoryReview?: { snapshot: RepositorySnapshot; choices: RepositoryChoiceDraft[] };
  shared?: SharedRecovery;
}
export interface RecoveryRecord extends RecoveryWork { id: string; revision: number; updated: number }
const isSources = (value: unknown): value is Source[] => isUnknownArray(value) && value.every(file => isRecord(file) && typeof file['path'] === 'string' && typeof file['text'] === 'string');
const isStrings = (value: unknown): value is string[] => isUnknownArray(value) && value.every(part => typeof part === 'string');
const isInputs = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every(part => typeof part === 'string');
const isOrigin = (value: unknown): value is ResolverOrigin => isRecord(value) && typeof value['file'] === 'string' && isStrings(value['parts']) &&
  ['set', 'modifier', 'context'].every(key => value[key] === undefined || typeof value[key] === 'string');
const isLocation = (value: unknown): value is SourceLocation => isRecord(value) && typeof value['file'] === 'string' && isStrings(value['path']) &&
  (value['offset'] === undefined || typeof value['offset'] === 'number' && Number.isSafeInteger(value['offset']) && value['offset'] >= 0) &&
  (value['resolver'] === undefined || isRecord(value['resolver']) && typeof value['resolver']['file'] === 'string' &&
    (value['resolver']['labelPrefix'] === undefined || typeof value['resolver']['labelPrefix'] === 'string') &&
    isUnknownArray(value['resolver']['contexts']) && value['resolver']['contexts'].every(context => isRecord(context) && typeof context['label'] === 'string' &&
      isRecord(context['inputs']) && Object.values(context['inputs']).every(input => input === undefined || isJsonValue(input))));
const isEditor = (value: unknown): value is RecoveryEditor => isRecord(value) && ['group', 'selected', 'resolverFile'].every(key => typeof value[key] === 'string') &&
  typeof value['column'] === 'string' && ['name', 'value', 'type', 'description', 'resolved'].includes(value['column']) && typeof value['inspector'] === 'boolean' &&
  isInputs(value['primary']) && isInputs(value['secondary']) && typeof value['comparing'] === 'boolean' && (value['editingSet'] === undefined || typeof value['editingSet'] === 'string') &&
  (value['draft'] === undefined || isDraft(value['draft'])) && (value['variant'] === undefined || isRecord(value['variant']) && isDraft(value['variant']['draft']) &&
    isRecord(value['variant']['target']) && typeof value['variant']['target']['path'] === 'string' && isOrigin(value['variant']['target']['origin']) &&
    (value['variant']['target']['insert'] === undefined || value['variant']['target']['insert'] === true)) &&
  (value['source'] === undefined || isRecord(value['source']) && typeof value['source']['text'] === 'string' && isLocation(value['source']['location'])) &&
  (value['bulk'] === undefined || isRecord(value['bulk']) && isUnknownArray(value['bulk']['paths']) && value['bulk']['paths'].length > 0 && value['bulk']['paths'].every(path => typeof path === 'string') &&
    typeof value['bulk']['action'] === 'string' && ['rename', 'value', 'type', 'description'].includes(value['bulk']['action']) && isBulkDraft(value['bulk']['form'])) &&
  (value['workspaceReview'] === undefined || isRecord(value['workspaceReview']) && typeof value['workspaceReview']['open'] === 'boolean' && isUnknownArray(value['workspaceReview']['choices']) && value['workspaceReview']['choices'].every(isRepositoryChoiceDraft)) &&
  (value['figmaReviews'] === undefined || isRecord(value['figmaReviews']) && typeof value['figmaReviews']['open'] === 'string' && isUnknownArray(value['figmaReviews']['entries']) && value['figmaReviews']['entries'].every(isIncomingReviewRecovery)) &&
  (value['stagedFigmaDraft'] === undefined || isDraft(value['stagedFigmaDraft']));
export const isRecoveryRecord = (value: unknown): value is RecoveryRecord => isRecord(value) && typeof value['id'] === 'string' &&
  typeof value['revision'] === 'number' && Number.isSafeInteger(value['revision']) && value['revision'] > 0 && typeof value['updated'] === 'number' &&
  typeof value['name'] === 'string' && isSources(value['files']) && isSources(value['baseline']) && typeof value['folder'] === 'boolean' &&
  (value['github'] === undefined || isSnapshot(value['github'])) && (value['editor'] === undefined || isEditor(value['editor'])) &&
  (value['shared'] === undefined || isSharedRecovery(value['shared'])) &&
  (value['repositoryReview'] === undefined || isRecord(value['repositoryReview']) && isSnapshot(value['repositoryReview']['snapshot']) &&
    isUnknownArray(value['repositoryReview']['choices']) && value['repositoryReview']['choices'].every(isRepositoryChoiceDraft));
export const recoveryExport = (record: RecoveryRecord): string => JSON.stringify({ format: 'token-foundry/recovery', version: 1, record }, null, 2);
export function readRecoveryExport(text: string): RecoveryRecord {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value['format'] !== 'token-foundry/recovery' || value['version'] !== 1 || !isRecoveryRecord(value['record'])) throw new Error('Choose a Foundry recovery copy.');
  return value['record'];
}

export class RecoveryConflict extends Error {
  constructor() { super('This recovery copy changed in another tab. Download your current sources before reopening its latest copy.'); }
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('foundry-recovery', 1);
    request.addEventListener('upgradeneeded', () => { request.result.createObjectStore('work', { keyPath: 'id' }); });
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error ?? new Error('Local recovery storage is unavailable.')));
    request.addEventListener('blocked', () => reject(new Error('Close older Foundry tabs to open local recovery storage.')));
  });
}

/** One IndexedDB transaction commits both the exact sources and their pinned baseline. */
export async function saveRecovery(id: string, expectedRevision: number, work: RecoveryWork): Promise<RecoveryRecord> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('work', 'readwrite');
      const store = transaction.objectStore('work');
      const request = store.get(id);
      const record = { ...work, id, revision: expectedRevision + 1, updated: Date.now() };
      let conflict = false;
      let operationError: unknown;
      request.addEventListener('success', () => {
        const previous: unknown = request.result;
        if (previous !== undefined && (!isRecoveryRecord(previous) || previous.revision !== expectedRevision) || previous === undefined && expectedRevision !== 0) {
          conflict = true; transaction.abort(); return;
        }
        try { store.put(record); }
        catch (failure) { operationError = failure; transaction.abort(); }
      });
      transaction.addEventListener('complete', () => resolve(record));
      transaction.addEventListener('error', () => reject(transaction.error ?? new Error('The local recovery copy could not be saved.')));
      transaction.addEventListener('abort', () => reject(conflict ? new RecoveryConflict() : operationError ?? transaction.error ?? new Error('The local recovery copy could not be saved.')));
    });
  } finally { db.close(); }
}

export async function listRecovery(): Promise<RecoveryRecord[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('work', 'readonly');
      const request = transaction.objectStore('work').getAll();
      request.addEventListener('success', () => {
        const values: unknown = request.result;
        if (!isUnknownArray(values) || !values.every(isRecoveryRecord)) { reject(new Error('A saved recovery copy is invalid. Current work is retained.')); return; }
        resolve(values.toSorted((a, b) => b.updated - a.updated));
      });
      request.addEventListener('error', () => reject(request.error ?? new Error('Saved work could not be read.')));
    });
  } finally { db.close(); }
}

export async function deleteRecovery(id: string): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('work', 'readwrite');
      transaction.objectStore('work').delete(id);
      transaction.addEventListener('complete', () => resolve());
      transaction.addEventListener('error', () => reject(transaction.error ?? new Error('The local recovery copy could not be removed.')));
      transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('The local recovery copy could not be removed.')));
    });
  } finally { db.close(); }
}
