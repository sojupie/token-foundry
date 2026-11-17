import { applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser';
import type { Edit, JSONPath } from 'jsonc-parser';
import { nodeAt, parentPath } from './document.ts';
import { isJsonObject, parseJson, requireObject, requireValue } from './json.ts';
import type { JsonObject, JsonValue } from './json.ts';
import { resolverPointer, serializeTokenPointer, tokenPointer } from './token-path.ts';
import { parseTokenFile } from './parse-token-file.ts';
import type { Workspace } from './workspace.ts';

export interface Move {
  path: string;
  to: string;
  file: string;
}

interface Location {
  file: string;
  path: string;
}

interface ReferenceMove { from: Location; to: Location }

interface Relocation extends ReferenceMove {
  node: JsonObject;
}

type WorkspaceFile = Workspace['files'][number];
const alias = /^\{([^{}]+)\}$/u;
const contains = (root: string, path: string) => path === root || path.startsWith(root + '.');

export function formatOptions(text: string) {
  const indent = /\r?\n([\t ]+)"/u.exec(text)?.[1] ?? '  ';
  return { insertSpaces: !indent.includes('\t'), tabSize: indent.length, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

function rewritePointer(value: string, ownerBefore: string, ownerAfter: string, moves: readonly ReferenceMove[]): string {
  try {
    const { file, parts } = tokenPointer(value, ownerBefore);
    const moved = moves.find(({ from }) => from.file === file && from.path.split('.').every((part, index) => part === parts[index]));
    if (!moved && ownerBefore === ownerAfter) return value;
    const target = moved ? [...moved.to.path.split('.'), ...parts.slice(moved.from.path.split('.').length)] : parts;
    return serializeTokenPointer(ownerAfter, moved?.to.file ?? file, target);
  } catch {
    return value;
  }
}

function rewriteDocumentReferences(file: WorkspaceFile, replace: (reference: string, path: JSONPath) => string) {
  if (file.parseIssue) return { text: file.text, count: 0 };
  const ast = requireValue(parseTree(file.text), 'token document');
  const edits: Edit[] = [];

  function walk(value: JsonValue, location: JSONPath) {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) walk(item, [...location, index]);
      return;
    }
    if (!isJsonObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || key === '$extensions') continue;
      const field = [...location, key];
      if (typeof item !== 'string' || key !== '$ref' && key !== '$extends') {
        walk(item, field);
        continue;
      }
      const next = replace(item, field);
      if (item === next) continue;
      const node = requireValue(findNodeAtLocation(ast, field), 'reference in ' + file.path);
      edits.push({ offset: node.offset, length: node.length, content: JSON.stringify(next) });
    }
  }
  walk(file.tree, []);
  return { text: applyEdits(file.text, edits), count: edits.length };
}

export function rewriteSourcePointers(file: WorkspaceFile, from: string, to: string) {
  const owner = file.path === from ? to : file.path;
  return rewriteDocumentReferences(file, reference => {
    if (!reference || reference.startsWith('{')) return reference;
    const hash = reference.indexOf('#');
    const resource = hash < 0 ? reference : reference.slice(0, hash);
    let target: string;
    try {
      target = tokenPointer(resource + '#', file.path).file;
    } catch {
      return reference;
    }
    if (owner === file.path && target !== from || !resource && target === from) return reference;
    const destination = target === from ? to : target;
    const newResource = serializeTokenPointer(owner, destination, []).slice(0, -1);
    return newResource + (hash < 0 ? newResource ? '' : '#' : reference.slice(hash));
  });
}

