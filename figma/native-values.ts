import type { FigmaValue, VariableRow } from '../integrations/figma/contract.ts';
import { isFigmaValue, sameValue } from '../integrations/figma/contract.ts';
import { isRecord } from '../lib/json.ts';
import { isCubicEasing, easingPoints } from '../integrations/figma/easing.ts';

type NativeValue = FigmaValue | { type: 'VARIABLE_ALIAS'; id: string } | { r: number; g: number; b: number };
interface NativeVariable {
  readonly resolvedType?: string;
  valuesByMode: Readonly<Record<string, unknown>>;
  getPluginData: (key: string) => string;
  setPluginData: (key: string, value: string) => void;
  setValueForMode: (mode: string, value: NativeValue) => void;
}
const scaleKey = 'foundry-value-scale';
const pendingKey = 'foundry-value-scale-pending';
const isNative = (value: unknown): value is NativeValue => isFigmaValue(value) || isRecord(value) && (value['type'] === 'VARIABLE_ALIAS' && typeof value['id'] === 'string' || ['r', 'g', 'b'].every(key => typeof value[key] === 'number' && value[key] >= 0 && value[key] <= 1));
const validScale = (value: unknown): value is number => value === 1 || value === 100 || value === 0.001;
interface PendingScale { beforeScale: number; afterScale: number; before: NativeValue; after: NativeValue }
function pendingScale(variable: NativeVariable): PendingScale | undefined {
  const pending = variable.getPluginData(pendingKey);
  if (!pending) return undefined;
  const value: unknown = JSON.parse(pending);
  if (!isRecord(value) || !validScale(value['beforeScale']) || !validScale(value['afterScale']) || !isNative(value['before']) || !isNative(value['after'])) throw new Error('The saved native unit migration is damaged. Restore the matching file version.');
  return { beforeScale: value['beforeScale'], afterScale: value['afterScale'], before: value['before'], after: value['after'] };
}
export interface NativeUnitConflict { path: string; current: number; before: number; beforeScale: number; afterScale: number }
export const isNativeUnitConflict = (value: unknown): value is NativeUnitConflict => isRecord(value) && typeof value['path'] === 'string' &&
  typeof value['current'] === 'number' && Number.isFinite(value['current']) && typeof value['before'] === 'number' && Number.isFinite(value['before']) && validScale(value['beforeScale']) && validScale(value['afterScale']);
export function nativeUnitConflict(variable: NativeVariable, mode: string, row?: VariableRow): Omit<NativeUnitConflict, 'path'> | undefined {
  const pending = pendingScale(variable);
  if (variable.resolvedType === 'TIMING') return undefined;
  const current = variable.valuesByMode[mode];
  if (!pending || sameValue(current, pending.before) || sameValue(current, pending.after)) return undefined;
  if (typeof current !== 'number' || typeof pending.before !== 'number') throw new Error('The native unit migration contains an unsupported conflict.');
  return { current, before: sourceNumeric(pending.before, pending.beforeScale, row), beforeScale: pending.beforeScale, afterScale: pending.afterScale };
}

export function nativeScale(variable: NativeVariable, mode: string): number {
  const pending = pendingScale(variable);
  if (pending) {
    if (variable.resolvedType === 'TIMING') return pending.afterScale;
    const current = variable.valuesByMode[mode];
    if (sameValue(current, pending.after)) return pending.afterScale;
    if (sameValue(current, pending.before)) return pending.beforeScale;
    throw new Error('A variable changed during an interrupted native unit migration. Its value has been retained; choose its units in the plugin before resuming.');
  }
  const stored = variable.getPluginData(scaleKey);
  if (!stored || stored === '1') return 1;
  if (validScale(Number(stored))) return Number(stored);
  throw new Error('The saved native unit mapping is invalid.');
}

export function resolveNativeUnit(variable: NativeVariable, mode: string, expected: number, value: number, scale: number) {
  if (!nativeUnitConflict(variable, mode) || !sameValue(variable.valuesByMode[mode], expected)) throw new Error('The Figma value changed during unit review. Refresh Figma to review it again.');
  if (!validScale(scale) || !Number.isFinite(value) || !Number.isFinite(value * scale)) throw new Error('The chosen native number is invalid.');
  // The explicit choice makes the current units known. Journal that choice
  // before completing either write so a second interruption is recoverable.
  variable.setPluginData(pendingKey, JSON.stringify({ before: expected, after: value * scale, beforeScale: scale, afterScale: scale }));
  writeNative(variable, mode, value, scale);
}

export function sourceNumber(variable: NativeVariable, mode: string, row?: VariableRow): number | undefined {
  const current = variable.valuesByMode[mode];
  if (typeof current !== 'number') return undefined;
  if (row?.type === 'TIMING') return sourceDuration(current, row);
  const scale = nativeScale(variable, mode);
  return sourceNumeric(current, scale, row);
}

export function sourceDuration(seconds: number, row: VariableRow): number {
  return sourceNumeric(seconds, row.unit === 'ms' ? 0.001 : 1, row);
}

export function sourceNumeric(current: number, scale: number, row?: VariableRow): number {
  // Compare in native units before dividing. This retains exact authored
  // precision when Figma stores the scaled number at float32 precision.
  if (row && typeof row.value === 'number' && sameValue(current, row.value * scale)) return row.value;
  const normalized = current / scale;
  if (Math.fround(current) === current) {
    // Choose the shortest source value that reproduces this exact native
    // float. Adjacent native floats remain distinct; an authored value wins above.
    for (let precision = 1; precision <= 17; precision++) {
      const candidate = Number(normalized.toPrecision(precision));
      if (Math.fround(candidate * scale) === current) return candidate;
    }
  }
  return normalized;
}

export function writeNative(variable: NativeVariable, mode: string, value: NativeValue, scale: number) {
  if (!validScale(scale)) throw new Error('Unsupported native number scale.');
  const beforeScale = variable.resolvedType === 'TIMING' && !variable.getPluginData(scaleKey) && !variable.getPluginData(pendingKey) ? scale : nativeScale(variable, mode);
  const native = typeof value === 'number' ? value * scale : value;
  if (typeof native === 'number' && !Number.isFinite(Math.fround(native))) throw new Error('This value exceeds the current native number range.');
  if (isCubicEasing(native) && easingPoints(native).some(point => !Number.isFinite(Math.fround(point)))) throw new Error('The cubic Bézier control points exceed the current native number range.');
  const before = variable.valuesByMode[mode];
  // The journal disambiguates both sides of a crash between native-value and
  // metadata writes. Existing variable IDs and aliases are retained.
  if (before !== undefined && (beforeScale !== scale || variable.getPluginData(pendingKey))) {
    if (!isNative(before)) throw new Error('Cannot migrate an unsupported native value.');
    variable.setPluginData(pendingKey, JSON.stringify({ before, after: native, beforeScale, afterScale: scale }));
  }
  if (!sameValue(before, native)) variable.setValueForMode(mode, native);
  variable.setPluginData(scaleKey, String(scale));
  variable.setPluginData(pendingKey, '');
}
