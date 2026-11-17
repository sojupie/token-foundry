import { errorMessage, isJsonObject as isObject, requireValue } from './json.ts';
import type { JsonObject, JsonValue } from './json.ts';
import { tokenFieldType, tokenValueIssues } from './validate-token.ts';
import { metadataDiagnostics } from './document-diagnostics.ts';
import type { DocumentDiagnostic } from './document-diagnostics.ts';
import { resolveGroupInheritance } from './group-inheritance.ts';
import type { AuthoredLocation, EffectiveEntry } from './group-inheritance.ts';
import { serializeTokenPointer, tokenPointer } from './token-path.ts';
import { clampGradientPosition, dtcgTypes, isTokenNode } from './token-types.ts';
import type { TokenChange, TokenFile, TokenNode } from './token-types.ts';

export interface ReferenceEdge {
  field: readonly string[];
  text: string;
  file: string;
  parts: readonly string[];
  target?: string;
  value?: JsonValue;
}

export interface TokenEntry {
  type: string | undefined;
  referenceType?: string;
  node: TokenNode;
  authoredNode: JsonObject;
  file: string;
  value: JsonValue;
  inheritedFrom?: AuthoredLocation;
  overrides?: AuthoredLocation;
  deprecated?: boolean | string;
}
export interface GroupDefinition {
  source: AuthoredLocation;
  authored: boolean;
  node: JsonObject;
  type: string | undefined;
  extends?: AuthoredLocation;
  deprecated?: boolean | string;
}

interface Group {
  definitions: Map<string, GroupDefinition>;
  files: Map<string, string | undefined>;
  members: Set<string>;
  children: string[];
  start: number;
  end: number;
  type: string | undefined;
}

function emptyGroup(): Group {
  return { definitions: new Map(), files: new Map(), members: new Set(), children: [], start: 0, end: 0, type: undefined };
}

const isReference = (value: JsonValue): value is string => typeof value === 'string' && /^\{[^{}]+\}$/u.test(value);
export function referenceLabel(value: JsonValue | undefined): string | undefined {
  if (value !== undefined && isReference(value)) return value;
  if (isObject(value) && typeof value['$ref'] === 'string') return value['$ref'];
  return undefined;
}
export const parentPath = (path: string) => path.split('.').slice(0, -1).join('.');
export const leafName = (path: string) => path.slice(path.lastIndexOf('.') + 1);

export function nodeAt(tree: JsonObject, path: string): JsonValue | undefined {
  return path ? path.split('.').reduce<JsonValue | undefined>((node, key) =>
    isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined, tree) : tree;
}

