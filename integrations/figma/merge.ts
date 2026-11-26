import { isFigmaValue, isFigmaColor, matchesVariableType, sameSourceValue, sameLocalValue, sameValue } from './contract.ts';
import { isCubicEasing, easingPoints } from './easing.ts';
import type { FigmaBundle, FigmaValue, TokenProposal, VariableRow } from './contract.ts';
import type { JsonValue } from '../../lib/json.ts';
import { isJsonObject, isJsonValue, isRecord, isUnknownArray } from '../../lib/json.ts';

export type LocalValue = FigmaValue | { alias: string };
export interface PullConflict { path: string; before: LocalValue; local: LocalValue; remote: LocalValue | null; beforeUnit?: string; remoteUnit?: string }
export interface PullChoice { path: string; value: LocalValue | null }
export const isPullConflict = (value: unknown): value is PullConflict => isRecord(value) && typeof value['path'] === 'string' && isLocalValue(value['before']) && isLocalValue(value['local']) && (value['remote'] === null || isLocalValue(value['remote'])) &&
  (value['beforeUnit'] === undefined || typeof value['beforeUnit'] === 'string') && (value['remoteUnit'] === undefined || typeof value['remoteUnit'] === 'string');
export interface FigmaAcknowledgement { id: string; sourceRevision: string; submissionId?: string; previousReceipt?: string; values: { path: string; value: LocalValue }[] }
export const isLocalValue = (value: unknown): value is LocalValue => isFigmaValue(value) || isRecord(value) && typeof value['alias'] === 'string';
export const isPullChoice = (value: unknown): value is PullChoice => isRecord(value) && typeof value['path'] === 'string' && (value['value'] === null || isLocalValue(value['value']));
export const isAcknowledgement = (value: unknown): value is FigmaAcknowledgement => isRecord(value) && typeof value['id'] === 'string' &&
  (value['submissionId'] === undefined || typeof value['submissionId'] === 'string' && /^[a-f0-9]{64}$/u.test(value['submissionId']) && typeof value['previousReceipt'] === 'string') &&
  typeof value['sourceRevision'] === 'string' && isUnknownArray(value['values']) && value['values'].every(row => isRecord(row) && typeof row['path'] === 'string' && isLocalValue(row['value']));
export const importedValue = (row: VariableRow): LocalValue => row.alias ? { alias: row.alias } : row.value;

/** Acknowledge only the exact submitted edits; edits made after submission still require a merge. */
export function acknowledgeValues(previous: FigmaBundle | undefined, local: ReadonlyMap<string, LocalValue>, receipt?: FigmaAcknowledgement): ReadonlyMap<string, LocalValue> {
  if (!previous || receipt?.sourceRevision !== previous.revision) return local;
  const rows = new Map(previous.variables.map(row => [row.path, row]));
  const values = new Map(local);
  for (const item of receipt.values) {
    const row = rows.get(item.path);
    if (row && sameLocalValue(local.get(item.path), item.value)) values.set(item.path, importedValue(row));
  }
  return values;
}

/** A later local edit follows our acknowledged value. If another author has
 * since changed it, even an undo back to the old source is a real local edit. */
export function acknowledgedPull(previous: FigmaBundle | undefined, incoming: FigmaBundle, local: ReadonlyMap<string, LocalValue>, receipt?: FigmaAcknowledgement) {
  const acknowledged = acknowledgeValues(previous, local, receipt);
  if (!previous || receipt?.sourceRevision !== previous.revision) return { previous, local: acknowledged };
  const effective = new Map(acknowledged);
  const accepted = new Map(receipt.values.map(item => [item.path, item.value]));
  const current = new Map(incoming.variables.map(row => [row.path, row]));
  const variables = previous.variables.map(row => {
    const next = current.get(row.path); const submitted = accepted.get(row.path);
    if (submitted === undefined) return row;
    const value = local.get(row.path);
    if (next && row.file === next.file && row.type === next.type && row.sourceType === next.sourceType && row.unit === next.unit && row.editable === next.editable && sameLocalValue(importedValue(next), submitted)) {
      if (value !== undefined) effective.set(row.path, value);
      return next;
    }
    if (value === undefined || sameLocalValue(value, submitted)) return row;
    if (typeof submitted === 'object' && 'alias' in submitted) return { ...row, alias: submitted.alias };
    const { alias, ...literal } = row; void alias;
    return { ...literal, value: submitted };
  });
  return { previous: { ...previous, variables }, local: effective };
}

export function pullConflicts(previous: FigmaBundle | undefined, incoming: FigmaBundle, local: ReadonlyMap<string, LocalValue>): PullConflict[] {
  const remote = new Map(incoming.variables.map(row => [row.path, row]));
  return previous?.variables.flatMap(row => {
    const current = local.get(row.path);
    const next = remote.get(row.path);
    if (current === undefined || sameLocalValue(current, importedValue(row)) || next && sameLocalValue(current, importedValue(next))) return [];
    // A locally edited token can survive a pull when its source mapping and incoming value are unchanged.
    if (next && sameLocalValue(importedValue(row), importedValue(next)) && sameSourceValue(row.before, next.before)) return [];
    return [{ path: row.path, before: importedValue(row), local: current, remote: next ? importedValue(next) : null,
      ...(row.unit ? { beforeUnit: row.unit } : {}), ...(next?.unit ? { remoteUnit: next.unit } : {}) }];
  }) ?? [];
}

