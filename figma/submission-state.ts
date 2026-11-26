import { deviceFileScope } from './connection.ts';
import type { ConnectionStorage } from './connection.ts';
import { isRecord } from '../lib/json.ts';
import { hashSubmissionText, isOlderReceipt } from '../integrations/figma/submission.ts';
import type { LocalValue } from '../integrations/figma/merge.ts';

interface SubmissionState { version: 1; nonce: string; counter: number; fingerprint: string; receipts: Record<string, string> }
const valid = (value: unknown): value is SubmissionState => isRecord(value) && value['version'] === 1 && typeof value['nonce'] === 'string' &&
  typeof value['counter'] === 'number' && Number.isSafeInteger(value['counter']) && value['counter'] >= 0 && typeof value['fingerprint'] === 'string' &&
  isRecord(value['receipts']) && Object.values(value['receipts']).every(receipt => typeof receipt === 'string');
function newest(previous: string, incoming: string) {
  if (!incoming) return previous;
  return isOlderReceipt(incoming, previous) ? previous : incoming;
}

/** Device storage stays outside document Undo; only observed native changes advance the intent. */
export async function observeSubmission(figma: ConnectionStorage, revision: string, values: ReadonlyMap<string, LocalValue>, workspace: string, receipt: string, trustedReceipt: boolean) {
  const scope = await deviceFileScope(figma, true);
  if (!scope) throw new Error('Reopen this file before sending native changes.');
  const key = 'foundry-submission:' + scope.lookup + ':' + (scope.fileKey ?? scope.collection ?? 'local');
  const stored = await figma.clientStorage.getAsync(key);
  if (stored !== undefined && !valid(stored)) throw new Error('The device submission record is damaged. Your native values are retained.');
  const previous: SubmissionState = valid(stored) ? stored : { version: 1, nonce: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), counter: 0, fingerprint: '', receipts: {} };
  const fingerprint = hashSubmissionText(JSON.stringify([revision, [...values].toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)]));
  const consumed = workspace ? trustedReceipt ? newest(previous.receipts[workspace] ?? '', receipt) : previous.receipts[workspace] ?? receipt : receipt;
  const next: SubmissionState = { ...previous, fingerprint, counter: previous.counter + (previous.fingerprint === fingerprint ? 0 : 1),
    receipts: workspace && trustedReceipt ? { ...previous.receipts, [workspace]: consumed } : previous.receipts };
  if (!Number.isSafeInteger(next.counter)) throw new Error('The device submission sequence is exhausted. Your native values are retained.');
  if (JSON.stringify(previous) !== JSON.stringify(next) || stored === undefined) await figma.clientStorage.setAsync(key, next);
  return { intentId: hashSubmissionText(next.nonce), intentSequence: next.counter, receipt: consumed };
}
