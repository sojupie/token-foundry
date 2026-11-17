import { createTwoFilesPatch } from 'diff';
import { applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser';
import { compareContexts, compileResolver, equivalentResolverChoices, isResolverFile, newResolverDocument, resolveResolver, resolverInputs } from './resolver.ts';
import { diagnosticKey } from './document-diagnostics.ts';
import { changeDocument, inspectDocuments, nodeAt, parentPath, referenceLabel, referenceProblems } from './document.ts';
import { serializeTokenPointer, tokenPointer } from './token-path.ts';
import { errorMessage, isJsonObject, parseJson, requireObject, requireValue } from './json.ts';
import type { JsonObject, JsonValue } from './json.ts';
import { parseTokenFile, TokenFileError } from './parse-token-file.ts';
import { copyEntries, formatOptions, moveFiles, pasteFiles, rewriteSetPointers, rewriteSourcePointers } from './structure.ts';
import type { ClipboardEntry, Move } from './structure.ts';
import { dtcgTypes } from './token-types.ts';
import { tokenFieldType, validateTokenValue } from './validate-token.ts';
import type { TokenChange, TokenFile } from './token-types.ts';

interface Source { readonly path: string; readonly text: string }
interface WorkspaceFile extends TokenFile {
  text: string;
  parseIssue?: { message: string; offset: number };
}

function inspectFiles(files: readonly WorkspaceFile[], authoredSource?: string): Workspace['graph'] {
  if (authoredSource) {
    return inspectDocuments(files.filter(file => !file.parseIssue && !isResolverFile(file)), authoredSource);
  }
  const ready = files.filter(file => !file.parseIssue);
  const manifests = ready.filter(isResolverFile);
  const contextual = new Set<string>();
  const models = manifests.map(resolver => compileResolver(resolver, ready));
  for (const model of models) for (const file of model.sourceFiles) contextual.add(file);
  const standalone = ready.filter(file => !contextual.has(file.path));
  const standalonePaths = new Set(standalone.map(file => file.path));
  const graph = inspectDocuments(standalone.length && models.length
    ? [...standalone, ...ready.filter(file => contextual.has(file.path) && !isResolverFile(file))]
    : standalone);
  if (models.length) {
    // Standalone tokens can refer to open source documents. Resolver overrides
    // and diagnostics are assessed in their composed contexts.
    graph.documentDiagnostics = graph.documentDiagnostics.filter(issue => standalonePaths.has(issue.file));
    for (const [path, token] of graph.tokens) {
      if (standalonePaths.has(token.file)) continue;
      graph.resolved.delete(path);
      graph.issues.delete(path);
      graph.referenceIssues.delete(path);
      graph.validation.delete(path);
    }
  }
  for (const model of models) {
    for (const issue of model.issues) {
      graph.documentDiagnostics.push({
        file: issue.file, path: '', field: issue.parts.join('/'), sourcePath: issue.parts,
        message: issue.message, severity: issue.severity, target: { kind: 'source', path: '' },
      });
    }
  }
  for (const file of files) {
    if (!file.parseIssue) continue;
    graph.documentDiagnostics.push({
      file: file.path, path: '', field: '', severity: 'error', target: { kind: 'source', path: '' },
      ...file.parseIssue,
    });
  }
  return graph;
}

export interface Workspace {
  name: string;
  baseline: readonly Source[];
  files: readonly WorkspaceFile[];
  graph: ReturnType<typeof inspectDocuments>;
  authoredSource?: string | undefined;
}

export function scopeWorkspace(workspace: Workspace, authoredSource?: string): Workspace {
  return workspace.authoredSource === authoredSource ? workspace :
    { ...workspace, authoredSource, graph: inspectFiles(workspace.files, authoredSource) };
}

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

export interface Review {
  file: string;
  diff: string;
  next: Workspace;
  path: string;
  impact: { path: string; before: JsonValue | undefined; after: JsonValue | undefined }[];
  importedValues?: readonly ValueChange[];
  pasteGroup?: string;
  bulk?: { label: string; selected: number; records: readonly { path: string; before: JsonValue | undefined; after: JsonValue | undefined }[] };
  uninspectedSources: readonly string[];
  inheritanceImpact: { path: string; change: 'Added' | 'Removed' | 'Source changed' }[];
  validationErrors?: readonly string[];
  contextImpact?: readonly { label: string; changes: ReturnType<typeof compareContexts>; errors: string[]; matching?: string[] }[];
  typeImpact: { path: string; before: string | undefined; after: string | undefined }[];
  structure?: {
    title: string;
    paths: readonly { from: string; to?: string }[];
    tokens?: number;
    files: number;
    referencesUpdated?: number;
  };
}

interface ValueChange { path: string; before: JsonValue; after: JsonValue }

function parseProposal(text: string): ValueChange[] {
  let document: JsonValue;
  try {
    document = parseJson(text);
  } catch (failure) {
    throw new Error('Invalid JSON. Choose a .json file with token value changes.', { cause: failure });
  }
  if (!isJsonObject(document) || document['schemaVersion'] !== 1 ||
    !Array.isArray(document['changes']) || !document['changes'].length) {
    throw new Error('No token value changes found. Choose a .json file with old and new values. To open token files, use File → Open token files.');
  }
  const paths = new Set<string>();
  return document['changes'].map((change: JsonValue, index: number) => {
    const { path, before, after } = isJsonObject(change) ? change : {};
    if (typeof path !== 'string' || !path || paths.has(path) || before === undefined || after === undefined) {
      throw new Error('Invalid change at entry ' + (index + 1) + '. List each token once with its old and new values.');
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
    try {
      return { path, text, tree: parseTokenFile(text, path) };
    } catch (failure) {
      if (!(failure instanceof TokenFileError)) throw failure;
      return { path, text, tree: {}, parseIssue: { message: failure.message, offset: failure.offset } };
    }
  });
  return { name, baseline: files.map(({ path, text }) => ({ path, text })), files, graph: inspectFiles(files) };
}

export function reviewEdit(workspace: Workspace, file: string, change: TokenChange): Review {
  const source = requireValue(workspace.files.find(({ path }) => path === file), 'destination file');
  const { path, create, node } = change;
  const { graph } = workspace;
  if (create && (graph.tokens.has(path) || graph.groups.has(path))) throw new Error('That name already exists in the workspace.');
  if (!create && graph.tokens.get(path)?.file !== file) throw new Error('The token belongs to another file or no longer exists.');
  const token = graph.tokens.get(path);
  const parent = graph.groups.get(parentPath(path));
  if (!parent?.files.has(file) && !(token?.inheritedFrom && parent?.definitions.has(file))) {
    throw new Error('The destination file does not contain the parent group.');
  }
  const candidate = token?.inheritedFrom ? overrideToken(source, token, change) : editFile(source, change);
  const files = workspace.files.map((entry) => entry === source ? candidate : entry);
  return reviewFiles(workspace, files, new Set('$value' in node || '$type' in node || change.inheritType ? [path] : []), path);
}

export type MetadataChange = Partial<Record<'$description' | '$type' | '$extensions' | '$deprecated' | '$extends' | '$ref', JsonValue | undefined>>;

function updateMetadataFile(workspace: Workspace, file: string, path: string, changes: MetadataChange) {
  const source = requireValue(workspace.files.find(entry => entry.path === file), 'source file');
  const token = workspace.graph.tokens.get(path);
  const group = workspace.graph.groups.get(path)?.definitions.get(file);
  if (token ? token.file !== file : !group) {
    throw new Error('Choose the authored source of this token or group.');
  }
  const location = path ? path.split('.') : [];
  const options = { formattingOptions: formatOptions(source.text) };
  let text = token?.inheritedFrom ? overrideToken(source, token, { path, node: {}, create: false }).text : source.text;
  for (const [key, value] of Object.entries(changes)) {
    text = applyEdits(text, modify(text, [...location, key], value, options));
  }
  return { text, token, group };
}

export function reviewMetadata(workspace: Workspace, file: string, path: string, changes: MetadataChange): Review {
  const { text, token, group } = updateMetadataFile(workspace, file, path, changes);
  const review = reviewSource(workspace, file, text, !!group && Object.hasOwn(changes, '$type'));
  return token ? { ...review, path } : review;
}

export function reviewMetadataChanges(workspace: Workspace, path: string, changes: ReadonlyMap<string, MetadataChange>): Review {
  if (changes.size === 1) {
    const entry = requireValue(changes.entries().next().value, 'metadata changes');
    return reviewMetadata(workspace, entry[0], path, entry[1]);
  }
  const files = workspace.files.map(file => {
    const patch = changes.get(file.path);
    if (!patch) return file;
    const { text } = updateMetadataFile(workspace, file.path, path, patch);
    return { ...file, text, tree: parseTokenFile(text, file.path) };
  });
  return reviewAffectedResolvers(workspace, reviewFiles(workspace, files, new Set(), path, { rejectNewInvalid: true, previewValidation: true }));
}

function rebaseReferences(value: JsonValue, from: string, to: string): JsonValue {
  if (from === to) return value;
  if (Array.isArray(value)) return value.map(item => rebaseReferences(item, from, to));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === '$ref' && typeof item === 'string') {
      const target = tokenPointer(item, from);
      return [key, serializeTokenPointer(to, target.file, target.parts)];
    }
    return [key, item === undefined ? undefined : rebaseReferences(item, from, to)];
  }));
}

