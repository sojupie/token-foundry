import { applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser';
import type { Edit, JSONPath } from 'jsonc-parser';
import { nodeAt, parentPath, resolveFile } from './document.ts';
import { isJsonObject, requireObject, requireValue } from './json.ts';
import type { JsonObject, JsonValue } from './json.ts';
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

interface Relocation {
  from: Location;
  to: Location;
  node: JsonObject;
}

type WorkspaceFile = Workspace['files'][number];
const alias = /^\{([^{}]+)\}$/u;
const contains = (root: string, path: string) => path === root || path.startsWith(root + '.');

export function formatOptions(text: string) {
  const indent = /\r?\n([\t ]+)"/u.exec(text)?.[1] ?? '  ';
  return { insertSpaces: !indent.includes('\t'), tabSize: indent.length, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

function relativeFile(from: string, to: string): string {
  if (from === to) return '';
  const source = from.split('/').slice(0, -1);
  const target = to.split('/');
  let shared = 0;
  while (shared < source.length && source[shared] === target[shared]) shared++;
  return [...source.slice(shared).map(() => '..'), ...target.slice(shared).map((part) => encodeURIComponent(part))].join('/');
}

function rewritePointer(value: string, ownerBefore: string, ownerAfter: string, moves: readonly Relocation[]): string {
  const separator = value.indexOf('#/');
  if (separator < 0) return value;
  try {
    const resource = value.slice(0, separator);
    const file = resource ? resolveFile(ownerBefore, decodeURIComponent(resource)) : ownerBefore;
    const parts = decodeURIComponent(value.slice(separator + 2)).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const moved = moves.find(({ from }) => from.file === file && from.path.split('.').every((part, index) => part === parts[index]));
    if (!moved && ownerBefore === ownerAfter) return value;
    const target = moved ? [...moved.to.path.split('.'), ...parts.slice(moved.from.path.split('.').length)] : parts;
    const pointer = target.map((part) => encodeURIComponent(part.replaceAll('~', '~0').replaceAll('/', '~1'))).join('/');
    return relativeFile(ownerAfter, moved?.to.file ?? file) + '#/' + pointer;
  } catch {
    return value;
  }
}

function rewriteReferences(file: string, text: string, moves: readonly Relocation[]): string {
  const tree = parseTokenFile(text, file);
  const ast = requireValue(parseTree(text), 'token document');
  const edits: Edit[] = [];
  function rewrite(value: JsonValue, location: JSONPath, ownerBefore: string, pointer = false) {
    if (typeof value === 'string') {
      const target = alias.exec(value)?.[1];
      const moved = target && moves.find(({ from }) => contains(from.path, target));
      const replaced = moved ? '{' + moved.to.path + (target || '').slice(moved.from.path.length) + '}' :
        pointer ? rewritePointer(value, ownerBefore, file, moves) : value;
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
    const ownerBefore = moves.find(({ to }) => file === to.file && contains(to.path, path))?.from.file ?? file;
    for (const [key, value] of Object.entries(node)) {
      if (value === undefined) continue;
      const next = [...location, key];
      if (key === '$value' || key === '$ref' || key === '$extends') {
        rewrite(value, next, ownerBefore, key !== '$value');
      } else if ((!key.startsWith('$') || key === '$root') && isJsonObject(value)) walk(value, next);
    }
  }
  walk(tree, []);
  return applyEdits(text, edits);
}

function planMove(workspace: Workspace, { path, to, file }: Move): Relocation[] {
  const { tokens, groups } = workspace.graph;
  const token = tokens.get(path);
  const group = groups.get(path);
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

export function moveFiles(workspace: Workspace, moves: readonly Move[]): WorkspaceFile[] {
  if (!moves.length) throw new Error('Choose a different destination.');
  for (const [index, move] of moves.entries()) {
    if (moves.slice(0, index).some((other) =>
      contains(other.path, move.path) || contains(move.path, other.path) || contains(other.to, move.to) || contains(move.to, other.to))) {
      throw new Error('Selected tokens have overlapping sources or destinations.');
    }
  }
  const relocations = moves.flatMap((move) => planMove(workspace, move));
  return workspace.files.map((entry) => {
    const options = { formattingOptions: formatOptions(entry.text) };
    let text = entry.text;
    for (const { from } of relocations) {
      if (entry.path === from.file) text = applyEdits(text, modify(text, from.path.split('.'), undefined, options));
    }
    for (const { to, node } of relocations) {
      if (entry.path === to.file) text = applyEdits(text, modify(text, to.path.split('.'), node, options));
    }
    text = rewriteReferences(entry.path, text, relocations);
    return text === entry.text ? entry : { path: entry.path, text, tree: parseTokenFile(text, entry.path) };
  });
}
