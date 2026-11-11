import { errorMessage, isJsonObject as isObject, requireValue } from './json.ts';
import type { JsonObject, JsonValue } from './json.ts';
import { isTokenNode } from './token-types.ts';
import type { TokenChange, TokenFile, TokenNode } from './token-types.ts';

export interface TokenEntry { type: string | undefined; node: TokenNode; file: string; value: JsonValue }
interface Group {
  files: Map<string, string | undefined>;
  members: Set<string>;
  children: string[];
  start: number;
  end: number;
  type: string | undefined;
}

const isReference = (value: JsonValue): value is string => typeof value === 'string' && /^\{[^{}]+\}$/u.test(value);
export const parentPath = (path: string) => path.split('.').slice(0, -1).join('.');
export const leafName = (path: string) => path.slice(path.lastIndexOf('.') + 1);

export function nodeAt(tree: JsonObject, path: string): JsonValue | undefined {
  return path ? path.split('.').reduce<JsonValue | undefined>((node, key) =>
    isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined, tree) : tree;
}

export function inspectDocument(tree: JsonObject) {
  return inspectDocuments([{ path: '', tree }]);
}

export function inspectDocuments(files: readonly TokenFile[]) {
  const tokens = new Map<string, TokenEntry>();
  const groups = new Map<string, Group>();
  const resolved = new Map<string, JsonValue>();
  const dependencies = new Map<string, Set<string>>();
  const usedBy = new Map<string, Set<string>>();
  const issues = new Map<string, string>();
  let extendedGroups = 0;

  function collect(node: JsonValue | undefined, path: string, inheritedType: string | undefined, file: string) {
    if (!isTokenNode(node)) throw new Error('Expected a token or group at ' + (path || file) + '.');
    const type = node.$type ?? inheritedType;
    if (Object.hasOwn(node, '$value') || (Object.hasOwn(node, '$ref') && !Object.keys(node).some((key) => !key.startsWith('$') || key === '$root'))) {
      if (!path) throw new Error('Expected a token tree in ' + (file || 'the JSON document') + '.');
      if (groups.has(path) || tokens.has(path)) {
        const existing = tokens.get(path)?.file ?? [...requireValue(groups.get(path), 'group ' + path).files.keys()][0];
        throw new Error('Duplicate token path ' + path + ' in ' + existing + ' and ' + file + '.');
      }
      tokens.set(path, { type, node, file, value: node.$value !== undefined ? node.$value : { $ref: requireValue(node.$ref, 'token reference') } });
      return;
    }
    if (tokens.has(path)) throw new Error('A token in ' + requireValue(tokens.get(path), 'token ' + path).file + ' conflicts with group ' + path + ' in ' + file + '.');
    if (Object.hasOwn(node, '$extends')) extendedGroups++;
    if (!groups.has(path)) groups.set(path, { files: new Map(), members: new Set(), children: [], start: 0, end: 0, type: undefined });
    const group = requireValue(groups.get(path), 'group ' + path);
    group.files.set(file, type);
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') && key !== '$root') continue;
      if (/[.{}]/u.test(key)) throw new Error('Invalid token or group name: ' + key);
      const childPath = path ? path + '.' + key : key;
      collect(child, childPath, type, file);
      group.members.add(childPath);
    }
  }

  const rows: [string, TokenEntry][] = [];
  function indexGroup(path: string) {
    const group = requireValue(groups.get(path), 'group ' + path);
    group.start = rows.length;
    const types = new Set(group.files.values());
    group.type = types.size === 1 ? types.values().next().value : undefined;
    for (const child of group.members) {
      if (tokens.has(child)) rows.push([child, requireValue(tokens.get(child), 'token ' + child)]);
      else {
        group.children.push(child);
        indexGroup(child);
      }
    }
    group.end = rows.length;
  }

  function reference(owner: string, path: string): JsonValue {
    const root = path + '.$root';
    if (!tokens.has(path) && tokens.has(root)) throw new Error('Reference points to a group. Use {' + root + '} to reference its root token.');
    if (!dependencies.has(owner)) dependencies.set(owner, new Set());
    if (!usedBy.has(path)) usedBy.set(path, new Set());
    requireValue(dependencies.get(owner), 'dependencies').add(path);
    requireValue(usedBy.get(path), 'reverse dependencies').add(owner);
    return resolve(path);
  }

  function pointer(ref: JsonValue | undefined, owner: string): JsonValue {
    if (typeof ref !== 'string' || !ref.includes('#/')) throw new Error('Expected a JSON Pointer to a token value.');
    const separator = ref.indexOf('#/');
    const referenceFile = ref.slice(0, separator);
    const ownerFile = requireValue(tokens.get(owner), 'token ' + owner).file;
    const file = referenceFile ? resolveFile(ownerFile, decodeURIComponent(referenceFile)) : ownerFile;
    const parts = decodeURIComponent(ref.slice(separator + 2)).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const valueIndex = parts.indexOf('$value');
    const path = parts.slice(0, valueIndex < 0 ? parts.length : valueIndex).join('.');
    if (tokens.get(path)?.file === file) {
      let result = reference(owner, path);
      for (const key of parts.slice(valueIndex < 0 ? parts.length : valueIndex + 1)) {
        const next = Array.isArray(result) && /^(0|[1-9][0-9]*)$/u.test(key) ? result[Number(key)] :
          isObject(result) && Object.hasOwn(result, key) ? result[key] : undefined;
        if (next === undefined) throw new Error('Pointer target is missing: ' + ref);
        result = next;
      }
      return result;
    }
    throw new Error('Pointer target is missing: ' + ref);
  }

  const active = new Set<string>();
  function resolve(path: string): JsonValue {
    const cached = resolved.get(path);
    if (cached !== undefined) return cached;
    if (issues.has(path)) throw new Error(issues.get(path));
    if (!tokens.has(path)) throw new Error('Reference target is missing: ' + path);
    if (active.has(path)) throw new Error('Circular reference: ' + path);
    active.add(path);
    try {
      const token = requireValue(tokens.get(path), 'token ' + path);
      if (token.type && isReference(token.value)) {
        const target = tokens.get(token.value.slice(1, -1));
        if (target?.type && token.type !== target.type) throw new Error('Expected a ' + token.type + ' reference, found ' + target.type + '.');
      }
      const result = resolveValue(token.value, path);
      resolved.set(path, result);
      return result;
    } catch (error) {
      issues.set(path, errorMessage(error));
      throw error;
    } finally {
      active.delete(path);
    }
  }

  function resolveValue(value: JsonValue, owner: string): JsonValue {
    if (isReference(value)) return reference(owner, value.slice(1, -1));
    if (Array.isArray(value)) return value.map((item) => resolveValue(item, owner));
    if (isObject(value)) {
      if (Object.hasOwn(value, '$ref')) return pointer(value['$ref'], owner);
      return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, resolveValue(requireValue(part, 'JSON property ' + key), owner)]));
    }
    return value;
  }

  for (const { path, tree } of files) collect(tree, '', undefined, path);
  if (!groups.has('')) throw new Error('Open a JSON document containing token groups.');
  indexGroup('');
  for (const path of tokens.keys()) {
    try { resolve(path); } catch { /* Diagnostics are available for each row. */ }
  }
  return { tokens, rows, groups, resolved, dependencies, usedBy, issues, extendedGroups };
}