function overrideToken(file: WorkspaceFile, token: Workspace['graph']['rows'][number][1], change: TokenChange): WorkspaceFile {
  const from = requireValue(token.inheritedFrom, 'inherited token source').file;
  const original: JsonObject = { ...token.authoredNode };
  if (original['$value'] !== undefined) original['$value'] = rebaseReferences(original['$value'], from, file.path);
  if (typeof original['$ref'] === 'string') {
    const target = tokenPointer(original['$ref'], from);
    original['$ref'] = serializeTokenPointer(file.path, target.file, target.parts);
  }
  const node = { ...original, ...change.node };
  if (Object.hasOwn(change.node, '$value')) delete node.$ref;
  if (change.inheritType) delete node.$type;
  const options = { formattingOptions: formatOptions(file.text) };
  const text = applyEdits(file.text, modify(file.text, change.path.split('.'), node, options));
  return { path: file.path, text, tree: parseTokenFile(text, file.path) };
}

function reviewSourceChange(workspace: Workspace, file: string, text: string, previewValidation: boolean): Review {
  const previous = requireValue(workspace.files.find(source => source.path === file), 'source file');
  const tree = parseTokenFile(text, file);
  const files = workspace.files.map(source => source === previous ? { path: file, text, tree } : source);
  const changedPaths = new Set<string>();
  for (const [path, entry] of workspace.graph.tokens) {
    if (entry.file !== file) continue;
    const before = nodeAt(previous.tree, path);
    const next = nodeAt(tree, path);
    if (isJsonObject(before) && isJsonObject(next) &&
      ['$value', '$type', '$ref'].some(field => valueKey(next[field]) !== valueKey(before[field]))) changedPaths.add(path);
  }
  return reviewFiles(workspace, files, changedPaths, '', { rejectNewInvalid: true, previewValidation });
}

export function reviewSource(workspace: Workspace, file: string, text: string, previewValidation = false, scope?: ResolverEditScope): Review {
  const next = reviewAffectedResolvers(workspace, reviewSourceChange(workspace, file, text, previewValidation), scope);
  if (!previewValidation && next.validationErrors?.length) throw new Error(next.validationErrors.join('\n'));
  return next;
}

export interface ResolverEditScope {
  file: string;
  labelPrefix?: string;
  contexts: readonly { label: string; inputs: Readonly<Record<string, JsonValue | undefined>> }[];
}

type ResolverModel = ReturnType<typeof compileResolver>;
type ResolverInputs = Readonly<Record<string, JsonValue | undefined>>;

function chooseResolverInputs(model: ResolverModel, requested: ResolverInputs) {
  const { contexts } = resolverInputs(model, requested);
  for (const [name, modifier] of model.modifiers) {
    const value = modifier.contexts.keys().next().value;
    if (value !== undefined && !contexts.has(name)) contexts.set(name, value);
  }
  return contexts;
}

function graphProblems(graph: Workspace['graph'], path: string) {
  const issue = graph.issues.get(path);
  return new Set([...(issue ? referenceProblems(graph, path, issue) : []), ...graph.validation.get(path) ?? []]);
}