export function rewriteSetPointers(file: WorkspaceFile, origin: { file: string; name: string }, destination: { file: string; name: string }) {
  return rewriteDocumentReferences(file, (reference, field) => {
    if (!reference || reference.startsWith('{')) return reference;
    const owner = file.path === origin.file && field[0] === 'sets' && field[1] === origin.name ? destination.file : file.path;
    try {
      const target = resolverPointer(reference, file.path);
      const moved = target.file === origin.file && target.parts[0] === 'sets' && target.parts[1] === origin.name;
      if (!moved && owner === file.path) return reference;
      const targetFile = moved ? destination.file : target.file;
      const resource = serializeTokenPointer(owner, targetFile, []).slice(0, -1);
      const hash = reference.indexOf('#');
      if (!moved) return resource + (hash < 0 ? resource ? '' : '#' : reference.slice(hash));
      const fragment = reference.slice(hash + 1);
      const slash = fragment.startsWith('/') ? '/' : '';
      const [section, oldName, ...rest] = fragment.slice(slash.length).split('/');
      if (!section || !oldName || rest.length !== target.parts.length - 2) {
        return serializeTokenPointer(owner, targetFile, ['sets', destination.name, ...target.parts.slice(2)]);
      }
      const key = serializeTokenPointer(targetFile, targetFile, [destination.name]).slice(2);
      return resource + '#' + slash + [section, key, ...rest].join('/');
    } catch {
      return reference;
    }
  });
}

function inheritedMoves(workspace: Workspace, moves: readonly ReferenceMove[]): ReferenceMove[] {
  const projections = new Map<string, ReferenceMove>();
  const { groups, tokens } = workspace.graph;
  const extensions = [...groups].flatMap(([path, group]) => [...group.definitions].flatMap(([file, definition]) =>
    definition.extends ? [{ path, file, base: definition.extends }] : []));
  const queue = [...moves];
  for (const { from, to } of queue) {
    for (const { path, file, base } of extensions) {
      const prefix = base.path ? base.path + '.' : '';
      if (from.file !== base.file || to.file !== base.file ||
        from.path === base.path || to.path === base.path || !from.path.startsWith(prefix) || !to.path.startsWith(prefix)) continue;
      const project = (location: Location) => ({ file, path: [path, location.path.slice(prefix.length)].filter(Boolean).join('.') });
      const inheritedRoot = project(from);
      function add(oldPath: Location, destination: Location) {
        const key = JSON.stringify(oldPath);
        if (projections.has(key) || moves.some(move => move.from.file === file && contains(move.from.path, oldPath.path))) return;
        if (tokens.has(destination.path)) return;
        const group = groups.get(oldPath.path);
        const definition = group?.definitions.get(file);
        const existingGroup = groups.has(destination.path);
        if (group && definition && (definition.authored || existingGroup)) {
          for (const child of group.members) {
            add({ file, path: child }, { file, path: destination.path + child.slice(oldPath.path.length) });
          }
          return;
        }
        const sourcePath = from.path + oldPath.path.slice(inheritedRoot.path.length);
        const sourceToken = tokens.get(sourcePath);
        const baseGroup = groups.get(sourcePath)?.definitions.get(from.file);
        const targetToken = tokens.get(oldPath.path);
        const origin = targetToken?.file === file ? targetToken.inheritedFrom : definition?.source;
        const baseOrigin = sourceToken?.file === from.file ? sourceToken.inheritedFrom ?? { file: from.file, path: sourcePath } : baseGroup?.source;
        if (!origin || origin.file !== baseOrigin?.file || origin.path !== baseOrigin.path || targetToken && existingGroup) return;
        const projection = { from: oldPath, to: destination };
        projections.set(key, projection);
        queue.push(projection);
      }
      add(inheritedRoot, project(to));
    }
  }
  return [...projections.values()];
}