export function resolveFile(owner: string, target: string) {
  if (!owner || target.startsWith('/') || /[\\:?#]/u.test(target)) {
    throw new Error('Only relative pointers to open token files can be resolved.');
  }
  const parts = owner.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) throw new Error('Pointer leaves the open checkout.');
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

export function changeDocument(tree: JsonObject, { path, node, create }: TokenChange) {
  const parent = nodeAt(tree, parentPath(path));
  const key = leafName(path);
  if (!isObject(parent) || '$value' in parent || '$ref' in parent) throw new Error('The parent group is missing.');
  if (!key || /[.{}]/u.test(key) || (key.startsWith('$') && key !== '$root')) throw new Error('Invalid token or group name.');
  const exists = Object.hasOwn(parent, key);
  if (create === exists) throw new Error(create ? 'That name already exists in this group.' : 'The token no longer exists.');
  const next = structuredClone(tree);
  const nextParent = nodeAt(next, parentPath(path));
  if (!isObject(nextParent)) throw new Error('The parent group is missing.');
  const current = nextParent[key];
  const token: TokenNode = { ...(isObject(current) ? current : {}), ...node };
  if ('$value' in node) delete token.$ref;
  Object.defineProperty(nextParent, key, { value: token, enumerable: true, configurable: true, writable: true });
  return next;
}

export type DocumentGraph = ReturnType<typeof inspectDocuments>;
