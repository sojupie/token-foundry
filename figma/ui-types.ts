import { isLocalValue, type LocalValue, type PullConflict } from '../integrations/figma/merge.ts';
import type { ConflictDraft } from '../integrations/figma/recovery.ts';
import { isConflictDraft } from '../integrations/figma/recovery.ts';
import { easingPoints, isCubicEasing } from '../integrations/figma/easing.ts';
import { isFigmaColor, type FigmaBundle, type FigmaValue, type TokenProposal, type VariableRow } from '../integrations/figma/contract.ts';
import type { parseConnection } from '../integrations/figma/transport.ts';
import { isRecord, isUnknownArray } from '../lib/json.ts';

export const DEFAULT_FOUNDRY_ORIGIN = 'https://sevan.tokenfoundry.lindstruct.com';

export type PluginView = 'tokens' | 'changes' | 'workspace';

export interface SelectionBinding {
  field: string;
  path: string;
  remote: boolean;
}

export interface SelectionNode {
  id: string;
  name: string;
  type: string;
  tokens: SelectionBinding[];
}

export interface FileContext {
  id: string;
  name: string;
  fileKey: string;
  selection: SelectionNode[];
}

export interface NativeSnapshot {
  bundle?: FigmaBundle;
  local: ReadonlyMap<string, unknown>;
  changed: number;
  recovery: boolean;
  issue?: string;
  units: number;
  acknowledgedReceipt: string;
  intentId?: string;
  intentSequence?: number;
}

export interface PluginWorkspace {
  id: string;
  name: string;
  role: 'library' | 'concept';
  repository?: string;
  pullRequest?: string;
  dirty?: boolean;
  version?: number;
}

export interface ServerConflictReview {
  proposal: TokenProposal;
  current: FigmaBundle;
  conflicts: PullConflict[];
  drafts: ConflictDraft[];
  updated: boolean;
}

export interface PullReviewState {
  id: string;
  incoming: FigmaBundle;
  local: ReadonlyMap<string, LocalValue>;
  desired?: ReadonlyMap<string, LocalValue>;
}

export interface SourceConnectionPrompt {
  data: unknown;
  target: ReturnType<typeof parseConnection>;
  name: string;
  count: number;
  generation: number;
}

export class ConnectionError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const randomToken = () =>
  [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export const displayValue = (value: unknown): string =>
  isRecord(value) && typeof value['alias'] === 'string'
    ? `{${value['alias']}}`
    : isCubicEasing(value)
      ? JSON.stringify(easingPoints(value))
      : typeof value === 'string'
        ? value
        : JSON.stringify(value) ?? '';

export const isConflict = (value: unknown): value is PullConflict =>
  isRecord(value) &&
  typeof value['path'] === 'string' &&
  isLocalValue(value['before']) &&
  isLocalValue(value['local']) &&
  (value['remote'] === null || isLocalValue(value['remote'])) &&
  ['beforeUnit', 'remoteUnit'].every(key => value[key] === undefined || typeof value[key] === 'string');

export const retryableConnectionError = (error: unknown) =>
  error instanceof ConnectionError
    ? error.status >= 500 || error.status === 429
    : error instanceof TypeError || (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name));

export const reviewDrafts = (value: unknown): ConflictDraft[] =>
  isUnknownArray(value) && value.every(isConflictDraft) ? value : [];

