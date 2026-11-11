import { createTwoFilesPatch } from 'diff';
import { applyEdits, modify } from 'jsonc-parser';
import { changeDocument, inspectDocuments, nodeAt, parentPath } from './document.ts';
import { isJsonObject, parseJson, requireObject, requireValue } from './json.ts';
import type { JsonValue } from './json.ts';
import { parseTokenFile } from './parse-token-file.ts';
import { formatOptions, moveFiles } from './structure.ts';
import type { Move } from './structure.ts';
import type { TokenChange, TokenFile } from './token-types.ts';

interface Source { readonly path: string; readonly text: string }
interface WorkspaceFile extends TokenFile { text: string }

export interface Workspace {
  name: string;
  baseline: readonly Source[];
  files: readonly WorkspaceFile[];
  graph: ReturnType<typeof inspectDocuments>;
}

export interface FileChange {
  path: string;
  before: string;
  after: string;
}

export interface Review {
  file: string;
  diff: string;
  next: Workspace;
  path: string;
  impact: { path: string; before: JsonValue | undefined; after: JsonValue | undefined }[];
}

interface ValueChange { path: string; before: JsonValue; after: JsonValue }

function parseProposal(text: string): ValueChange[] {
  const { schemaVersion, changes } = requireObject(parseJson(text), 'token proposal');
  if (schemaVersion !== 1 || !Array.isArray(changes) || !changes.length) throw new Error('Expected a version 1 token proposal with at least one change.');
  const paths = new Set<string>();
  return changes.map((change: JsonValue) => {
    const { path, before, after } = requireObject(change, 'proposed value change');
    if (typeof path !== 'string' || !path || paths.has(path) || before === undefined || after === undefined) {
      throw new Error('Every proposed change needs a unique token path and its before and after values.');
    }
    paths.add(path);
    return { path, before, after };
  });
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(Object.keys(value).toSorted().map((key) => [key, canonical(requireValue(value[key], key))]));
}

function valueKey(value: JsonValue | undefined): string | undefined {
  return value === undefined ? undefined : JSON.stringify(canonical(value));
}

export function openWorkspace(name: string, sources: readonly Source[]): Workspace {
  const paths = new Set<string>();
  const files = sources.map(({ path, text }) => {
    if (/[\\:\r\n]/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..') || paths.has(path)) {
      throw new Error('Invalid or duplicate file path: ' + path);
    }
    paths.add(path);
    return { path, text, tree: parseTokenFile(text, path) };
  });
  return { name, baseline: files.map(({ path, text }) => ({ path, text })), files, graph: inspectDocuments(files) };
}

export function reviewEdit(workspace: Workspace, file: string, change: TokenChange): Review {
  const source = requireValue(workspace.files.find(({ path }) => path === file), 'destination file');
  const { path, create, node } = change;
  const { graph } = workspace;
  if (create && (graph.tokens.has(path) || graph.groups.has(path))) throw new Error('That name already exists in the workspace.');
  if (!create && graph.tokens.get(path)?.file !== file) throw new Error('The token belongs to another file or no longer exists.');
  if (!graph.groups.get(parentPath(path))?.files.has(file)) throw new Error('The destination file does not contain the parent group.');

  const candidate = editFile(source, change);
  const files = workspace.files.map((entry) => entry === source ? candidate : entry);
  return reviewFiles(workspace, files, new Set('$value' in node ? [path] : []), path);
}

export function reviewProposal(workspace: Workspace, text: string): Review {
  const changes = parseProposal(text);
  const sources = new Map(workspace.files.map((file) => [file.path, file]));
  for (const { path, before, after } of changes) {
    const token = requireValue(workspace.graph.tokens.get(path), 'token ' + path);
    if (valueKey(token.value) !== valueKey(before)) {
      throw new Error(path + ' changed since the proposal was created. Review against a fresh revision.');
    }
    const source = requireValue(sources.get(token.file), 'token file ' + token.file);
    sources.set(token.file, editFile(source, { path, create: false, node: { $value: after } }));
  }
  return reviewFiles(workspace, [...sources.values()], new Set(changes.map(({ path }) => path)), '');
}

export function reviewWorkspace(workspace: Workspace): Review {
  const original = openWorkspace(workspace.name, workspace.baseline);
  return reviewFiles(original, workspace.files, new Set(), '');
}

export function reviewMove(workspace: Workspace, move: Move): Review {
  return reviewFiles(workspace, moveFiles(workspace, move), new Set(), move.to);
}

function editFile(source: WorkspaceFile, change: TokenChange): WorkspaceFile {
  const { path, create } = change;

  const tree = changeDocument(source.tree, change);
  const location = path.split('.');
  const next = requireObject(nodeAt(tree, path), path);
  const formattingOptions = formatOptions(source.text);
  let text = source.text;
  if (create) text = applyEdits(text, modify(text, location, next, { formattingOptions }));
  else {
    const previous = requireObject(nodeAt(source.tree, path), path);
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
        text = applyEdits(text, modify(text, [...location, key], next[key], { formattingOptions }));
      }
    }
  }
  return text === source.text ? source : { path: source.path, text, tree: parseTokenFile(text, source.path) };
}

function reviewFiles(workspace: Workspace, files: readonly WorkspaceFile[], editedValues: ReadonlySet<string>, path: string): Review {
  const changes = workspaceChanges({ baseline: workspace.files, files });
  if (!changes.length) throw new Error('There are no changes to review.');
  const updated = inspectDocuments(files);
  for (const [id, issue] of updated.issues) {
    if (workspace.graph.issues.get(id) !== issue || editedValues.has(id)) throw new Error(id + ' · ' + issue);
  }
  const impact = [...new Set([...workspace.graph.resolved.keys(), ...updated.resolved.keys()])].flatMap((id) => {
    const before = workspace.graph.resolved.get(id);
    const after = updated.resolved.get(id);
    return valueKey(before) === valueKey(after) ? [] : [{ path: id, before, after }];
  });
  return { file: changes.map((change) => change.path).join(', '), path, diff: changes.map(diffFile).join(''), impact, next: { ...workspace, files, graph: updated } };
}

export function workspaceChanges({ baseline, files }: Pick<Workspace, 'baseline' | 'files'>): FileChange[] {
  const before = new Map(baseline.map(({ path, text }) => [path, text]));
  return files.flatMap(({ path, text }) => {
    const original = requireValue(before.get(path), 'original file ' + path);
    return original === text ? [] : [{ path, before: original, after: text }];
  });
}

export function diffFile({ path, before, after }: FileChange): string {
  return createTwoFilesPatch('a/' + path, 'b/' + path, before, after);
}
