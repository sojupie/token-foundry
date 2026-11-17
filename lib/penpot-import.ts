import Color from 'colorjs.io';
import { isJsonObject, parseJson, requireObject, requireValue } from './json.ts';
import type { JsonObject, JsonValue } from './json.ts';
import { reviewProposal } from './workspace.ts';
import type { Review, Workspace } from './workspace.ts';

type PenpotToken = { type: string; value: JsonValue };
const typeMap: Readonly<Record<string, readonly string[]>> = {
  color: ['color'], dimension: ['dimension', 'borderRadius', 'spacing', 'sizing', 'fontSizes', 'letterSpacing', 'borderWidth'],
  number: ['number', 'opacity'], fontFamily: ['fontFamilies', 'fontFamily'], fontWeight: ['fontWeights', 'fontWeight'],
  typography: ['typography'],
};
const mapped = (path: string) => path.split('.').map(part => part === '$root' ? 'root' : part).join('.');
const equal = (a: JsonValue, b: JsonValue) => JSON.stringify(a) === JSON.stringify(b);
const alias = (value: JsonValue): value is string => typeof value === 'string' && /^\{[^{}]+\}$/u.test(value);

function readSet(value: JsonObject, prefix = '', output = new Map<string, PenpotToken>()) {
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$')) continue;
    const path = prefix ? prefix + '.' + key : key;
    const object = requireObject(child, path);
    if ('$value' in object) {
      if (output.has(path) || typeof object['$type'] !== 'string' || object['$value'] === undefined) throw new Error('Invalid token: ' + path);
      output.set(path, { type: object['$type'], value: object['$value'] });
    } else readSet(object, path, output);
  }
  return output;
}

export function penpotSets(text: string): string[] {
  const document = requireObject(parseJson(text), 'Penpot export');
  const sets = Object.entries(document).filter(([name, value]) => !name.startsWith('$') && isJsonObject(value))
    .filter(([, value]) => readSet(requireObject(value, 'token set')).size > 0).map(([name]) => name);
  if (!sets.length) throw new Error('No token sets found in this Penpot file.');
  return sets;
}

function scalar(value: JsonValue): string {
  if (typeof value === 'string') return value.replaceAll('$root', 'root');
  if (typeof value === 'number') return String(value);
  if (isJsonObject(value)) {
    if (typeof value['hex'] === 'string') {
      const alpha = value['alpha'];
      return value['hex'] + (typeof alpha === 'number' && alpha < 1 ? Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase() : '');
    }
    if (typeof value['value'] === 'number' && typeof value['unit'] === 'string') {
      return String(value['value']) + (['dp', 'sp'].includes(value['unit']) ? 'px' : value['unit']);
    }
    if (value['colorSpace'] === 'srgb' && Array.isArray(value['components']) && value['components'].length === 3 && value['components'].every(x => typeof x === 'number')) {
      const alpha = value['alpha'];
      return '#' + value['components'].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase() +
        (typeof alpha === 'number' && alpha < 1 ? Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase() : '');
    }
  }
  throw new Error('This token value cannot be compared to a Penpot value.');
}

function external(type: string, value: JsonValue): JsonValue {
  if (type === 'fontFamily') return Array.isArray(value) ? value.map(scalar) : [scalar(value)];
  if (type === 'typography' && isJsonObject(value)) {
    const field = (key: string) => scalar(requireValue(value[key], key));
    return { fontFamilies: [field('fontFamily')], fontSizes: field('fontSize'), fontWeights: field('fontWeight'),
      lineHeights: field('lineHeight'), letterSpacing: field('letterSpacing'), textCase: 'none', textDecoration: 'none' };
  }
  return scalar(value);
}

function toReference(input: JsonValue, paths: ReadonlyMap<string, string>): JsonValue | undefined {
  if (!alias(input)) return undefined;
  const path = input.slice(1, -1);
  const target = paths.get(path);
  if (!target) throw new Error('Reference target is not open: ' + path);
  return '{' + target + '}';
}

function dimension(input: JsonValue, original: JsonValue, resolved: JsonValue | undefined, paths: ReadonlyMap<string, string>): JsonValue {
  const ref = toReference(input, paths); if (ref !== undefined) return ref;
  if (typeof input !== 'string' && typeof input !== 'number') throw new Error('Expected a dimension.');
  const match = /^\s*(-?(?:\d+\.?\d*|\.\d+))(px|rem|dp|sp)?\s*$/u.exec(String(input));
  if (!match) throw new Error('Use a numeric dimension with px or rem.');
  const source = isJsonObject(original) ? original : isJsonObject(resolved) ? resolved : undefined;
  if (alias(original) && !source) throw new Error('Resolve the referenced dimension before importing.');
  const previous = source?.['unit'];
  const supplied = match[2];
  const unit = supplied === 'px' && (previous === 'dp' || previous === 'sp') ? previous : supplied ?? (typeof previous === 'string' ? previous : 'px');
  return { value: Number(match[1]), unit };
}