const inputKey = (values: Map<string, string>) => JSON.stringify([...values].toSorted(([left], [right]) => left.localeCompare(right)));

function* activeContextCombinations(previous: ResolverModel, next: ResolverModel, starting: Map<string, string>) {
  const modifiers = next.order.filter(entry => entry.kind === 'modifier').map(({ name }) => ({
    name, choices: equivalentResolverChoices(previous, next, name, starting.get(name)),
  }));
  const inputs = new Map(starting);
  function* visit(index: number): Generator<Map<string, string>> {
    const modifier = modifiers[index];
    if (!modifier) { yield inputs; return; }
    for (const value of modifier.choices) {
      inputs.set(modifier.name, value);
      yield* visit(index + 1);
    }
  }
  yield* visit(0);
}

function appendResolverImpact(review: Review, previous: ResolverModel, next: ResolverModel, scope: ResolverEditScope) {
  const active = scope.contexts[0];
  const selected = chooseResolverInputs(next, active?.inputs ?? {});
  const contexts = [...scope.contexts];
  const explicit = new Set(contexts.map(context => inputKey(chooseResolverInputs(next, context.inputs))));
  for (const modifier of next.modifiers.values()) {
    for (const context of modifier.contexts.keys()) {
      const variation = new Map(selected).set(modifier.name, context);
      if (explicit.has(inputKey(variation))) continue;
      explicit.add(inputKey(variation));
      contexts.push({ label: (scope.labelPrefix ?? '') + modifier.name + ' / ' + context, inputs: Object.fromEntries(variation) });
    }
  }
  const validationErrors = [...review.validationErrors ?? []];
  const contextImpact: NonNullable<Review['contextImpact']>[number][] = [];
  const graphCache = new Map<string, Workspace['graph']>();
  const matchingImpacts = new Map<string, (typeof contextImpact)[number]>();
  function inspectComposition(files: readonly TokenFile[]) {
    const key = JSON.stringify(files);
    const cached = graphCache.get(key);
    if (cached) return cached;
    const graph = inspectDocuments(files);
    // Repeated compositions share validation. Bound retained graph memory
    // independently of the number of combinations that need checking.
    if (graphCache.size === 16) graphCache.clear();
    graphCache.set(key, graph);
    return graph;
  }
  function inspect({ label, inputs }: ResolverEditScope['contexts'][number], showUnchanged: boolean) {
    const before = resolveResolver(previous, Object.fromEntries(chooseResolverInputs(previous, inputs)), inspectComposition);
    const after = resolveResolver(next, Object.fromEntries(chooseResolverInputs(next, inputs)), inspectComposition);
    const changes = before.errors.length || after.errors.length ? [] : compareContexts(before, after).filter(change =>
      change.kind !== 'Invalid' || change.beforeProblem !== change.afterProblem);
    const problems: string[] = [];
    for (const path of new Set([...after.graph.issues.keys(), ...after.graph.validation.keys()])) {
      const existing = graphProblems(before.graph, path);
      for (const problem of graphProblems(after.graph, path)) {
        if (!existing.has(problem)) problems.push(path + ' · ' + problem);
      }
    }
    const existingDiagnostics = new Set(before.graph.documentDiagnostics.map(diagnosticKey));
    for (const issue of after.graph.documentDiagnostics) {
      if (issue.severity === 'error' && !existingDiagnostics.has(diagnosticKey(issue))) {
        problems.push(issue.path + ' · ' + issue.field + ' · ' + issue.message);
      }
    }
    if (!showUnchanged && !changes.length && !problems.length) return;
    const impact = { label, changes, errors: after.errors };
    if (!showUnchanged) {
      const key = JSON.stringify([changes, after.errors, problems]);
      const existing = matchingImpacts.get(key);
      if (existing) {
        (existing.matching ??= []).push(label);
        return;
      }
      matchingImpacts.set(key, impact);
    }
    validationErrors.push(...problems.map(problem => label + ' · ' + problem));
    contextImpact.push(impact);
  }
  for (const context of contexts) inspect(context, true);
  for (const combination of activeContextCombinations(previous, next, selected)) {
    const key = inputKey(combination);
    if (explicit.has(key)) continue;
    const alternatives = [...combination].filter(([name, value]) => value !== selected.get(name));
    const label = (scope.labelPrefix ?? '') + alternatives.map(([name, value]) => name + ' / ' + value).join(' · ');
    inspect({ label: label || scope.file, inputs: Object.fromEntries(combination) }, false);
  }
  review.contextImpact = [...review.contextImpact ?? [], ...contextImpact];
  if (validationErrors.length || review.validationErrors !== undefined) review.validationErrors = [...new Set(validationErrors)];
  return review;
}

export function reviewAffectedResolvers(workspace: Workspace, review: Review, scope?: ResolverEditScope, renamed?: { from: string; to: string }): Review {
  const current = review.next.files.filter(file => !file.parseIssue);
  const resolvers = current.filter(isResolverFile);
  if (!resolvers.length) return review;
  const previous = workspace.files.filter(file => !file.parseIssue);
  const changed = new Set(workspaceChanges({ baseline: workspace.files, files: review.next.files }).map(change => change.path));
  for (const manifest of resolvers) {
    const originalPath = manifest.path === renamed?.to ? renamed.from : manifest.path;
    const original = previous.find(file => file.path === originalPath && isResolverFile(file));
    const before = compileResolver(original ?? { path: manifest.path, tree: newResolverDocument(manifest.path) }, previous);
    const after = compileResolver(manifest, current);
    if (!changed.has(manifest.path) && ![...before.sourceFiles, ...after.sourceFiles].some(path => changed.has(path))) continue;
    const display = scope?.file === manifest.path ? scope : {
      file: manifest.path, labelPrefix: manifest.path + ' · ', contexts: [{ label: manifest.path, inputs: {} }],
    };
    appendResolverImpact(review, before, after, display);
  }
  return review;
}