function property(value: JsonValue | undefined, key: string): JsonValue | undefined {
  if (Array.isArray(value)) return /^(0|[1-9][0-9]*)$/u.test(key) ? value[Number(key)] : undefined;
  return isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

export function inspectDocument(tree: JsonObject) {
  return inspectDocuments([{ path: '', tree }]);
}

export function inspectDocuments(files: readonly TokenFile[]) {
  const trees = new Map(files.map(({ path, tree }) => [path, tree]));
  const tokens = new Map<string, TokenEntry>();
  const fileTokens = new Map<string, Map<string, TokenEntry>>();
  const explicitValues = new WeakMap<TokenEntry, JsonValue>();
  const explicitIssues = new WeakMap<TokenEntry, string>();
  const groups = new Map<string, Group>([['', emptyGroup()]]);
  const resolved = new Map<string, JsonValue>();
  const links = new Map<string, Map<string, ReferenceEdge>>();
  const scopedLinks = new Map<string, Map<string, Map<string, ReferenceEdge>>>();
  const dependencies = new Map<string, Set<string>>();
  const usedBy = new Map<string, Set<string>>();
  const issues = new Map<string, string>();
  const referenceIssues = new Map<string, Map<string, string>>();
  const partialFields = new Map<string, { field: readonly string[]; value: JsonValue }[]>();
  const { roots, groupDiagnostics } = resolveGroupInheritance(files);
  const documentDiagnostics: DocumentDiagnostic[] = groupDiagnostics;
  const conflicts = new Set<string>();

  function collect(entry: EffectiveEntry, path: string, inheritedType: string | undefined, file: string, inheritedDeprecation?: boolean | string, visible = true): boolean {
    const node = entry.value;
    const authored = entry.source.file === file && entry.source.path === path;
    const tree = trees.get(entry.source.file);
    const original = tree && nodeAt(tree, entry.source.path);
    const report = (field: string, message: string, target: DocumentDiagnostic['target'], severity: DocumentDiagnostic['severity'] = 'error') => {
      documentDiagnostics.push({ file, path, field, message, target, severity });
    };
    if (!isObject(node)) {
      report('', 'Expected a token or group object.', { kind: 'group', path: parentPath(path) });
      return false;
    }
    const originalKeys = isObject(original) ? Object.keys(original).filter(key => !key.startsWith('$') || key === '$root') : [];
    const token = entry.token;
    if (token && !path) {
      report('$value', 'Expected a document containing token groups.', { kind: 'source', path });
      return false;
    }
    const kind = token ? 'token' : 'group';
    for (const { field, message, severity } of authored && isObject(original) ? metadataDiagnostics(original, kind, !path) : []) {
      report(field, message, { kind, path }, severity);
    }
    if (!token && leafName(path) === '$root') {
      report('', '$root must be a token.', { kind: 'group', path: parentPath(path) });
      return false;
    }
    const type = typeof node['$type'] === 'string' ? node['$type'] : inheritedType;
    const deprecation = node['$deprecated'];
    const deprecated = typeof deprecation === 'string' || typeof deprecation === 'boolean' ? deprecation : inheritedDeprecation;
    if (token) {
      if (authored) for (const child of originalKeys) report(child, 'A token cannot contain child tokens or groups.', { kind, path });
      // Keep the authored tree intact. The editor reads only valid metadata from its token view.
      const tokenNode = isTokenNode(node) ? node : Object.fromEntries(Object.entries(node).filter(([key, value]) =>
        !['$description', '$type', '$ref'].includes(key) || typeof value === 'string'));
      const definition: TokenEntry = {
        type, node: tokenNode, authoredNode: node, file, value: node['$value'] ?? (Object.hasOwn(node, '$value') ? null : { $ref: node['$ref'] ?? null }),
        ...(!authored ? { inheritedFrom: entry.source } : {}),
        ...(entry.overrides ? { overrides: entry.overrides } : {}),
        ...(deprecated === undefined ? {} : { deprecated }),
      };
      const definitions = fileTokens.get(file) ?? new Map<string, TokenEntry>();
      definitions.set(path, definition);
      fileTokens.set(file, definitions);
      if (visible && (groups.has(path) || tokens.has(path))) {
        const existing = tokens.get(path)?.file ?? groups.get(path)?.files.keys().next().value;
        conflicts.add(path);
        report('', 'Conflicting definition also exists in ' + existing + '.', { kind: 'group', path: parentPath(path) });
        return false;
      }
      if (visible) tokens.set(path, definition);
      return visible;
    }
    const hiddenGroup = visible && tokens.has(path);
    if (hiddenGroup) {
      conflicts.add(path);
      report('', 'Conflicting token definition exists in ' + tokens.get(path)?.file + '.', { kind: 'group', path: parentPath(path) });
    }
    if (!groups.has(path)) groups.set(path, emptyGroup());
    const group = requireValue(groups.get(path), 'group ' + path);
    group.definitions.set(file, { node, authored, source: entry.source, type, ...(entry.extends ? { extends: entry.extends } : {}),
      ...(deprecated === undefined ? {} : { deprecated }) });
    if (authored) group.files.set(file, type);
    const keys = new Set([...(authored ? originalKeys : []), ...(entry.children?.keys() ?? [])]);
    for (const key of keys) {
      if (!key || /[.{}]/u.test(key)) {
        report(key, 'Invalid token or group name.', { kind, path });
        continue;
      }
      const child = entry.children?.get(key);
      const childPath = path ? path + '.' + key : key;
      if (child && collect(child, childPath, type, file, deprecated, visible && !hiddenGroup)) group.members.add(childPath);
    }
    return visible && !hiddenGroup;
  }

  const rows: [string, TokenEntry][] = [];
  function indexGroup(path: string) {
    const group = requireValue(groups.get(path), 'group ' + path);
    group.start = rows.length;
    const types = new Set([...group.definitions.values()].map(definition => definition.type));
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

  function recordReference(owner: string, path: string) {
    if (owner === path) return;

    if (!dependencies.has(owner)) dependencies.set(owner, new Set());
    if (!usedBy.has(path)) usedBy.set(path, new Set());
    requireValue(dependencies.get(owner), 'dependencies').add(path);
    requireValue(usedBy.get(path), 'reverse dependencies').add(owner);
  }

  function track(owner: string, source: TokenEntry, edge: ReferenceEdge) {
    const file = scopedLinks.get(source.file) ?? new Map<string, Map<string, ReferenceEdge>>();
    const ownerLinks = file.get(owner) ?? new Map<string, ReferenceEdge>();
    const key = JSON.stringify(edge.field);
    const previous = ownerLinks.get(key);
    if (previous?.text === edge.text && previous.value !== undefined) edge.value = previous.value;
    ownerLinks.set(key, edge);
    file.set(owner, ownerLinks);
    scopedLinks.set(source.file, file);
    if (tokens.get(owner) === source && !conflicts.has(owner)) links.set(owner, ownerLinks);
  }

  function reference(owner: string, source: TokenEntry, path: string, field: readonly string[], properties: readonly string[]): JsonValue {
    const token = tokens.get(path);
    const text = '{' + path + '}';
    track(owner, source, { field, text, target: path, file: token?.file ?? '', parts: [...path.split('.'), '$value'] });
    const root = path + '.$root';
    if (!tokens.has(path) && tokens.has(root)) throw new Error('Reference points to a group. Use {' + root + '} to reference its root token.');
    if (tokens.get(owner) === source && !conflicts.has(owner)) recordReference(owner, path);
    return properties.length ? readField(path, properties).value : resolve(path);
  }

  const activeFields = new Set<string>();
  function readField(path: string, properties: readonly string[], exact?: TokenEntry): { value: JsonValue; type: string | undefined } {
    const token = exact ?? tokens.get(path);
    if (!token) throw new Error('Reference target is missing: ' + path);
    if (!exact && conflicts.has(path)) throw new Error('Conflicting source definitions for ' + path + '.');
    const field = ['$value', ...properties];
    const key = JSON.stringify([token.file, path, field]);
    if (activeFields.has(key)) throw new Error('Circular reference: ' + serializeTokenPointer(token.file, token.file, [...path.split('.'), ...field]));
    activeFields.add(key);
    try {
      let value = token.value;
      let index = 0;
      for (const propertyName of properties) {
        if (token.type === 'gradient' && index === 1 && referenceLabel(value)) {
          value = resolveValue(value, path, token, field.slice(0, index + 1));
        }
        if (referenceLabel(value)) {
          const authoredField = index === 0 && !Object.hasOwn(token.authoredNode, '$value') ? ['$ref'] : field.slice(0, index + 1);
          const remaining = properties.slice(index);
          if (isReference(value)) {
            const aliasPath = value.slice(1, -1);
            const aliasValue = reference(path, token, aliasPath, authoredField, remaining);
            return { value: aliasValue, type: tokenFieldType(token.type ?? tokens.get(aliasPath)?.type, properties) };
          }
          if (isObject(value)) {
            const pointed = pointer(value['$ref'], path, token, authoredField, remaining);
            return { value: pointed.value, type: tokenFieldType(token.type, properties) ?? pointed.type };
          }
        }
        const next = property(value, propertyName);
        if (next === undefined) throw new Error('Pointer target is missing: ' + serializeTokenPointer(token.file, token.file, [...path.split('.'), ...field]));
        value = next;
        index++;
      }
      return { value: resolveValue(value, path, token, field), type: tokenFieldType(token.type, properties) };
    } finally {
      activeFields.delete(key);
    }
  }

  const activePointers = new Set<string>();
  function setLinkValue(owner: string, source: TokenEntry, field: readonly string[], value: JsonValue) {
    const edge = scopedLinks.get(source.file)?.get(owner)?.get(JSON.stringify(field));
    if (edge) edge.value = value;
    return value;
  }

  function pointer(ref: JsonValue | undefined, owner: string, source: TokenEntry, field: readonly string[], suffix: readonly string[] = []): { value: JsonValue; type?: string | undefined } {
    if (typeof ref !== 'string') throw new Error('Expected a JSON Pointer to a token value.');
    const originFile = source.inheritedFrom?.file ?? source.file;
    const tracked = tokens.get(owner) === source && !conflicts.has(owner);
    track(owner, source, { field, text: ref, file: originFile, parts: [] });
    const { file, parts } = tokenPointer(ref, originFile);
    const valueIndex = parts.indexOf('$value');
    const pathParts = parts.slice(0, valueIndex < 0 ? parts.length : valueIndex);
    const path = pathParts.join('.');
    const definitions = fileTokens.get(file);
    const token = pathParts.some(part => part.includes('.')) ? undefined : definitions?.get(path);
    const properties = [...parts.slice(valueIndex < 0 ? parts.length : valueIndex + 1), ...suffix];
    const pointedToken = token ? path : undefined;
    track(owner, source, { field, text: ref, file, parts, ...(pointedToken === undefined ? {} : { target: pointedToken }) });
    if (token && !properties.length) {
      if (tracked) recordReference(owner, path);
      const value = resolve(path, token);
      return { value, type: token.type };
    }

    if (groups.get(path)?.definitions.has(file) && valueIndex < 0) {
      throw new Error('Pointer target is a group. Use an explicit token path: ' + ref);
    }
    const location = JSON.stringify([file, parts, suffix]);
    if (activePointers.has(location)) throw new Error('Circular reference: ' + ref);
    activePointers.add(location);
    try {
      if (token) {
        if (tracked) recordReference(owner, path);
        return readField(path, properties, token);
      }
      const route = [...parts, ...suffix];
      for (let length = parts.length - 1; length >= 0; length--) {
        const locationParts = route.slice(0, length);
        if (locationParts.some(part => part.includes('.'))) continue;
        const target = locationParts.join('.');
        const effectiveToken = definitions?.get(target);
        const group = groups.get(target)?.definitions.get(file);
        const node = effectiveToken?.authoredNode ?? group?.node;
        if (node === undefined) continue;
        const value = route.slice(length).reduce<JsonValue | undefined>((object, key) => property(object, key), node);
        if (value === undefined) break;
        if (effectiveToken) {
          if (tracked) recordReference(owner, target);
          track(owner, source, { field, text: ref, file, parts, target });
        }
        return { value };
      }
      throw new Error('Pointer target is missing: ' + ref);
    } finally {
      activePointers.delete(location);
    }
  }

  function resolveLink(value: JsonValue, owner: string, source: TokenEntry, field: readonly string[]): JsonValue {
    if (isReference(value)) return setLinkValue(owner, source, field, reference(owner, source, value.slice(1, -1), [...field], []));
    if (isObject(value) && Object.hasOwn(value, '$ref')) {
      return setLinkValue(owner, source, field, pointer(value['$ref'], owner, source, [...field]).value);
    }
    return value;
  }

  const active = new Set<TokenEntry>();
  function resolve(path: string, exact?: TokenEntry): JsonValue {
    if (!exact && conflicts.has(path)) {
      const message = 'Conflicting source definitions for ' + path + '.';
      issues.set(path, message);
      throw new Error(message);
    }
    const token = exact ?? tokens.get(path);
    if (!token) throw new Error('Reference target is missing: ' + path);
    const indexed = tokens.get(path) === token && !conflicts.has(path);
    const cached = indexed ? resolved.get(path) : explicitValues.get(token);
    if (cached !== undefined) return cached;
    const issue = indexed ? issues.get(path) : explicitIssues.get(token);
    if (issue !== undefined) throw new Error(issue);
    if (active.has(token)) throw new Error('Circular reference: ' + path);
    active.add(token);
    const fields: { field: readonly string[]; value: JsonValue }[] = [];
    try {
      const link = isReference(token.value) ? token.value.slice(1, -1) : undefined;
      const field = [Object.hasOwn(token.authoredNode, '$value') ? '$value' : '$ref'];
      const pointed = isObject(token.value) && Object.hasOwn(token.value, '$ref') ? pointer(token.value['$ref'], path, token, field) : undefined;
      const result = pointed ? setLinkValue(path, token, field, pointed.value) : resolveValue(token.value, path, token, ['$value'], fields);
      const candidateType = link ? tokens.get(link)?.type : pointed?.type;
      const targetType = dtcgTypes.some(type => type === candidateType) ? candidateType : undefined;
      if (targetType) token.referenceType = targetType;
      if (token.node.$type && targetType && token.node.$type !== targetType) {
        throw new Error('Expected a ' + token.node.$type + ' reference, found ' + targetType + '.');
      }
      if (!token.node.$type && targetType) token.type = targetType;
      if (indexed) resolved.set(path, result);
      else explicitValues.set(token, result);
      return result;
    } catch (error) {
      if (indexed) {
        issues.set(path, errorMessage(error));
        if (fields.length) partialFields.set(path, fields);
      } else explicitIssues.set(token, errorMessage(error));
      throw error;
    } finally {
      active.delete(token);
    }
  }

  function resolveValue(value: JsonValue, owner: string, source: TokenEntry, field: readonly string[],
    fields?: { field: readonly string[]; value: JsonValue }[]): JsonValue {
    if (Array.isArray(value) || isObject(value) && !Object.hasOwn(value, '$ref')) {
      let failure: Error | undefined;
      const parts = Object.entries(value).map(([key, part]) => {
        const child = requireValue(part, 'JSON property ' + key);
        try {
          const location = [...field, key];
          const resolvedChild = resolveValue(child, owner, source, location, fields);
          fields?.push({ field: location.slice(1), value: resolvedChild });
          return [key, resolvedChild] as const;
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(errorMessage(error));
          return [key, child] as const;
        }
      });
      if (failure) throw failure;
      return Array.isArray(value) ? parts.map(([, child]) => child) : Object.fromEntries(parts);
    }
    try {
      const result = resolveLink(value, owner, source, field);
      if (source.type === 'gradient' && /^(0|[1-9][0-9]*)$/u.test(field[1] ?? '')) {
        if (field.length === 2 && referenceLabel(value) && Array.isArray(result) && result.length === 1 && isObject(result[0])) {
          return result[0];
        }
        if (field.length === 3 && field[2] === 'position' && typeof result === 'number') return clampGradientPosition(result);
      }
      return result;
    } catch (failure) {
      if (field.length === 1) throw failure;
      const location = field.join('/');
      const message = location + ' · ' + errorMessage(failure);
      if (tokens.get(owner) === source && !conflicts.has(owner)) {
        const details = referenceIssues.get(owner) ?? new Map<string, string>();
        details.set(location, message);
        referenceIssues.set(owner, details);
      }
      throw new Error(message, { cause: failure });
    }
  }

  for (const root of roots) collect(root, '', undefined, root.source.file);
  indexGroup('');
  for (const path of tokens.keys()) {
    try { resolve(path); } catch { /* Diagnostics are available for each row. */ }
  }
  const validation = new Map<string, readonly string[]>();
  for (const [path, token] of tokens) {
    const value = resolved.get(path);
    const authoredIssues = tokenValueIssues(token.type, token.value, true, (_candidate, field) => {
      const sourceField = field === '$value' && !Object.hasOwn(token.authoredNode, '$value') ? '$ref' : field;
      const edge = links.get(path)?.get(JSON.stringify(sourceField.split('/')));
      const target = edge?.target !== undefined ? fileTokens.get(edge.file)?.get(edge.target) : undefined;
      if (!edge || !target) return undefined;
      const valueIndex = edge.parts.indexOf('$value');
      if (valueIndex >= 0) return tokenFieldType(target.type, edge.parts.slice(valueIndex + 1));
      return edge.parts.length === (edge.target?.split('.').length ?? 0) ? target.type : undefined;
    });
    const origin = token.overrides ?? token.inheritedFrom;
    const base = origin ? fileTokens.get(origin.file)?.get(origin.path) : undefined;
    const inheritedType = origin && base?.file === origin.file ? base.type : undefined;
    const ownIssues = [...authoredIssues, ...(value === undefined ? [] : tokenValueIssues(token.type, value))];
    const inheritedIssues = value !== undefined && inheritedType && inheritedType !== token.type ? [...tokenValueIssues(inheritedType, value)]
      .filter(issue => !ownIssues.includes(issue))
      .map(issue => issue + ' (inherited ' + inheritedType + ' constraint from ' + origin?.path + ')') : [];
    const issuesForToken = [...new Set([...ownIssues, ...inheritedIssues])];
    if (issuesForToken.length) validation.set(path, issuesForToken);
  }
  return { tokens, rows, groups, resolved, links, scopedLinks, dependencies, usedBy, issues, referenceIssues, partialFields, validation, documentDiagnostics };
}

export function changeDocument(tree: JsonObject, { path, node, create, inheritType }: TokenChange) {
  const parent = nodeAt(tree, parentPath(path));
  const key = leafName(path);
  if (!isObject(parent) || '$value' in parent) throw new Error('The parent group is missing.');
  if (!key || /[.{}]/u.test(key) || (key.startsWith('$') && key !== '$root')) throw new Error('Invalid token or group name.');
  const exists = Object.hasOwn(parent, key);
  if (create === exists) throw new Error(create ? 'That name already exists in this group.' : 'The token no longer exists.');
  const next = structuredClone(tree);
  const nextParent = nodeAt(next, parentPath(path));
  if (!isObject(nextParent)) throw new Error('The parent group is missing.');
  const current = nextParent[key];
  const token: TokenNode = { ...(isObject(current) ? current : {}), ...node };
  if ('$value' in node) delete token.$ref;
  if (inheritType) delete token.$type;
  Object.defineProperty(nextParent, key, { value: token, enumerable: true, configurable: true, writable: true });
  return next;
}

export type DocumentGraph = ReturnType<typeof inspectDocuments>;

export function referenceProblems(graph: DocumentGraph, path: string, primary: string): string[] {
  return [...new Set([primary, ...graph.referenceIssues.get(path)?.values() ?? []])];
}

const isPrefix = (left: readonly string[], right: readonly string[]) =>
  left.length <= right.length && left.every((part, index) => part === right[index]);

function valueField(field: readonly string[]): readonly string[] {
  return field[0] === '$ref' || !field.length ? ['$value'] : field;
}

export function fieldDependsOn(graph: DocumentGraph, path: string, field: readonly string[], dependency: string, dependencyField: readonly string[] = []): boolean {
  const start = graph.tokens.get(path);
  const targetToken = graph.tokens.get(dependency);
  if (!start || !targetToken) return false;
  const pending = [{ file: start.file, path, field: ['$value', ...field] }];
  const seen = new Set<string>();
  const scope = ['$value', ...dependencyField];
  for (const entry of pending) {
    if (entry.file === targetToken.file && entry.path === dependency &&
      (isPrefix(scope, entry.field) || isPrefix(entry.field, scope))) return true;
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const link of graph.scopedLinks.get(entry.file)?.get(entry.path)?.values() ?? []) {
      if (link.target === undefined || link.value === undefined) continue;
      const source = valueField(link.field);
      if (!isPrefix(source, entry.field) && !isPrefix(entry.field, source)) continue;
      const target = valueField(link.parts.slice(link.target.split('.').length));
      pending.push({ file: link.file, path: link.target, field: [...target, ...entry.field.slice(source.length)] });
    }
  }
  return false;
}

const tokenLocationKey = (file: string, path: string) => JSON.stringify([file, path]);

export function referenceConsumers(graph: DocumentGraph, path: string) {
  const start = graph.tokens.get(path);
  const direct = new Set<string>();
  const downstream = new Set<string>();
  if (!start) return { direct, downstream };
  const incoming = new Map<string, { file: string; path: string; edge: ReferenceEdge }[]>();
  for (const [file, owners] of graph.scopedLinks) {
    for (const [owner, references] of owners) {
      for (const edge of references.values()) {
        if (edge.target === undefined) continue;
        const target = tokenLocationKey(edge.file, edge.target);
        const consumers = incoming.get(target) ?? [];
        consumers.push({ file, path: owner, edge });
        incoming.set(target, consumers);
      }
    }
  }

  const queue: { file: string; path: string; field: readonly string[] }[] = [{ file: start.file, path, field: [] }];
  const visited = new Set<string>();
  for (const change of queue) {
    for (const consumer of incoming.get(tokenLocationKey(change.file, change.path)) ?? []) {
      if (consumer.file === start.file && consumer.path === path) continue;
      const visible = graph.tokens.get(consumer.path)?.file === consumer.file;
      if (!change.field.length && visible) direct.add(consumer.path);
      if (consumer.edge.value === undefined) continue;
      const target = consumer.edge.parts.slice(change.path.split('.').length);
      const targetField = target.length ? target : ['$value'];
      if (!isPrefix(targetField, change.field) && !isPrefix(change.field, targetField)) continue;
      const source = valueField(consumer.edge.field);
      const field = [...source, ...change.field.slice(targetField.length)];
      const visit = JSON.stringify([consumer.file, consumer.path, field]);
      if (visited.has(visit)) continue;
      visited.add(visit);
      queue.push({ file: consumer.file, path: consumer.path, field });
      if (visible && !direct.has(consumer.path)) downstream.add(consumer.path);
    }
  }
  return { direct, downstream };
}