function convert(type: string, input: JsonValue, original: JsonValue, resolved: JsonValue | undefined, paths: ReadonlyMap<string, string>): JsonValue {
  const ref = toReference(input, paths); if (ref !== undefined) return ref;
  if (type === 'dimension') return dimension(input, original, resolved, paths);
  if (type === 'number' || type === 'fontWeight') {
    if (typeof input !== 'string' && typeof input !== 'number') throw new Error('Expected a number.');
    const raw = String(input).trim();
    const n = Number(raw);
    if (type === 'fontWeight' && typeof input === 'string' && raw && !Number.isFinite(n)) return input;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(raw) || !Number.isFinite(n)) throw new Error('Expected a number.');
    return n;
  }
  if (type === 'fontFamily') {
    const values = Array.isArray(input) ? input : [input];
    if (!values.length || values.some(v => typeof v !== 'string')) throw new Error('Expected a font family.');
    const list = values.map(v => toReference(v, paths) ?? v);
    return Array.isArray(original) ? list : list.length === 1 ? requireValue(list[0], 'font family') : list;
  }
  if (type === 'color') {
    if (typeof input !== 'string') throw new Error('Expected a color.');
    let color: Color;
    try { color = new Color(input).to('srgb'); } catch { throw new Error('Invalid color: ' + input); }
    if (!color.inGamut('srgb') || color.coords.some(x => x === null || !Number.isFinite(x))) throw new Error('Color must fit in sRGB.');
    const components = color.coords.map(Number);
    const hex = '#' + components.map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
    return { colorSpace: 'srgb', components, hex, ...(color.alpha < 1 ? { alpha: color.alpha } : {}) };
  }
  if (type === 'typography' && isJsonObject(input) && isJsonObject(original)) {
    if ((input['textCase'] ?? 'none') !== 'none' || (input['textDecoration'] ?? 'none') !== 'none') throw new Error('Text case and decoration cannot be represented in this typography token.');
    const resolvedObject = isJsonObject(resolved) ? resolved : {};
    const fields: readonly [string, string, string][] = [['fontFamily', 'fontFamilies', 'fontFamily'], ['fontSize', 'fontSizes', 'dimension'],
      ['fontWeight', 'fontWeights', 'fontWeight'], ['lineHeight', 'lineHeights', 'number'], ['letterSpacing', 'letterSpacing', 'dimension']];
    const result: JsonObject = { ...original };
    for (const [key, source, fieldType] of fields) {
      const before = requireValue(original[key], key), next = requireValue(input[source], source);
      const expected = fieldType === 'fontFamily' ? external(fieldType, before) : scalar(before);
      if (!equal(expected, next)) result[key] = convert(fieldType, next, before, resolvedObject[key], paths);
    }
    return result;
  }
  throw new Error('Unsupported token type: ' + type);
}

export function reviewPenpot(workspace: Workspace, text: string, set: string): Review {
  const data = requireObject(parseJson(text), 'Penpot export');
  const imported = readSet(requireObject(data[set], 'token set ' + set));
  const paths = new Map<string, string>();
  for (const path of workspace.graph.tokens.keys()) {
    const name = mapped(path);
    if (paths.has(name)) throw new Error('Two open tokens have the same Penpot name: ' + name);
    paths.set(name, path);
  }
  const unknown = [...imported.keys()].filter(name => !paths.has(name));
  if (unknown.length) throw new Error('These tokens are not open: ' + unknown.slice(0, 10).join(', ') + (unknown.length > 10 ? '…' : ''));
  const changes: { path: string; before: JsonValue; after: JsonValue }[] = [];
  for (const [name, entry] of imported) {
    const path = requireValue(paths.get(name), name), token = requireValue(workspace.graph.tokens.get(path), path);
    const type = requireValue(token.type, path + ' type');
    if (!typeMap[type]?.includes(entry.type)) throw new Error('Token type differs for ' + name + ': ' + entry.type + '.');
    let before = token.value;
    try {
      if (equal(external(type, before), entry.value)) continue;
      const after = convert(type, entry.value, before, workspace.graph.resolved.get(path), paths);
      if (!equal(before, after)) changes.push({ path, before, after });
    } catch (error: unknown) { throw new Error(name + ': ' + (error instanceof Error ? error.message : 'Invalid value.'), { cause: error }); }
  }
  if (!changes.length) throw new Error('No token values changed.');
  return reviewProposal(workspace, JSON.stringify({ schemaVersion: 1, changes }));
}