export function reviewResolverValue(workspace: Workspace, file: string, parts: readonly string[],
  value: JsonValue, insert = false): Review {
  const source = requireValue(workspace.files.find(entry => entry.path === file), 'source file');
  const location: (string | number)[] = [];
  let current: JsonValue | undefined = source.tree;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      location.push(index);
      current = current[index];
    } else {
      location.push(part);
      current = isJsonObject(current) && Object.hasOwn(current, part) ? current[part] : undefined;
    }
  }
  const text = applyEdits(source.text, modify(source.text, location, value, {
    formattingOptions: formatOptions(source.text), isArrayInsertion: insert,
  }));
  return reviewSourceChange(workspace, file, text, true);
}

export type BulkEdit =
  | { kind: 'value'; value: JsonValue; pointer?: string; referenceFile?: string; replaceLinks?: boolean }
  | { kind: 'description'; value: string }
  | { kind: 'type'; value: string; replacement?: JsonValue; referenceFile?: string };

export function needsBulkReplacement(graph: Workspace['graph'], path: string, type: string) {
  const token = requireValue(graph.tokens.get(path), 'selected token');
  const resolved = graph.resolved.get(path);
  return !!(token.referenceType && token.referenceType !== type ||
    validateTokenValue(type, token.value, true) || validateTokenValue(type, resolved));
}

export function optionalValueFields(type: string | undefined): readonly string[] {
  return type === 'color' ? ['alpha', 'hex'] : type === 'shadow' || type === 'shadowLayer' ? ['inset'] : [];
}

function replaceValueField(value: JsonValue, parts: readonly string[], replacement: JsonValue, type: string | undefined): { previous: JsonValue | undefined; value: JsonValue } {
  const [part, ...rest] = parts;
  if (part === undefined) return { previous: value, value: replacement };
  const childType = tokenFieldType(type, [part]);
  if (Array.isArray(value) && /^(0|[1-9][0-9]*)$/u.test(part) && Number(part) < value.length) {
    const index = Number(part);
    const next = replaceValueField(requireValue(value[index], part), rest, replacement, childType);
    return { previous: next.previous, value: value.with(index, next.value) };
  }
  if (isJsonObject(value) && !Object.hasOwn(value, '$ref')) {
    if (!Object.hasOwn(value, part) && !rest.length && optionalValueFields(type).includes(part)) {
      return { previous: undefined, value: { ...value, [part]: replacement } };
    }
    if (!Object.hasOwn(value, part)) throw new Error('The field is missing.');
    const next = replaceValueField(requireValue(value[part], part), rest, replacement, childType);
    return { previous: next.previous, value: { ...value, [part]: next.value } };
  }
  throw new Error('The field is missing or is inside a reference.');
}

export function reviewBulkEdit(workspace: Workspace, selection: readonly string[], edit: BulkEdit): Review {
  const paths = [...new Set(selection)];
  const pointer = edit.kind === 'value' ? edit.pointer : undefined;
  if (pointer && (!pointer.startsWith('/') || /~(?![01])/u.test(pointer))) {
    throw new Error('Enter a JSON Pointer such as /width/value.');
  }
  if (edit.kind === 'type' && !dtcgTypes.some(type => type === edit.value)) throw new Error('Choose a DTCG token type.');
  const parts = pointer?.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~')) ?? [];
  const records: NonNullable<Review['bulk']>['records'][number][] = [];
  const errors: string[] = [];
  const changes = new Map<string, TokenChange[]>();
  const label = edit.kind === 'description' ? 'Description' : edit.kind === 'type' ? 'Token type' : pointer || 'Token value';

  for (const path of paths) {
    try {
      const token = requireValue(workspace.graph.tokens.get(path), 'selected token');
      let before: JsonValue | undefined;
      let node: JsonObject;
      let after: JsonValue | undefined;
      if (edit.kind === 'description') {
        before = token.authoredNode['$description'];
        node = { $description: edit.value || undefined };
        after = node['$description'];
      } else if (edit.kind === 'type') {
        before = token.type;
        after = edit.value;
        node = { $type: edit.value };
        if (edit.replacement !== undefined && needsBulkReplacement(workspace.graph, path, edit.value)) {
          before = token.value;
          after = edit.referenceFile ? rebaseReferences(edit.replacement, edit.referenceFile, token.file) : edit.replacement;
          node['$value'] = after;
        }
      } else if (parts.length) {
        const linked = referenceLabel(token.value) || token.authoredNode['$value'] === undefined;
        const literal = edit.replaceLinks && linked ? workspace.graph.resolved.get(path) : token.authoredNode['$value'];
        if (!tokenFieldType(token.type, parts) || literal === undefined) {
          throw new Error('The field is unavailable for this authored value.');
        }
        const usable = token.inheritedFrom && !(edit.replaceLinks && linked) ?
          rebaseReferences(literal, token.inheritedFrom.file, token.file) : literal;
        after = edit.referenceFile ? rebaseReferences(edit.value, edit.referenceFile, token.file) : edit.value;
        const updated = replaceValueField(usable, parts, after, token.type);
        before = linked ? token.value : replaceValueField(literal, parts, after, token.type).previous;
        node = { $value: updated.value };
      } else {
        before = token.value;
        after = edit.referenceFile ? rebaseReferences(edit.value, edit.referenceFile, token.file) : edit.value;
        node = { $value: after };
      }
      if (valueKey(before) === valueKey(after) && (edit.kind !== 'type' || token.type === edit.value)) continue;
      const group = changes.get(token.file) ?? [];
      group.push({ path, create: false, node });
      changes.set(token.file, group);
      records.push({ path, before, after });
    } catch (failure) {
      errors.push(path + ' · ' + errorMessage(failure));
    }
  }
  if (!records.length) throw new Error(errors.length ? errors.join('\n') : 'The selected tokens already have that value.');

  const files = workspace.files.map(file => {
    const updates = changes.get(file.path);
    if (!updates) return file;
    const ast = requireValue(parseTree(file.text), 'source document');
    const formattingOptions = formatOptions(file.text);
    const edits = updates.flatMap(change => {
      if (workspace.graph.tokens.get(change.path)?.inheritedFrom) return [];
      const location = requireValue(findNodeAtLocation(ast, change.path.split('.')), change.path);
      const original = file.text.slice(location.offset, location.offset + location.length);
      const indent = lineIndent(file.text, location.offset);
      const sourceLines = original.split(/(?<=\n)/u);
      let text = sourceLines.map((line, index) => index && line.startsWith(indent) ? line.slice(indent.length) : line).join('');
      for (const [key, value] of Object.entries(change.node)) {
        text = applyEdits(text, modify(text, [key], value, { formattingOptions }));
      }
      if (Object.hasOwn(change.node, '$value')) {
        text = applyEdits(text, modify(text, ['$ref'], undefined, { formattingOptions }));
      }
      return [{ offset: location.offset, length: location.length, content: text.replaceAll('\n', '\n' + indent) }];
    });
    const text = applyEdits(file.text, edits);
    let source = { ...file, text, tree: parseTokenFile(text, file.path) };
    for (const change of updates) {
      const token = workspace.graph.tokens.get(change.path);
      if (token?.inheritedFrom) source = overrideToken(source, token, change);
    }
    return source;
  });
  const strictValues = edit.kind === 'description' || pointer ? [] : records.map(record => record.path);
  const review = reviewFiles(workspace, files, new Set(strictValues), '', { previewValidation: true });
  if (pointer) {
    const field = '$value' + pointer;
    for (const { path } of records) {
      const previous = new Set([...workspace.graph.validation.get(path) ?? [], ...workspace.graph.referenceIssues.get(path)?.values() ?? []]);
      const problems = [...review.next.graph.validation.get(path) ?? [], ...review.next.graph.referenceIssues.get(path)?.values() ?? []];
      for (const problem of problems) {
        const location = problem.split(' · ', 1)[0];
        if (!previous.has(problem) || location === field || location?.startsWith(field + '/')) errors.push(path + ' · ' + problem);
      }
    }
  }
  review.bulk = { label, selected: paths.length, records };
  review.validationErrors = [...new Set([...errors, ...review.validationErrors ?? []])];
  return review;
}