function rewriteReferences(file: string, text: string, moves: readonly Relocation[], targets: readonly ReferenceMove[], duplicate: boolean) {
  const tree = parseTokenFile(text, file);
  const ast = requireValue(parseTree(text), 'token document');
  const edits: Edit[] = [];
  function rewrite(value: JsonValue, location: JSONPath, ownerBefore: string, pointer = false) {
    if (typeof value === 'string') {
      const target = alias.exec(value)?.[1];
      const moved = target && targets.find(({ from }) => contains(from.path, target));
      const replaced = moved ? '{' + moved.to.path + (target || '').slice(moved.from.path.length) + '}' :
        pointer ? rewritePointer(value, ownerBefore, file, targets) : value;
      if (replaced !== value) {
        const node = requireValue(findNodeAtLocation(ast, location), 'reference in ' + file);
        edits.push({ offset: node.offset, length: node.length, content: JSON.stringify(replaced) });
      }
    } else if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) rewrite(item, [...location, index], ownerBefore);
    } else if (isJsonObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (item !== undefined) rewrite(item, [...location, key], ownerBefore, key === '$ref');
      }
    }
  }
  function walk(node: JsonObject, location: string[]) {
    const path = location.join('.');
    const ownerMove = moves.find(({ to }) => file === to.file && contains(to.path, path));
    const ownerBefore = ownerMove?.from.file ?? file;
    for (const [key, value] of Object.entries(node)) {
      if (value === undefined) continue;
      const next = [...location, key];
      if (key === '$value' || key === '$ref' || key === '$extends') {
        if (!duplicate || ownerMove) rewrite(value, next, ownerBefore, key !== '$value');
      } else if ((!key.startsWith('$') || key === '$root') && isJsonObject(value)) walk(value, next);
    }
  }
  walk(tree, []);
  return { text: applyEdits(text, edits), count: edits.length };
}

export interface ClipboardEntry {
  path: string;
  group: boolean;
  fragments: { file: string; path?: string; node: JsonObject; type?: string; referenceType?: string }[];
}

export function copyEntries(workspace: Workspace, paths: readonly string[]): ClipboardEntry[] {
  const entries = [...new Set(paths)];
  if (!entries.length) throw new Error('Select a token or group to copy.');
  return entries.map(path => {
    const token = workspace.graph.tokens.get(path);
    const group = workspace.graph.groups.get(path);
    if (!path || !token && !group?.definitions.size) throw new Error('Choose a token or group to copy.');
    const origins = token ? [token.inheritedFrom ?? { file: token.file, path }] :
      group?.files.size ? [...group.files.keys()].map(file => ({ file, path })) :
        [...group?.definitions.values() ?? []].map(definition => definition.source);
    const seen = new Set<string>();
    const fragments = origins.flatMap(origin => {
      const key = JSON.stringify(origin);
      if (seen.has(key)) return [];
      seen.add(key);
      const { file } = origin;
      const source = requireValue(workspace.files.find(entry => entry.path === file), 'source file');
      const node = requireObject(nodeAt(source.tree, origin.path), origin.path);
      const type = token?.type ?? group?.files.get(file) ?? group?.type;
      const fragment: ClipboardEntry['fragments'][number] = { file, node };
      if (origin.path !== path) fragment.path = origin.path;
      if (type) fragment.type = type;
      if (token?.referenceType) fragment.referenceType = token.referenceType;
      return [fragment];
    });
    return { path, group: !!group, fragments };
  });
}

export function encodeClipboard(entries: readonly ClipboardEntry[]): string {
  return JSON.stringify({ format: 'foundry.tokens', version: 1, entries }, null, 2);
}

export function decodeClipboard(text: string): ClipboardEntry[] {
  if (text.length > 4 * 1024 * 1024) throw new Error('This clipboard contains too much token data.');
  const payload = parseJson(text);
  if (!isJsonObject(payload) || payload['format'] !== 'foundry.tokens' || payload['version'] !== 1 ||
    !Array.isArray(payload['entries']) || !payload['entries'].length) {
    throw new Error('The clipboard does not contain Foundry tokens or groups.');
  }
  return payload['entries'].map(item => {
    if (!isJsonObject(item) || typeof item['path'] !== 'string' || !item['path'] ||
      typeof item['group'] !== 'boolean' || !Array.isArray(item['fragments']) || !item['fragments'].length) {
      throw new Error('A copied entry is incomplete.');
    }
    const fragments = item['fragments'].map(fragment => {
      if (!isJsonObject(fragment) || typeof fragment['file'] !== 'string' || !fragment['file'] ||
        fragment['file'].split('/').some(part => !part || part === '.' || part === '..') || !isJsonObject(fragment['node'])) {
        throw new Error('A copied source is incomplete.');
      }
      const { file, node, path, type, referenceType } = fragment;
      return { file, node, ...(typeof path === 'string' && path ? { path } : {}), ...(typeof type === 'string' ? { type } : {}), ...(typeof referenceType === 'string' ? { referenceType } : {}) };
    });
    if (new Set(fragments.map(fragment => JSON.stringify([fragment.file, fragment.path ?? item['path']]))).size !== fragments.length || !item['group'] && fragments.length !== 1) {
      throw new Error('The copied entry has conflicting sources.');
    }
    return { path: item['path'], group: item['group'], fragments };
  });
}

