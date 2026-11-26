import type { TokenProposal } from './contract.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import type { FigmaAcknowledgement } from './merge.ts';

export function hashSubmissionText(text: string) {
  const bytes = new Uint8Array(text.length * 2);
  // Code-unit bytes avoid relying on TextEncoder in the native plugin sandbox.
  for (let index = 0; index < text.length; index++) { const code = text.charCodeAt(index); bytes[index * 2] = code & 255; bytes[index * 2 + 1] = code >>> 8; }
  return [...sha256(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Receipt suffixes use the workspace's monotonic, safe-integer state version. */
export function isOlderReceipt(incoming: string, current: string) {
  const offered = Number(/:(\d+)$/u.exec(incoming)?.[1]); const consumed = Number(/:(\d+)$/u.exec(current)?.[1]);
  return Number.isSafeInteger(offered) && Number.isSafeInteger(consumed) && offered < consumed;
}

/** Retries keep their durable native intent; returning to an earlier value creates another intent. */
export async function identifySubmission(proposal: TokenProposal, acknowledgedReceipt = '', workspaceId = '', intentId = proposal.intentId, intentSequence = proposal.intentSequence): Promise<TokenProposal> {
  const raw: TokenProposal = { schemaVersion: 1, sourceRevision: proposal.sourceRevision, changes: proposal.changes, ...(intentId && intentSequence ? { intentId, intentSequence } : {}) };
  const submissionId = hashSubmissionText(JSON.stringify([workspaceId, raw, acknowledgedReceipt]));
  return { ...raw, submissionId, acknowledgedReceipt, workspaceId };
}

export function submissionReceipt(proposal: TokenProposal, receipt?: FigmaAcknowledgement): FigmaAcknowledgement | undefined {
  if (!proposal.submissionId || !receipt) return receipt;
  return proposal.acknowledgedReceipt !== receipt.id && proposal.acknowledgedReceipt === (receipt.previousReceipt ?? '') ? receipt : undefined;
}