export function reviewProposal(workspace: Workspace, text: string): Review {
  const changes = parseProposal(text).filter(({ before, after }) => valueKey(before) !== valueKey(after));
  if (!changes.length) throw new Error('The file lists the same values before and after.');
  const missing = changes.filter(({ path }) => !workspace.graph.tokens.has(path));
  if (missing.length) {
    throw new Error('Tokens missing. Open the files that contain them together, then import again.\n' +
      missing.map(({ path }) => path).join('\n'));
  }
  const sources = new Map(workspace.files.map((file) => [file.path, file]));
  for (const { path, before, after } of changes) {
    const token = requireValue(workspace.graph.tokens.get(path), 'token ' + path);
    if (valueKey(token.value) !== valueKey(before)) {
      throw new Error('Value mismatch for ' + path + '. Check the open token file and the old value in the import.');
    }
    const source = requireValue(sources.get(token.file), 'token file ' + token.file);
    const change = { path, create: false, node: { $value: after } };
    sources.set(token.file, token.inheritedFrom ? overrideToken(source, token, change) : editFile(source, change));
  }
  const review = reviewFiles(workspace, [...sources.values()], new Set(changes.map(({ path }) => path)), '');
  return { ...review, importedValues: changes };
}

export function reviewCreateSource(workspace: Workspace, path: string, text: string): Review {
  if (workspace.files.some(file => file.path.startsWith(path + '/') || path.startsWith(file.path + '/'))) {
    throw new Error('The destination conflicts with an open source file.');
  }
  const next = openWorkspace(workspace.name, [...workspace.files, { path, text }]);
  return reviewAffectedResolvers(workspace, reviewFiles(workspace, next.files, new Set(), '', { rejectNewInvalid: true }));
}

export function reviewSourcePath(workspace: Workspace, from: string, to?: string): Review {
  const source = requireValue(workspace.files.find(file => file.path === from), 'source file');
  if (to === from) throw new Error('Enter a different path.');
  if (!to && workspace.files.length === 1) throw new Error('Create another source file before removing the last one.');
  if (to && workspace.files.some(file => file.path === to || file.path.startsWith(to + '/') || to.startsWith(file.path + '/'))) {
    throw new Error('The destination conflicts with an open source file.');
  }
  let referencesUpdated = 0;
  const updated = workspace.files.flatMap(file => {
    if (!to) return file === source ? [] : [file];
    const { text, count } = rewriteSourcePointers(file, from, to);
    referencesUpdated += count;
    const path = file === source ? to : file.path;
    if (path === file.path && text === file.text) return [file];
    return [{ ...file, path, text, tree: text === file.text ? file.tree : parseTokenFile(text, path) }];
  });
  if (to) openWorkspace(workspace.name, [{ path: to, text: source.text }]);
  const review = reviewAffectedResolvers(workspace,
    reviewFiles(workspace, updated, new Set(), '', { previewValidation: true, ...(to ? { sourceMove: { from, to } } : {}) }),
    undefined, to ? { from, to } : undefined);
  const action = !to ? 'Remove' : from.slice(0, from.lastIndexOf('/') + 1) === to.slice(0, to.lastIndexOf('/') + 1) ? 'Rename' : 'Move';
  return { ...review, structure: {
    title: action + ' source file', paths: [to ? { from, to } : { from }],
    files: updated.filter(file => !workspace.files.includes(file)).length + (to ? 0 : 1),
    referencesUpdated,
  } };
}

function lineIndent(text: string, offset: number) {
  return /^[ \t]*/u.exec(text.slice(text.lastIndexOf('\n', offset) + 1, offset))?.[0] ?? '';
}

