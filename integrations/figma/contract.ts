import { isJsonValue, isRecord, isUnknownArray } from '../../lib/json.ts';
import type { JsonValue } from '../../lib/json.ts';
import { isFigmaEasing, isCubicEasing } from './easing.ts';
import type { FigmaEasing } from './easing.ts';

export interface SourceFile { path: string; text: string }
export interface FigmaColor { r: number; g: number; b: number; a: number }
export type FigmaValue = number | string | boolean | FigmaColor | FigmaEasing;
export interface VariableRow {
  path: string;
  name: string;
  file: string;
  description: string;
  type: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN' | 'TIMING' | 'EASING';
  sourceType: string;
  before: JsonValue;
  value: FigmaValue;
  alias?: string;
  unit?: string;
  editable: boolean;
}
export interface FigmaBundle {
  format: 'token-foundry/figma';
  version: 1;
  name: string;
  revision: string;
  files: SourceFile[];
  variables: VariableRow[];
  unsupported: { path: string; reason: string }[];
}
export interface TokenProposal {
  schemaVersion: 1;
  sourceRevision: string;
  submissionId?: string;
  acknowledgedReceipt?: string;
  workspaceId?: string;
  intentId?: string;
  intentSequence?: number;
  changes: { path: string; before: JsonValue; after: JsonValue }[];
}
export const maximumBytes = 8 * 1024 * 1024;
export function sourceFiles(value: unknown): value is SourceFile[] {
  return isUnknownArray(value) && value.length > 0 && value.length <= 200 && value.every(file =>
    isRecord(file) && typeof file['path'] === 'string' && !!file['path'] && typeof file['text'] === 'string');
}
export function sourceSnapshot(value: unknown): value is { name: string; files: SourceFile[] } {
  return isRecord(value) && typeof value['name'] === 'string' && sourceFiles(value['files']);
}
function compare(a: unknown, b: unknown, nativeFloats: boolean): boolean {
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'number') return nativeFloats ? Math.fround(value) : value;
    if (Array.isArray(value)) return value.map(normalize);
    if (isRecord(value)) return Object.fromEntries(Object.keys(value).toSorted().map(key => [key, normalize(value[key])]));
    return value;
  };
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
export const sameValue = (a: unknown, b: unknown): boolean => compare(a, b, true);
export const sameSourceValue = (a: unknown, b: unknown): boolean => compare(a, b, false);
// Local numbers have already been normalized at the native boundary. Rounding
// them again in source units can hide distinct percentage-variable values.
export const sameLocalValue = (a: unknown, b: unknown): boolean => typeof a === 'number' && typeof b === 'number' ? a === b :
  isFigmaEasing(a) || isFigmaEasing(b) ? sameSourceValue(a, b) : sameValue(a, b);

export function isFigmaValue(value: unknown): value is FigmaValue {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ||
    isFigmaColor(value) || isFigmaEasing(value);
}
export const isFigmaColor = (value: unknown): value is FigmaColor => isRecord(value) && ['r', 'g', 'b', 'a'].every(key => typeof value[key] === 'number' && value[key] >= 0 && value[key] <= 1);
export function matchesVariableType(type: VariableRow['type'], value: unknown): value is FigmaValue {
  return type === 'COLOR' ? isFigmaColor(value) : type === 'EASING' ? isFigmaEasing(value) : type === 'BOOLEAN' ? typeof value === 'boolean' :
    type === 'STRING' ? typeof value === 'string' : typeof value === 'number' && Number.isFinite(value);
}
export function isVariableRow(value: unknown): value is VariableRow {
  return isRecord(value) && ['path', 'name', 'file', 'description', 'sourceType'].every(key => typeof value[key] === 'string') &&
    typeof value['type'] === 'string' && ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN', 'TIMING', 'EASING'].includes(value['type']) && isFigmaValue(value['value']) &&
    (value['type'] !== 'TIMING' || typeof value['value'] === 'number' && value['value'] >= 0 && value['sourceType'] === 'duration' && ['ms', 's'].includes(String(value['unit']))) &&
    (value['type'] !== 'EASING' || value['sourceType'] === 'cubicBezier' && isCubicEasing(value['value'])) &&
    isJsonValue(value['before']) && typeof value['editable'] === 'boolean' &&
    (value['alias'] === undefined || typeof value['alias'] === 'string') && (value['unit'] === undefined || typeof value['unit'] === 'string');
}
export function isBundle(value: unknown): value is FigmaBundle {
  return isRecord(value) && typeof value['name'] === 'string' && sourceFiles(value['files']) && value['format'] === 'token-foundry/figma' && value['version'] === 1 &&
    typeof value['revision'] === 'string' && /^[a-f0-9]{64}$/u.test(value['revision']) &&
    isUnknownArray(value['variables']) && value['variables'].every(isVariableRow) &&
    isUnknownArray(value['unsupported']) && value['unsupported'].every(row => isRecord(row) && typeof row['path'] === 'string' && typeof row['reason'] === 'string');
}
export function isTokenProposal(value: unknown): value is TokenProposal {
  return isRecord(value) && value['schemaVersion'] === 1 && typeof value['sourceRevision'] === 'string' &&
    (value['intentId'] === undefined && value['intentSequence'] === undefined || typeof value['intentId'] === 'string' && /^[a-f0-9]{64}$/u.test(value['intentId']) && typeof value['intentSequence'] === 'number' && Number.isSafeInteger(value['intentSequence']) && value['intentSequence'] > 0) &&
    /^[a-f0-9]{64}$/u.test(value['sourceRevision']) && (value['submissionId'] === undefined || typeof value['submissionId'] === 'string' && /^[a-f0-9]{64}$/u.test(value['submissionId']) && typeof value['acknowledgedReceipt'] === 'string' && typeof value['workspaceId'] === 'string') &&
    (value['acknowledgedReceipt'] === undefined || typeof value['acknowledgedReceipt'] === 'string') && isUnknownArray(value['changes']) &&
    value['changes'].every(row => isRecord(row) && typeof row['path'] === 'string' && isJsonValue(row['before']) && isJsonValue(row['after']));
}