function planMove(workspace: Workspace, { path, to, file }: Move): Relocation[] {
  const { tokens, groups } = workspace.graph;
  const token = tokens.get(path);
  const group = groups.get(path);
  if (token?.inheritedFrom || group && !group.files.size) throw new Error('Choose an authored token or group to move.');
  if (!path || (!token && !group)) throw new Error('Choose a token or group to move.');
  const names = to.split('.');
  if (names.some((name, index) => !name.trim() || /[{}]/u.test(name) ||
    (name.startsWith('$') && !(token && name === '$root' && index === names.length - 1)))) {
    throw new Error('Enter a valid destination path.');
  }
  if (path !== to && (tokens.has(to) || groups.has(to) || contains(path, to))) {
    throw new Error('The destination already exists or lies inside the moved group.');
  }
  const parent = groups.get(parentPath(to));
  if (!parent?.files.has(file)) throw new Error('The destination file must contain the destination group.');
  const sources = token ? [token.file] : [...requireValue(group, 'source group').files.keys()];
  if (sources.length > 1 && !sources.every((source) => parent.files.has(source))) {
    throw new Error('This group spans multiple files. Choose a destination shared by those files, or move its children.');
  }
  return sources.map((sourceFile) => {
    const destination = sources.length > 1 ? sourceFile : file;
    if (path === to && sourceFile === destination) throw new Error('Choose another path or file.');
    const source = requireValue(workspace.files.find((entry) => entry.path === sourceFile), 'source file');
    const node = requireObject(nodeAt(source.tree, path), path);
    const type = token?.type ?? group?.files.get(sourceFile);
    const inherited = parent.files.get(destination);
    if (!type && inherited && node['$type'] === undefined) throw new Error('This move would change the inherited token type.');
    const moved = type && type !== inherited && node['$type'] === undefined && !token?.referenceType ? { ...node, $type: type } : node;
    return { from: { file: sourceFile, path }, to: { file: destination, path: to }, node: moved };
  });
}

function mergeClipboardGroups(left: JsonObject, right: JsonObject): JsonObject {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const previous = Object.hasOwn(merged, key) ? merged[key] : undefined;
    if (previous === undefined) Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true });
    else if (JSON.stringify(previous) !== JSON.stringify(value)) {
      if (key === '$extensions' && isJsonObject(previous) && isJsonObject(value) &&
        Object.keys(value).every(namespace => !Object.hasOwn(previous, namespace) ||
          JSON.stringify(previous[namespace]) === JSON.stringify(value[namespace]))) {
        merged[key] = { ...previous, ...value };
        continue;
      }
      if (key.startsWith('$') || !isJsonObject(previous) || !isJsonObject(value) ||
        Object.hasOwn(previous, '$value') || Object.hasOwn(value, '$value')) {
        throw new Error('Copied sources have different definitions for ' + key + '. Keep their original files by choosing a shared destination.');
      }
      merged[key] = mergeClipboardGroups(previous, value);
    }
  }
  return merged;
}

