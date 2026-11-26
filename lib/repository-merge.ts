import { applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser';
import { isJsonObject, isRecord, isUnknownArray, parseJson } from './json.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import type { JsonValue } from './json.ts';
import { parseTokenFile } from './parse-token-file.ts';
import { formatOptions } from './structure.ts';

interface Source { readonly path: string; readonly text: string }
type Value = JsonValue | undefined;
export interface RepositoryConflict {
  id: string; file: string; parts: string[]; kind: 'value' | 'file';
  before: Value; draft: Value; repository: Value;
}
export interface RepositoryChoice { id: string; keep: 'draft' | 'repository' | 'custom'; value?: JsonValue }
export interface RepositoryChoiceDraft { id: string; keep: RepositoryChoice['keep']; text: string }
export const isRepositoryChoiceDraft = (value: unknown): value is RepositoryChoiceDraft => isRecord(value) && typeof value['id'] === 'string' && typeof value['text'] === 'string' &&
  typeof value['keep'] === 'string' && ['draft', 'repository', 'custom'].includes(value['keep']);
export function repositoryChoiceTarget(id: string): { file: string; kind: 'value' | 'file'; parts: string[] } | undefined {
  try {
    const parsed: unknown = JSON.parse(id.replace(/:[a-f0-9]{64}$/u, ''));
    return isUnknownArray(parsed) && parsed.length === 3 && typeof parsed[0] === 'string' && (parsed[1] === 'value' || parsed[1] === 'file') && isUnknownArray(parsed[2]) && parsed[2].every(part => typeof part === 'string') ? { file: parsed[0], kind: parsed[1], parts: parsed[2] } : undefined;
  } catch { return undefined; }
}
export const repositoryChoiceKey = (id: string) => { const target = repositoryChoiceTarget(id); return target ? JSON.stringify([target.file, target.kind, target.parts]) : id; };
export const repositoryDraft = (conflict: RepositoryConflict, drafts: readonly RepositoryChoiceDraft[]) => drafts.find(draft => draft.id === conflict.id) ?? drafts.find(draft => repositoryChoiceKey(draft.id) === repositoryChoiceKey(conflict.id));
export class RepositoryConflicts extends Error {
  readonly conflicts: RepositoryConflict[];
  constructor(conflicts: RepositoryConflict[]) {
    super((conflicts[0]?.file ?? 'A source file') + ' changed in the repository. Choose the definitions to keep before saving.');
    this.conflicts = conflicts;
  }
}
export class RepositoryReviewChanged extends RepositoryConflicts {
  constructor(conflicts: RepositoryConflict[]) { super(conflicts); this.message = 'The conflict values changed. Your input is retained; review the current definitions before applying it.'; }
}
function canonical(value: Value): unknown {
  if (value === undefined) return [false];
  if (Array.isArray(value)) return [true, value.map(canonical)];
  if (isJsonObject(value)) return [true, Object.fromEntries(Object.keys(value).toSorted().map(key => [key, canonical(value[key])]))];
  return [true, value];
}
function conflictRevision(before: Value, draft: Value, repository: Value) {
  return [...sha256(new TextEncoder().encode(JSON.stringify([before, draft, repository].map(canonical))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function equal(a: Value, b: Value): boolean {
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  return a === b;
}
interface Patch { parts: string[]; value: Value; raw?: string }
const own = (value: JsonValue | undefined, key: string): Value => isJsonObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
function changes(before: Value, after: Value, sources: readonly string[] = []): Patch[] {
  const trees = sources.map(text => ({ text, tree: parseTree(text) }));
  function walk(previous: Value, next: Value, parts: string[]): Patch[] {
    if (equal(previous, next)) return [];
    // A token value is one definition, including composites and references.
    if (isJsonObject(previous) && isJsonObject(next) && parts.at(-1) !== '$value') {
      return [...new Set([...Object.keys(previous), ...Object.keys(next)])].flatMap(key => walk(own(previous, key), own(next, key), [...parts, key]));
    }
    for (const { text, tree } of trees) {
      const node = tree && findNodeAtLocation(tree, parts);
      if (!node) continue;
      const raw = text.slice(node.offset, node.offset + node.length);
      if (equal(parseJson(raw), next)) return [{ parts, value: next, raw }];
    }
    return [{ parts, value: next }];
  }
  return walk(before, after, []);
}
function patched(text: string, patches: readonly Patch[]) {
  return patches.reduce((result, patch) => {
    const tree = parseTree(result);
    const node = tree && findNodeAtLocation(tree, patch.parts);
    if (node && patch.raw !== undefined) return result.slice(0, node.offset) + patch.raw + result.slice(node.offset + node.length);
    const updated = applyEdits(result, modify(result, patch.parts, patch.value, { formattingOptions: formatOptions(result) }));
    const nextTree = parseTree(updated);
    const created = nextTree && findNodeAtLocation(nextTree, patch.parts);
    return created && patch.raw !== undefined ? updated.slice(0, created.offset) + patch.raw + updated.slice(created.offset + created.length) : updated;
  }, text);
}

/** Merge authored definitions against the pinned repository baseline. */
export function mergeRepositorySources(baseline: readonly Source[], draftFiles: readonly Source[], repositoryFiles: readonly Source[], choices: readonly RepositoryChoice[] = []): Source[] {
  const base = new Map(baseline.map(file => [file.path, file.text]));
  const local = new Map(draftFiles.map(file => [file.path, file.text]));
  const remote = new Map(repositoryFiles.map(file => [file.path, file.text]));
  const selected = new Map(choices.map(choice => [choice.id, choice]));
  if (selected.size !== choices.length) throw new Error('Choose each repository conflict only once.');
  const conflicts: RepositoryConflict[] = [];
  let unresolved = false;
  function choose(file: string, parts: string[], kind: RepositoryConflict['kind'], before: Value, draft: Value, repository: Value): Value {
    const id = JSON.stringify([file, kind, parts]) + ':' + conflictRevision(before, draft, repository);
    conflicts.push({ id, file, parts, kind, before, draft, repository });
    const choice = selected.get(id);
    if (!choice) { unresolved = true; return repository; }
    if (choice.keep === 'draft') return draft;
    if (choice.keep === 'repository') return repository;
    if (choice.value === undefined) throw new Error('Enter a custom definition for ' + file + '.');
    return choice.value;
  }
  function merge(file: string, parts: string[], before: Value, draft: Value, repository: Value): Value {
    if (equal(draft, before)) return repository;
    if (equal(repository, before) || equal(draft, repository)) return draft;
    if ((isJsonObject(before) || before === undefined) && isJsonObject(draft) && isJsonObject(repository) && parts.at(-1) !== '$value') {
      if (['$type', '$extends', '$ref'].some(key => !equal(own(draft, key), own(repository, key)))) {
        // Type and inheritance define how the other fields are interpreted.
        // Keep them with the affected definition instead of constructing an
        // invalid value/type pair from independently selected fields.
        return choose(file, parts, 'value', before, draft, repository);
      }
      const result: Record<string, JsonValue> = {};
      for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(repository), ...Object.keys(draft)])) {
        const value = merge(file, [...parts, key], own(before, key), own(draft, key), own(repository, key));
        if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
      }
      return result;
    }
    return choose(file, parts, 'value', before, draft, repository);
  }
  const files: Source[] = [];
  for (const path of new Set([...remote.keys(), ...local.keys(), ...base.keys()])) {
    const before = base.get(path); const ours = local.get(path); const theirs = remote.get(path);
    let text: string | undefined;
    if (ours === before) text = theirs;
    else if (theirs === before || ours === theirs) text = ours;
    else if (before !== undefined && ours !== undefined && theirs !== undefined) {
      let parsed: { before: JsonValue; ours: JsonValue; theirs: JsonValue } | undefined;
      try { parsed = { before: parseTokenFile(before, path), ours: parseTokenFile(ours, path), theirs: parseTokenFile(theirs, path) }; }
      catch { /* Concurrent malformed text requires an explicit whole-file choice. */ }
      if (parsed) {
        // Use a side as the formatting anchor only when the other side can be
        // reproduced exactly by its definition changes. This keeps authored
        // whitespace/BOM/unknown fields instead of silently discarding them.
        const localExact = patched(before, changes(parsed.before, parsed.ours, [ours])) === ours;
        const remoteExact = patched(before, changes(parsed.before, parsed.theirs, [theirs])) === theirs;
        if (localExact || remoteExact) {
          const merged = merge(path, [], parsed.before, parsed.ours, parsed.theirs);
          const anchor = remoteExact ? ours : theirs;
          text = patched(anchor, changes(remoteExact ? parsed.ours : parsed.theirs, merged, [ours, theirs]));
        }
      }
      if (text === undefined) {
        const value = choose(path, [], 'file', before, ours, theirs);
        if (typeof value !== 'string') throw new Error('Enter source text for ' + path + '.');
        text = value;
      }
    } else {
      const value = choose(path, [], 'file', before, ours, theirs);
      if (value !== undefined && typeof value !== 'string') throw new Error('Enter source text for ' + path + '.');
      text = value;
    }
    if (text !== undefined) files.push({ path, text });
  }
  if (choices.some(choice => !conflicts.some(conflict => conflict.id === choice.id))) throw new RepositoryReviewChanged(conflicts);
  if (unresolved) throw new RepositoryConflicts(conflicts);
  return files;
}