export function workspaceIdentity(summary: unknown, documentId: string): PluginWorkspace | undefined {
  if (!isRecord(summary)) return undefined;
  if (summary['document'] !== documentId) {
    throw new Error('This connection belongs to another Figma file. Connect this file from its own plugin window.');
  }
  if (typeof summary['id'] !== 'string' || !/^[a-f0-9]{64}$/u.test(summary['id']) || typeof summary['name'] !== 'string') {
    throw new Error('The workspace response was incomplete.');
  }
  return {
    id: summary['id'],
    name: summary['name'],
    role: summary['role'] === 'concept' ? 'concept' : 'library',
    ...(typeof summary['version'] === 'number' && Number.isSafeInteger(summary['version']) && summary['version'] >= 0 ? { version: summary['version'] } : {}),
    ...(typeof summary['repository'] === 'string' ? { repository: summary['repository'] } : {}),
    ...(typeof summary['pullRequest'] === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/u.test(summary['pullRequest']) ? { pullRequest: summary['pullRequest'] } : {}),
    ...(typeof summary['dirty'] === 'boolean' ? { dirty: summary['dirty'] } : {}),
  };
}

export async function remoteRequest(target: ReturnType<typeof parseConnection>, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await fetch(target.url, {
    method,
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: 'Bearer ' + target.secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json().catch(() => {
    throw new ConnectionError(502, 'Foundry returned an incomplete response.');
  });
  if (!response.ok) {
    throw new ConnectionError(
      response.status,
      isRecord(data) && typeof data['message'] === 'string' ? data['message'] : 'Foundry is unavailable.',
      isRecord(data) && typeof data['code'] === 'string' ? data['code'] : undefined,
    );
  }
  return data;
}

export function rgbHex(value: unknown): string {
  if (!isFigmaColor(value)) return '#000000';
  return '#' + [value.r, value.g, value.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

export function mergeHexWithAlpha(sixDigitHex: string, existingText: string): string {
  const clean = /^#[a-f0-9]{6}$/iu.test(sixDigitHex) ? sixDigitHex.toLowerCase() : '#000000';
  const existingAlpha = /^#[a-f0-9]{6}([a-f0-9]{2})$/iu.exec(existingText.trim())?.[1];
  return clean + (existingAlpha ? existingAlpha.toLowerCase() : 'ff');
}

const KNOWN_GROUP_LABELS: Readonly<Record<string, string>> = {
  sys: 'System',
  comp: 'Components',
  ref: 'Reference',
};

export function deriveTokenGroups(rows: readonly VariableRow[]): { key: string; label: string; segmentIndex: number }[] {
  if (!rows.length) return [];
  const firstParts = rows.map(row => row.path.split('.'));
  const sharePrefix = firstParts.every(parts => parts.length >= 2 && parts[0] === firstParts[0]?.[0]);
  const segmentIndex = sharePrefix ? 1 : 0;
  const seen = new Set<string>();
  const groups: { key: string; label: string; segmentIndex: number }[] = [];
  for (const parts of firstParts) {
    const key = parts[segmentIndex] ?? '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = KNOWN_GROUP_LABELS[key] ?? (key.slice(0, 1).toUpperCase() + key.slice(1));
    groups.push({ key, label, segmentIndex });
  }
  return groups;
}

export function hex(value: unknown): string {
  if (!isFigmaColor(value)) return displayValue(value);
  return '#' + [value.r, value.g, value.b, value.a].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

export function parseColor(value: string): FigmaValue {
  if (!/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/iu.test(value)) throw new Error('Enter a color as #RRGGBB or #RRGGBBAA.');
  const channels = [1, 3, 5, 7].map(offset => (offset === 7 && value.length === 7 ? 1 : Number.parseInt(value.slice(offset, offset + 2), 16) / 255));
  return { r: channels[0] ?? 0, g: channels[1] ?? 0, b: channels[2] ?? 0, a: channels[3] ?? 1 };
}

export function syncFigmaTheme(): () => void {
  const darkMedia = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    const root = document.documentElement;
    const isDark = root.classList.contains('figma-dark') || (!root.classList.contains('figma-light') && darkMedia.matches);
    root.dataset['theme'] = isDark ? 'dark' : 'light';
    root.dataset['contrast'] = 'default';
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  darkMedia.addEventListener('change', apply);
  return () => {
    observer.disconnect();
    darkMedia.removeEventListener('change', apply);
  };
}