export function pasteFiles(workspace: Workspace, entries: readonly ClipboardEntry[], moves: readonly Move[]) {
  if (!entries.length || entries.length !== moves.length) throw new Error('Choose a destination for every copied entry.');
  if (entries.some((entry, index) => entries.slice(0, index).some(other =>
    contains(other.path, entry.path) || contains(entry.path, other.path)))) throw new Error('The copied entries overlap.');
  const seen = new Set<string>();
  const relocations = entries.flatMap((entry, index): Relocation[] => {
    const move = requireValue(moves[index], 'paste destination');
    if (move.path !== entry.path || seen.has(move.to) || [...seen].some(path => contains(path, move.to) || contains(move.to, path))) {
      throw new Error('Choose distinct destinations for the copied entries.');
    }
    seen.add(move.to);
    const parts = move.to.split('.');
    if (parts.some((name, position) => !name.trim() || /[{}]/u.test(name) ||
      (name.startsWith('$') && !(name === '$root' && !entry.group && position === parts.length - 1)))) {
      throw new Error('Enter a valid destination name.');
    }
    if (workspace.graph.tokens.has(move.to) || workspace.graph.groups.has(move.to)) {
      throw new Error(move.to + ' already exists. Choose a different name.');
    }
    const parent = workspace.graph.groups.get(parentPath(move.to));
    if (!parent?.files.has(move.file)) throw new Error('Choose a file that contains the destination group.');
    const preserveFiles = entry.fragments.length > 1 && entry.fragments.every(fragment => parent.files.has(fragment.file));
    return entry.fragments.map(fragment => {
      const file = preserveFiles ? fragment.file : move.file;
      const inherited = parent.files.get(file);
      if (!fragment.type && inherited && fragment.node['$type'] === undefined) {
        throw new Error('This paste would change the inherited type of ' + entry.path + '.');
      }
      const node = fragment.type && fragment.type !== inherited && fragment.node['$type'] === undefined && !fragment.referenceType
        ? { ...fragment.node, $type: fragment.type } : fragment.node;
      return { from: { file: fragment.file, path: fragment.path ?? entry.path }, to: { file, path: move.to }, node };
    });
  });
  let referencesUpdated = 0;
  const insertions = new Map<string, Map<string, JsonObject>>();
  for (const copy of relocations) {
    const wrapper = copy.to.path.split('.').reduceRight<JsonObject>((node, part) => ({ [part]: node }), copy.node);
    const rewritten = rewriteReferences(copy.to.file, JSON.stringify(wrapper), [copy], [copy, ...relocations.filter(part => part !== copy)], true);
    referencesUpdated += rewritten.count;
    const node = requireObject(nodeAt(parseTokenFile(rewritten.text, copy.to.file), copy.to.path), copy.to.path);
    const paths = insertions.get(copy.to.file) ?? new Map<string, JsonObject>();
    const current = paths.get(copy.to.path);
    paths.set(copy.to.path, current ? mergeClipboardGroups(current, node) : node);
    insertions.set(copy.to.file, paths);
  }
  const files = workspace.files.map(file => {
    const nodes = insertions.get(file.path);
    if (!nodes) return file;
    const options = { formattingOptions: formatOptions(file.text) };
    let text = file.text;
    for (const [path, node] of nodes) text = applyEdits(text, modify(text, path.split('.'), node, options));
    return { ...file, text, tree: parseTokenFile(text, file.path) };
  });
  return { files, referencesUpdated };
}

export function moveFiles(workspace: Workspace, moves: readonly Move[], duplicate = false) {
  if (!moves.length) throw new Error('Choose a different destination.');
  for (const [index, move] of moves.entries()) {
    if (duplicate && move.path === move.to) throw new Error('Choose a new path for the copy.');
    if (moves.slice(0, index).some((other) =>
      contains(other.path, move.path) || contains(move.path, other.path) || contains(other.to, move.to) || contains(move.to, other.to))) {
      throw new Error('Selected tokens have overlapping sources or destinations.');
    }
  }
  const relocations = moves.flatMap((move) => planMove(workspace, move));
  const targets = duplicate ? relocations : [...relocations, ...inheritedMoves(workspace, relocations)];
  let referencesUpdated = 0;
  const files: WorkspaceFile[] = workspace.files.map((entry) => {
    if (entry.parseIssue) return entry;
    const options = { formattingOptions: formatOptions(entry.text) };
    let text = entry.text;
    for (const { from } of relocations) {
      if (!duplicate && entry.path === from.file) text = applyEdits(text, modify(text, from.path.split('.'), undefined, options));
    }
    for (const { to, node } of relocations) {
      if (entry.path === to.file) text = applyEdits(text, modify(text, to.path.split('.'), node, options));
    }
    const rewritten = rewriteReferences(entry.path, text, relocations, targets, duplicate);
    text = rewritten.text;
    referencesUpdated += rewritten.count;
    return text === entry.text ? entry : { path: entry.path, text, tree: parseTokenFile(text, entry.path) };
  });
  return { files, referencesUpdated, relocations };
}