export function reviewSetPath(workspace: Workspace, resolver: string, from: string, destination?: string, targetFile = resolver): Review {
  const definition = requireValue(workspace.files.find(file => file.path === resolver && isResolverFile(file)), 'Resolver document');
  const target = requireValue(workspace.files.find(file => file.path === targetFile && isResolverFile(file) && !file.parseIssue), 'destination Resolver');
  const sets = requireObject(definition.tree['sets'], 'named sets');
  if (!Object.hasOwn(sets, from)) throw new Error('Choose an existing set.');
  const to = destination?.trim();
  const move = targetFile !== resolver;
  const destinationSets = target.tree['sets'];
  if (destinationSets !== undefined && !isJsonObject(destinationSets)) throw new Error('Repair the destination’s named sets before moving this set.');
  if (destination !== undefined && (!to || destinationSets && Object.hasOwn(destinationSets, to))) {
    throw new Error('Enter a unique set name in the destination.');
  }
  if (move && !to) throw new Error('Enter a name for the moved set.');
  let referencesUpdated = 0;
  const rewritten = workspace.files.map(file => {
    if (!to) return file;
    const { text, count } = rewriteSetPointers(file, { file: resolver, name: from }, { file: targetFile, name: to });
    referencesUpdated += count;
    return text === file.text ? file : { path: file.path, text, tree: parseTokenFile(text, file.path) };
  });
  const sourceText = requireValue(rewritten.find(file => file.path === resolver), 'source Resolver').text;
  const sourceAST = requireValue(parseTree(sourceText), 'Resolver source');
  const sourceNode = requireValue(findNodeAtLocation(sourceAST, ['sets', from]), 'named set');
  const files = rewritten.map(file => {
    if (file.path !== resolver && file.path !== targetFile) return file;
    const formattingOptions = formatOptions(file.text);
    let text = file.text;
    if (file.path === resolver) {
      if (to && !move) {
        const key = requireValue(sourceNode.parent?.children?.[0], 'set name');
        text = applyEdits(text, [{ offset: key.offset, length: key.length, content: JSON.stringify(to) }]);
      } else text = applyEdits(text, modify(text, ['sets', from], undefined, { formattingOptions }));
    } else if (move && to) {
      text = applyEdits(text, modify(text, ['sets', to], null, { formattingOptions }));
      const targetAST = requireValue(parseTree(text), 'destination Resolver');
      const slot = requireValue(findNodeAtLocation(targetAST, ['sets', to]), 'destination set');
      const raw = sourceText.slice(sourceNode.offset, sourceNode.offset + sourceNode.length);
      const beforeIndent = lineIndent(sourceText, sourceNode.offset);
      const afterIndent = lineIndent(text, slot.offset);
      const moved = raw.split(/\r?\n/u).map((line, index) =>
        !index ? line : afterIndent + (line.startsWith(beforeIndent) ? line.slice(beforeIndent.length) : line))
        .join(formattingOptions.eol);
      text = applyEdits(text, [{ offset: slot.offset, length: slot.length, content: moved }]);
    }
    return text === file.text ? file : { path: file.path, text, tree: parseTokenFile(text, file.path) };
  });
  const review = reviewFiles(workspace, files, new Set(), '', { previewValidation: true });
  const paths = move && to ? [{
    from: resolver + ' · ' + from,
    to: targetFile + ' · ' + to,
  }] : [to ? { from, to } : { from }];
  return { ...review, structure: {
    title: move ? 'Review set move' : to ? 'Review set rename' : 'Review set removal',
    paths,
    files: workspaceChanges({ baseline: workspace.files, files }).length,
    referencesUpdated,
  } };
}

function reviewSavedFiles(original: Workspace, files: readonly WorkspaceFile[]) {
  return reviewAffectedResolvers(original,
    reviewFiles(original, files, new Set(), '', { rejectNewInvalid: true, previewValidation: true, settled: true }));
}

export function reviewWorkspace(workspace: Workspace): Review {
  const original = openWorkspace(workspace.name, workspace.baseline);
  return reviewSavedFiles(original, workspace.files);
}

export function reviewRepositorySources(name: string, baseline: readonly Source[], sources: readonly Source[]): Review {
  return reviewSavedFiles(openWorkspace(name, baseline), openWorkspace(name, sources).files);
}

export function reviewAgainstLatest(workspace: Workspace, latest: Workspace): Review | null {
  const files = new Map(latest.files.map((file) => [file.path, file]));
  let remaining = false;
  for (const { path, before, after } of workspaceChanges(workspace)) {
    const file = files.get(path);
    const current = file?.text ?? null;
    if (current === after) continue;
    if (current !== before) {
      throw new Error(path + ' changed in the repository. Download the patch to merge your edits locally.');
    }
    if (after === null) files.delete(path);
    else files.set(path, { path, text: after, tree: parseTokenFile(after, path) });
    remaining = true;
  }
  if (!remaining) return null;
  const next = reviewAffectedResolvers(latest, reviewFiles(latest, [...files.values()], new Set(), '', { knownWorkspace: workspace }));
  if (next.validationErrors?.length) throw new Error(next.validationErrors.join('\n'));
  return next;
}

export function reviewMove(workspace: Workspace, move: Move, rename = false): Review {
  return reviewMoves(workspace, [move], rename);
}

export function reviewRenameWithEdit(workspace: Workspace, move: Move, change: TokenChange): Review {
  const edited = reviewEdit(workspace, move.file, change);
  const { files, referencesUpdated, relocations } = moveFiles(edited.next, [move]);
  return reviewStructure(workspace, files, 'Rename', [{ from: move.path, to: move.to }], referencesUpdated, relocations);
}

export function reviewMoves(workspace: Workspace, moves: readonly Move[], rename = false): Review {
  const { files, referencesUpdated, relocations } = moveFiles(workspace, moves);
  return reviewStructure(workspace, files, rename ? 'Rename' : 'Move', moves.map(({ path, to }) => ({ from: path, to })), referencesUpdated, relocations);
}

export function reviewDuplicate(workspace: Workspace, moves: readonly Move[]): Review {
  if (moves.some(({ path }) => workspace.graph.tokens.get(path)?.inheritedFrom ||
    workspace.graph.groups.get(path)?.files.size === 0)) {
    const entries = copyEntries(workspace, moves.map(move => move.path));
    const review = reviewPaste(workspace, entries, moves);
    const structure = requireValue(review.structure, 'duplicate review');
    structure.title = 'Duplicate ' + (entries.length === 1 ? entries[0]?.group ? 'group' : 'token' : 'selected tokens');
    return review;
  }
  const { files, referencesUpdated, relocations } = moveFiles(workspace, moves, true);
  return reviewStructure(workspace, files, 'Duplicate', moves.map(({ path, to }) => ({ from: path, to })), referencesUpdated, relocations);
}

export function reviewPaste(workspace: Workspace, entries: readonly ClipboardEntry[], moves: readonly Move[]): Review {
  const { files, referencesUpdated } = pasteFiles(workspace, entries, moves);
  const single = moves.length === 1 ? moves[0] : undefined;
  const review = reviewFiles(workspace, files, new Set(), single?.to ?? '', { rejectNewInvalid: true, previewValidation: true });
  const first = requireValue(moves[0], 'paste destination').to;
  const group = single && review.next.graph.groups.has(single.to) ? single.to : parentPath(first);
  return { ...review, pasteGroup: group, structure: {
    title: 'Review paste',
    paths: moves.map(({ path, to }) => ({ from: path, to })),
    tokens: review.next.graph.tokens.size - workspace.graph.tokens.size,
    files: files.filter((file, index) => file !== workspace.files[index]).length,
    referencesUpdated,
  } };
}