/** Advance to incoming source while retaining independent edits and explicit conflict choices. */
export function pullValues(previous: FigmaBundle | undefined, incoming: FigmaBundle, local: ReadonlyMap<string, LocalValue>, choices: readonly PullChoice[] = []): Map<string, LocalValue> {
  const conflicts = pullConflicts(previous, incoming, local);
  const selected = new Map(choices.map(choice => [choice.path, choice.value]));
  if (selected.size !== choices.length || choices.some(choice => !conflicts.some(conflict => conflict.path === choice.path))) throw new Error('The conflict choices do not match this pull.');
  if (conflicts.some(conflict => !selected.has(conflict.path))) throw new Error('Choose a value for every conflicting token.');
  const before = new Map(previous?.variables.map(row => [row.path, row]) ?? []);
  const incomingRows = new Map(incoming.variables.map(row => [row.path, row]));
  const values = new Map<string, LocalValue>();
  for (const row of incoming.variables) {
    const old = before.get(row.path);
    const current = local.get(row.path);
    const chosen = selected.get(row.path);
    const next = selected.has(row.path) ? chosen : old && current !== undefined &&
      !sameLocalValue(current, importedValue(old)) && sameLocalValue(importedValue(old), importedValue(row)) && sameSourceValue(old.before, row.before)
      ? current : importedValue(row);
    if (next === null || next === undefined) throw new Error('Choose a value for ' + row.path + '.');
    if (typeof next === 'object' && 'alias' in next) {
      if (incomingRows.get(next.alias)?.type !== row.type) throw new Error('Choose a compatible alias target for ' + row.path + '.');
    } else if (!matchesVariableType(row.type, next)) {
      throw new Error('The chosen value has the wrong type for ' + row.path + '.');
    }
    if (row.type === 'TIMING' && typeof next === 'number' && next < 0) throw new Error('Duration cannot be negative: ' + row.path + '.');
    if (old && !sameLocalValue(next, importedValue(row)) && (old.sourceType !== row.sourceType || old.unit !== row.unit)) throw new Error('The source type or unit changed for ' + row.path + '. Use its source value, then edit the new mapping.');
    values.set(row.path, next);
  }
  for (const conflict of conflicts) if (conflict.remote === null && selected.get(conflict.path) !== null) {
    throw new Error('The source no longer maps ' + conflict.path + '. Restore its source token in Foundry before keeping this edit.');
  }
  // Check the whole resulting graph: a locally changed alias can cycle through a remote edit.
  const visited = new Set<string>();
  for (const path of values.keys()) {
    const chain = new Set<string>();
    let current: string | undefined = path;
    while (current !== undefined && !visited.has(current)) {
      if (chain.has(current)) throw new Error('The chosen values create a circular reference at ' + current + '.');
      chain.add(current);
      const value: LocalValue | undefined = values.get(current);
      current = typeof value === 'object' && 'alias' in value ? value.alias : undefined;
    }
    for (const item of chain) visited.add(item);
  }
  // Reject retained edits whose source mapping is read-only, before any native mutation.
  changedValues(incoming, values);
  return values;
}

export function changedValues(bundle: FigmaBundle, local: ReadonlyMap<string, LocalValue>): TokenProposal {
  const paths = new Map(bundle.variables.map(row => [row.path, row]));
  const changes: TokenProposal['changes'] = [];
  for (const row of bundle.variables) {
    const current = local.get(row.path);
    if (current === undefined) throw new Error('A managed variable is missing: ' + row.path + '. Restore it before syncing.');
    if (sameLocalValue(current, importedValue(row))) continue;
    if (!row.editable) throw new Error('This source mapping is read-only: ' + row.path + '.');
    if (row.type === 'TIMING' && !(typeof current === 'object' && 'alias' in current) && (typeof current !== 'number' || current < 0)) throw new Error('Enter a non-negative duration for ' + row.path + '.');
    let after: JsonValue;
    if (typeof current === 'object' && 'alias' in current) {
      if (paths.get(current.alias)?.type !== row.type) throw new Error('The alias target is not in this snapshot: ' + row.path + '.');
      after = '{' + current.alias + '}';
    } else if (row.type === 'EASING') {
      if (!isCubicEasing(current)) throw new Error('The native easing for ' + row.path + ' has no cubic Bézier mapping. Use source control points or choose a custom cubic curve.');
      after = easingPoints(current);
    } else if (row.type === 'COLOR' && isFigmaColor(current)) {
      const original = isJsonObject(row.before) ? row.before : {};
      const projected = isFigmaColor(row.value) ? row.value : undefined;
      const channels = ['r', 'g', 'b'] as const;
      const components = Array.isArray(original['components']) ? original['components'] : [];
      const retained = channels.map((key, index) => projected && sameValue(current[key], projected[key]) ? typeof components[index] === 'number' ? components[index] : projected[key] : current[key]);
      const alpha = projected && sameValue(current.a, projected.a) ? typeof original['alpha'] === 'number' ? original['alpha'] : projected.a : current.a;
      const rgbChanged = !projected || channels.some(key => !sameValue(current[key], projected[key]));
      const hex = '#' + [current.r, current.g, current.b].map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
      after = { ...original, colorSpace: 'srgb', components: retained,
        ...(alpha !== 1 || original['alpha'] !== undefined ? { alpha } : {}),
        ...(original['hex'] !== undefined && rgbChanged ? { hex } : {}) };
    } else if (typeof current === 'number' && row.unit) after = { ...(isJsonObject(row.before) ? row.before : {}), value: current, unit: row.unit };
    else if (isJsonValue(current)) after = current;
    else throw new Error('The native value has no source mapping: ' + row.path + '.');
    changes.push({ path: row.path, before: row.before, after });
  }
  return { schemaVersion: 1, sourceRevision: bundle.revision, changes };
}