function reviewStructure(workspace: Workspace, files: readonly WorkspaceFile[], action: string,
  paths: readonly { from: string; to?: string }[], referencesUpdated?: number, relocations: Relocations = []): Review {
  const single = paths.length === 1 ? paths[0] : undefined;
  const review = reviewFiles(workspace, files, new Set(), single?.to ?? '', { relocations, previewValidation: true });
  const tokens = paths.reduce((total, { from }) => {
    const group = workspace.graph.groups.get(from);
    return total + (workspace.graph.tokens.has(from) ? 1 : group ? group.end - group.start : 0);
  }, 0);
  const subject = single ? (workspace.graph.tokens.has(single.from) ? 'token' : 'group') : `${paths.length} tokens`;
  return { ...review, structure: {
    title: action + ' ' + subject,
    paths, tokens, files: files.filter((file, index) => file !== workspace.files[index]).length,
    ...(referencesUpdated === undefined ? {} : { referencesUpdated }),
  } };
}

export function reviewRemoveOverride(workspace: Workspace, path: string): Review {
  const token = workspace.graph.tokens.get(path);
  if (!token?.overrides || token.inheritedFrom) throw new Error('Choose a local token override.');
  const review = reviewDelete(workspace, [path]);
  return { ...review, path, ...(review.structure ? { structure: { ...review.structure, title: 'Use inherited value' } } : {}) };
}

export function reviewDelete(workspace: Workspace, paths: readonly string[]): Review {
  const { graph } = workspace;
  const selection = new Set(paths);
  const roots = [...selection].toSorted().filter(path => {
    for (let group = parentPath(path); group; group = parentPath(group)) {
      if (selection.has(group)) return false;
    }
    return true;
  });
  const deletions = new Map<string, string[]>();
  for (const path of roots) {
    const token = graph.tokens.get(path);
    if (token?.inheritedFrom) throw new Error('Remove the source definition or override the inherited value first.');
    const files = token ? [token.file] : graph.groups.get(path)?.files.keys();
    if (!path || !files) throw new Error('Choose an existing token or group to delete.');
    for (const file of files) {
      const removed = deletions.get(file);
      if (removed) removed.push(path);
      else deletions.set(file, [path]);
    }
  }
  const files = workspace.files.map((file) => {
    const removed = deletions.get(file.path);
    if (!removed) return file;
    const formattingOptions = formatOptions(file.text);
    const text = removed.reduce((source, path) =>
      applyEdits(source, modify(source, path.split('.'), undefined, { formattingOptions })), file.text);
    return { ...file, text, tree: parseTokenFile(text, file.path) };
  });
  return reviewStructure(workspace, files, 'Delete', roots.map(from => ({ from })));
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

type Relocations = ReturnType<typeof moveFiles>['relocations'];

function settledRelocations(before: Workspace, files: readonly WorkspaceFile[], after: Workspace['graph']): Relocations {
  const targets = new Map(files.map(file => [file.path, file]));
  const original = new Map(before.files.map(file => [file.path, file]));
  const removedFiles = new Map(before.files.filter(file => !targets.has(file.path)).map(file => [file.text, file]));
  const moved: Relocations = [];
  for (const file of files) {
    if (original.has(file.path)) continue;
    const prior = removedFiles.get(file.text);
    if (prior) moved.push({ from: { file: prior.path, path: '' }, to: { file: file.path, path: '' }, node: file.tree });
  }
  const removed = new Map<string, { file: string; path: string }[]>();
  const observed = new Set<string>();
  function remember(path: string, file: string, node: JsonValue | undefined) {
    if (!isJsonObject(node) || nodeAt(targets.get(file)?.tree ?? {}, path) !== undefined) return;
    const key = valueKey(node);
    if (!key || observed.has(file + '\0' + path)) return;
    observed.add(file + '\0' + path);
    const candidates = removed.get(key) ?? [];
    candidates.push({ file, path });
    removed.set(key, candidates);
  }
  for (const path of new Set([...before.graph.issues.keys(), ...before.graph.validation.keys()])) {
    const token = before.graph.tokens.get(path);
    if (token) remember(path, token.file, token.authoredNode);
  }
  for (const issue of before.graph.documentDiagnostics) {
    if (issue.severity === 'error' && issue.path) remember(issue.path, issue.file, nodeAt(original.get(issue.file)?.tree ?? {}, issue.path));
  }
  const matched = new Set<string>();
  function match(path: string, file: string, node: JsonValue | undefined) {
    if (!isJsonObject(node)) return;
    const key = valueKey(node);
    if (!key) return;
    const candidates = removed.get(key);
    if (candidates?.length !== 1) return;
    const from = requireValue(candidates[0], 'original authoring location');
    if (matched.has(key) || nodeAt(original.get(file)?.tree ?? {}, path) !== undefined) return;
    matched.add(key);
    moved.push({ from, to: { path, file }, node });
  }
  for (const path of new Set([...after.issues.keys(), ...after.validation.keys()])) {
    const token = after.tokens.get(path);
    if (token) match(path, token.file, token.authoredNode);
  }
  for (const issue of after.documentDiagnostics) {
    if (issue.severity === 'error' && issue.path) match(issue.path, issue.file, nodeAt(targets.get(issue.file)?.tree ?? {}, issue.path));
  }
  return moved;
}

function pathUnder(root: string, path: string) {
  return !root || path === root || path.startsWith(root + '.');
}

function relocatedPath(from: string, to: string, path: string) {
  return [to, path.slice(from.length).replace(/^\./u, '')].filter(Boolean).join('.');
}

function reviewFiles(workspace: Workspace, files: readonly WorkspaceFile[], editedValues: ReadonlySet<string>, path: string,
  { rejectNewInvalid = false, relocations = [], knownWorkspace, previewValidation = false, sourceMove, settled = false }: {
    rejectNewInvalid?: boolean; relocations?: Relocations; knownWorkspace?: Workspace; previewValidation?: boolean;
    sourceMove?: { from: string; to: string }; settled?: boolean;
  } = {}): Review {
  const authoredSource = sourceMove && sourceMove.from === workspace.authoredSource ? sourceMove.to : workspace.authoredSource;
  const updated = inspectFiles(files, authoredSource);
  const moves = settled ? settledRelocations(workspace, files, updated) : relocations;
  const validationErrors: string[] = [];
  function reportValidation(message: string) {
    if (!previewValidation) throw new Error(message);
    validationErrors.push(message);
  }
  function previousPath(id: string) {
    const file = updated.tokens.get(id)?.file;
    const move = moves.find(({ to }) => file === to.file && pathUnder(to.path, id));
    return move ? relocatedPath(move.to.path, move.from.path, id) : id;
  }
  function knownAt(id: string) {
    return knownWorkspace?.graph.tokens.get(id)?.file === updated.tokens.get(id)?.file ? knownWorkspace?.graph : undefined;
  }
  for (const [id, issue] of updated.issues) {
    const previous = previousPath(id);
    const known = knownAt(id);
    const previousIssue = workspace.graph.issues.get(previous);
    const knownIssue = known?.issues.get(id);
    const existing = new Set([
      ...(previousIssue ? referenceProblems(workspace.graph, previous, previousIssue) : []),
      ...(known && knownIssue ? referenceProblems(known, id, knownIssue) : []),
    ]);
    for (const problem of referenceProblems(updated, id, issue)) {
      if (!existing.has(problem) || (editedValues.has(id) && !rejectNewInvalid)) reportValidation(id + ' · ' + problem);
    }
  }
  for (const [id, problems] of updated.validation) {
    const before = previousPath(id);
    if (editedValues.has(id) && !rejectNewInvalid) {
      if (!previewValidation) throw new Error(id + ' · ' + problems.join('\n'));
      for (const problem of problems) reportValidation(id + ' · ' + problem);
      continue;
    }
    if (rejectNewInvalid || workspace.graph.tokens.has(before)) {
      const known = workspace.graph.validation.get(before) ?? [];
      const local = knownAt(id)?.validation.get(id) ?? [];
      const introduced = problems.filter(problem => !known.includes(problem) && !local.includes(problem));
      for (const problem of introduced) reportValidation(id + ' · ' + problem);
    }
  }
  const previousDiagnostics = new Set(workspace.graph.documentDiagnostics.map(issue => {
    const moved = moves.find(({ from }) => from.file === issue.file && pathUnder(from.path, issue.path));
    return diagnosticKey(moved ? { ...issue, file: moved.to.file,
      path: relocatedPath(moved.from.path, moved.to.path, issue.path) } :
      sourceMove && issue.file === sourceMove.from ? { ...issue, file: sourceMove.to } : issue);
  }));
  for (const issue of knownWorkspace?.graph.documentDiagnostics ?? []) previousDiagnostics.add(diagnosticKey(issue));
  for (const issue of updated.documentDiagnostics) {
    if (issue.severity === 'error' && !previousDiagnostics.has(diagnosticKey(issue))) {
      reportValidation(issue.file + ' · ' + issue.path + ' · ' + issue.field + ' · ' + issue.message);
    }
  }
  const review = describeReview(workspace, { ...workspace, files, authoredSource, graph: updated }, path);
  if (validationErrors.length) review.validationErrors = validationErrors;
  return review;
}

function describeReview(before: Workspace, next: Workspace, path: string): Review {
  const changes = workspaceChanges({ baseline: before.files, files: next.files });
  if (!changes.length) throw new Error('There are no changes to review.');
  const impact = [...new Set([...before.graph.resolved.keys(), ...next.graph.resolved.keys()])].flatMap((id) => {
    const previous = before.graph.resolved.get(id);
    const after = next.graph.resolved.get(id);
    return valueKey(previous) === valueKey(after) ? [] : [{ path: id, before: previous, after }];
  });
  const typeImpact = [...before.graph.tokens].flatMap(([tokenPath, token]) => {
    const candidate = next.graph.tokens.get(tokenPath);
    return candidate && token.type !== candidate.type ? [{ path: tokenPath, before: token.type, after: candidate.type }] : [];
  });
  const inheritanceImpact: Review['inheritanceImpact'] = [];
  for (const [tokenPath, entry] of before.graph.tokens) {
    if (!entry.inheritedFrom) continue;
    const after = next.graph.tokens.get(tokenPath);
    if (!after) inheritanceImpact.push({ path: tokenPath, change: 'Removed' });
    else if (after.inheritedFrom?.file !== entry.inheritedFrom.file || after.inheritedFrom.path !== entry.inheritedFrom.path) {
      inheritanceImpact.push({ path: tokenPath, change: 'Source changed' });
    }
  }
  for (const [tokenPath, entry] of next.graph.tokens) {
    if (entry.inheritedFrom && !before.graph.tokens.get(tokenPath)?.inheritedFrom) {
      inheritanceImpact.push({ path: tokenPath, change: before.graph.tokens.has(tokenPath) ? 'Source changed' : 'Added' });
    }
  }
  const uninspectedSources = next.files.filter(file => file.parseIssue).map(file => file.path);
  let diff: string | undefined;
  return { file: changes.map((change) => change.path).join(', '), path,
    get diff() { return diff ??= changes.map(diffFile).join(''); },
    impact, next, uninspectedSources, typeImpact, inheritanceImpact };
}

export function workspaceChanges({ baseline, files }: Pick<Workspace, 'baseline' | 'files'>): FileChange[] {
  const before = new Map(baseline.map(({ path, text }) => [path, text]));
  const changes: FileChange[] = [];
  for (const { path, text } of files) {
    const original = before.get(path) ?? null;
    if (original !== text) changes.push({ path, before: original, after: text });
    before.delete(path);
  }
  for (const [path, text] of before) changes.push({ path, before: text, after: null });
  return changes;
}

export function diffFile({ path, before, after }: FileChange): string {
  const oldPath = before === null ? '/dev/null' : 'a/' + path;
  const newPath = after === null ? '/dev/null' : 'b/' + path;
  return createTwoFilesPatch(oldPath, newPath, before ?? '', after ?? '');
}
