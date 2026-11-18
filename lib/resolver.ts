import { inspectDocuments } from './document.ts';
import { errorMessage, isJsonObject } from './json.ts';
import type { JsonObject, JsonValue } from './json.ts';
import { resolverPointer, serializeTokenPointer, tokenPointer } from './token-path.ts';
import type { TokenFile } from './token-types.ts';

export const resolverVersion = '2025.10';
export const resolverSchema = 'https://www.designtokens.org/schemas/2025.10/resolver.json';

interface Site { file: string; parts: string[] }
interface Located { site: Site; value: JsonValue | undefined }
interface ObjectSite { value: JsonObject; site: Site; fields: Map<string, Site> }

export interface ResolverIssue extends Site { message: string; severity: 'error' | 'warning' }
export interface ResolverOrigin extends Site { set?: string; modifier?: string; context?: string }
interface Contribution { tree: JsonObject; origin: ResolverOrigin; fields: ReadonlyMap<string, Site> }
interface ResolverSet { kind: 'set'; name: string; sources: Contribution[]; sourceSite?: Site }
interface ResolverModifier { kind: 'modifier'; name: string; contexts: Map<string, Contribution[]>; contextSites: Map<string, Site>; defaultContext?: string }
type ResolverEntry = ResolverSet | ResolverModifier;

export interface ResolverModel {
  file: string;
  issues: ResolverIssue[];
  order: ResolverEntry[];
  sets: Map<string, ResolverSet>;
  modifiers: Map<string, ResolverModifier>;
  sourceFiles: ReadonlySet<string>;
}

export interface ResolverLayer {
  set?: string;
  option?: { modifier: string; context: string };
}

export function resolverLayer(model: ResolverModel, layer: ResolverLayer): ResolverModel | undefined {
  const set = layer.set === undefined ? undefined : model.sets.get(layer.set);
  if (set) return { ...model, order: [set], modifiers: new Map() };
  const option = layer.option;
  const modifier = option && model.modifiers.get(option.modifier);
  if (!option || !modifier?.contexts.has(option.context)) return undefined;
  return { ...model, order: [modifier], modifiers: new Map([[modifier.name, { ...modifier, defaultContext: option.context }]]) };
}

export function emptyLayerSite(model: ResolverModel, layer: ResolverLayer, files: readonly TokenFile[]) {
  const option = layer.option;
  const site = layer.set !== undefined ? model.sets.get(layer.set)?.sourceSite :
    option ? model.modifiers.get(option.modifier)?.contextSites.get(option.context) : undefined;
  if (!site) return undefined;
  const value = resolverValueAt(files.find(file => file.path === site.file)?.tree, site.parts);
  return Array.isArray(value) && !value.length ? { ...site, parts: [...site.parts, '0'] } : undefined;
}

export function isResolverFile(file: TokenFile): boolean {
  return /\.resolver\.json$/iu.test(file.path) ||
    (typeof file.tree['$schema'] === 'string' && /\/resolver\.json(?:[#?].*)?$/u.test(file.tree['$schema'])) ||
    Array.isArray(file.tree['resolutionOrder']) && typeof file.tree['version'] === 'string';
}

export function newResolverDocument(name: string): JsonObject {
  return { $schema: resolverSchema, name, version: resolverVersion, sets: {}, modifiers: {}, resolutionOrder: [] };
}

const child = (site: Site, ...parts: string[]): Site => ({ file: site.file, parts: [...site.parts, ...parts] });

export function resolverValueAt(value: JsonValue | undefined, parts: readonly string[]): JsonValue | undefined {
  return parts.reduce<JsonValue | undefined>((node, key) => {
    if (Array.isArray(node)) return /^(0|[1-9][0-9]*)$/u.test(key) ? node[Number(key)] : undefined;
    return isJsonObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;
  }, value);
}

function siteKey(site: Site): string {
  return JSON.stringify([site.file, ...site.parts]);
}

function isWithin(left: Site, right: Site) {
  return left.file === right.file && left.parts.length <= right.parts.length &&
    left.parts.every((part, index) => part === right.parts[index]);
}

export function compileResolver(file: TokenFile, files: readonly TokenFile[]): ResolverModel {
  const root: Site = { file: file.path, parts: [] };
  const trees = new Map(files.map(source => [source.path, source.tree]));
  const manifests = new Set(files.filter(isResolverFile).map(source => source.path)).add(file.path);
  const issues = new Map<string, ResolverIssue>();
  const sourceFiles = new Set([file.path]);
  const order: ResolverEntry[] = [];
  const sets = new Map<string, ResolverSet>();
  const modifiers = new Map<string, ResolverModifier>();

  function report(site: Site, message: string, severity: ResolverIssue['severity'] = 'error') {
    issues.set(JSON.stringify([siteKey(site), message]), { ...site, message, severity });
  }

  function resolveObject({ site, value }: Located, inOrder: boolean, active = new Set<string>()): ObjectSite | undefined {
    if (!isJsonObject(value)) {
      report(site, 'Expected an object.');
      return undefined;
    }
    const fieldSites = new Map(Object.keys(value).filter(field => field !== '$ref').map(field => [field, child(site, field)]));
    if (!Object.hasOwn(value, '$ref')) return { value, site, fields: fieldSites };
    const ref = value['$ref'];
    try {
      if (typeof ref !== 'string' || !ref) throw new Error('Expected a nonempty reference.');
      const target = resolverPointer(ref, site.file);
      if (manifests.has(target.file) && (target.parts[0] === 'resolutionOrder' || !inOrder && target.parts[0] === 'modifiers')) {
        throw new Error('Cannot reference ' + target.parts[0] + ' from this location.');
      }
      if (active.has(siteKey(target)) || isWithin(target, site)) throw new Error('Circular Resolver reference: ' + ref);
      sourceFiles.add(target.file);
      const tree = trees.get(target.file);
      const selected = resolverValueAt(tree, target.parts);
      if (selected === undefined) throw new Error('Resolver reference target is missing: ' + ref);
      const ancestors = new Set(active).add(siteKey(site));
      const inherited = resolveObject({ site: target, value: selected }, inOrder, ancestors);
      if (!inherited) return undefined;
      const { $ref: _, ...local } = value;
      return { site: inherited.site, value: { ...inherited.value, ...local }, fields: new Map([...inherited.fields, ...fieldSites]) };
    } catch (failure) {
      report(child(site, '$ref'), errorMessage(failure));
      return undefined;
    }
  }

  function locatedField(node: ObjectSite, name: string): Located {
    return { site: node.fields.get(name) ?? child(node.site, name), value: node.value[name] };
  }

  function expand({ site, value }: Located, scope: Omit<ResolverOrigin, keyof Site>, ancestors: ReadonlySet<string>): Contribution[] {
    if (!Array.isArray(value)) {
      report(site, 'Expected an ordered array of token sources.');
      return [];
    }
    return value.flatMap((item, index) => {
      const origin = child(site, String(index));
      const resolved = resolveObject({ value: item, site: origin }, false);
      if (!resolved) return [];
      if (manifests.has(resolved.site.file) && resolved.site.parts[0] === 'modifiers' && resolved.site.parts.length === 2) {
        report(origin, 'A source cannot reference a modifier.');
        return [];
      }
      if (manifests.has(resolved.site.file) && resolved.site.parts[0] === 'sets' && resolved.site.parts.length === 2 || Array.isArray(resolved.value['sources'])) {
        const located = locatedField(resolved, 'sources');
        const identity = siteKey(located.site);
        if (ancestors.has(identity)) {
          report(origin, 'Circular set reference.');
          return [];
        }
        const name = resolved.site.parts[0] === 'sets' ? resolved.site.parts[1] : undefined;
        return expand(located, name === undefined ? scope : { ...scope, set: name }, new Set(ancestors).add(identity));
      }
      return [{ tree: resolved.value, origin: { ...resolved.site, ...scope }, fields: resolved.fields }];
    });
  }

  function entry(name: string, kind: ResolverEntry['kind'], node: ObjectSite): ResolverEntry {
    if (Object.hasOwn(node.value, 'description') && typeof node.value['description'] !== 'string') {
      report(locatedField(node, 'description').site, 'Expected a description string.');
    }
    if (Object.hasOwn(node.value, '$extensions') && !isJsonObject(node.value['$extensions'])) {
      report(locatedField(node, '$extensions').site, 'Expected a vendor extensions object.');
    }
    if (kind === 'set') {
      const located = locatedField(node, 'sources');
      return { kind, name, sources: expand(located, { set: name }, new Set([siteKey(located.site)])), sourceSite: located.site };
    }
    const located = locatedField(node, 'contexts');
    const contexts = new Map<string, Contribution[]>();
    const contextSites = new Map<string, Site>();
    if (!isJsonObject(located.value) || !Object.keys(located.value).length) {
      report(located.site, 'A modifier must have at least one context.');
    } else {
      if (Object.keys(located.value).length === 1) report(located.site, 'A modifier should have at least two contexts.', 'warning');
      for (const [context, value] of Object.entries(located.value)) {
        const site = child(located.site, context);
        contextSites.set(context, site);
        contexts.set(context, expand({ site, value }, { modifier: name, context }, new Set()));
      }
    }
    const defaultContext = node.value['default'];
    if (defaultContext !== undefined && (typeof defaultContext !== 'string' || !contexts.has(defaultContext))) {
      report(locatedField(node, 'default').site, 'Choose a default from the modifier’s contexts.');
    }
    return { kind, name, contexts, contextSites,
      ...(typeof defaultContext === 'string' && contexts.has(defaultContext) ? { defaultContext } : {}) };
  }

  const tree = file.tree;
  if (tree['version'] !== resolverVersion) report(child(root, 'version'), 'Resolver version must be "' + resolverVersion + '".');
  for (const fieldName of ['name', 'description', '$schema']) {
    if (Object.hasOwn(tree, fieldName) && typeof tree[fieldName] !== 'string') report(child(root, fieldName), 'Expected a string.');
  }
  for (const [keyName, kind] of [['sets', 'set'], ['modifiers', 'modifier']] as const) {
    const collection = tree[keyName];
    if (collection === undefined) continue;
    if (!isJsonObject(collection)) { report(child(root, keyName), 'Expected a named object.'); continue; }
    for (const [name, value] of Object.entries(collection)) {
      const node = resolveObject({ value, site: child(root, keyName, name) }, false);
      if (!node) continue;
      const parsed = entry(name, kind, node);
      if (parsed.kind === 'modifier') modifiers.set(name, parsed);
      else sets.set(name, parsed);
    }
  }
  if (!Array.isArray(tree['resolutionOrder'])) {
    report(child(root, 'resolutionOrder'), 'Expected a resolution order array.');
  } else {
    const names = new Set<string>();
    for (const [index, item] of tree['resolutionOrder'].entries()) {
      const site = child(root, 'resolutionOrder', String(index));
      const node = resolveObject({ value: item, site }, true);
      if (!node) continue;
      const referenced = node.site.file !== site.file || siteKey(node.site) !== siteKey(site);
      const kind = referenced && node.site.parts[0] === 'sets' ? 'set' : referenced && node.site.parts[0] === 'modifiers' ?
        'modifier' : node.value['type'];
      const name = referenced && (node.site.parts[0] === 'sets' || node.site.parts[0] === 'modifiers') ? node.site.parts[1] : node.value['name'];
      if ((kind !== 'set' && kind !== 'modifier') || typeof name !== 'string' || !name) {
        report(site, 'Expected a named set or modifier, or a reference to one.');
        continue;
      }
      if (names.has(name)) {
        report(site, 'Duplicate name in resolution order: ' + name + '.');
        continue;
      }
      names.add(name);
      const parsed = entry(name, kind, node);
      order.push(parsed);
      if (parsed.kind === 'modifier') modifiers.set(name, parsed);
      else sets.set(name, parsed);
    }
  }
  return { file: file.path, issues: [...issues.values()], order, sets, modifiers, sourceFiles };
}

export function resolverInputs(model: ResolverModel, provided: Readonly<Record<string, JsonValue | undefined>>) {
  const contexts = new Map<string, string>();
  const errors: string[] = [];
  const modifiers = new Map([...model.modifiers].map(([name, modifier]) => [name.toLowerCase(), modifier]));
  for (const [name, value] of Object.entries(provided)) {
    const modifier = modifiers.get(name.toLowerCase());
    if (!modifier) { errors.push('Unknown modifier ' + name + '.'); continue; }
    if (contexts.has(modifier.name)) { errors.push('Duplicate input for ' + modifier.name + '.'); continue; }
    const match = typeof value === 'string' ? [...modifier.contexts.keys()].find(context => context.toLowerCase() === value.toLowerCase()) : undefined;
    if (match === undefined) errors.push('Choose a valid context for ' + name + '.');
    else contexts.set(modifier.name, match);
  }
  for (const [name, modifier] of model.modifiers) {
    if (contexts.has(name)) continue;
    if (modifier.defaultContext !== undefined) contexts.set(name, modifier.defaultContext);
    else if (!Object.keys(provided).some(input => input.toLowerCase() === name.toLowerCase())) errors.push('Select a context for ' + name + '.');
  }
  return { contexts, errors };
}

function contributionSignature(contributions: Contribution[] | undefined) {
  return contributions?.map(({ tree, origin, fields }) => [tree, siteKey(origin), [...fields].map(([key, site]) => [key, siteKey(site)])]);
}

// Review can collapse context choices whose inputs compose the same authored
// sources. Include physical locations because they control pointer rebasing.
export function equivalentResolverChoices(previous: ResolverModel, next: ResolverModel, name: string, preferred: string | undefined): string[] {
  const modifier = next.modifiers.get(name);
  if (!modifier) return [];
  const before = [...previous.modifiers.values()].find(entry => entry.name.toLowerCase() === name.toLowerCase());
  const representatives = new Map<string, string>();
  for (const [choice, contributions] of modifier.contexts) {
    const previousChoice = before && ([...before.contexts.keys()].find(value => value.toLowerCase() === choice.toLowerCase()) ??
      before.defaultContext ?? before.contexts.keys().next().value);
    const key = JSON.stringify([
      contributionSignature(previousChoice === undefined ? undefined : before?.contexts.get(previousChoice)),
      contributionSignature(contributions),
    ]);
    if (choice === preferred || !representatives.has(key)) representatives.set(key, choice);
  }
  return [...representatives.values()];
}

function canonicalValue(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return '[' + value.map(canonicalValue).join(',') + ']';
  if (isJsonObject(value)) return '{' + Object.keys(value).toSorted()
    .map(item => JSON.stringify(item) + ':' + canonicalValue(value[item])).join(',') + '}';
  return JSON.stringify(value);
}

export function planResolver(model: ResolverModel, provided: Readonly<Record<string, JsonValue | undefined>>) {
  const { contexts, errors } = resolverInputs(model, provided);
  const contributions = errors.length ? [] : model.order.flatMap(entry => entry.kind === 'set' ? entry.sources :
    entry.contexts.get(contexts.get(entry.name) ?? '') ?? []);
  return { file: model.file, contexts, errors, contributions };
}

export function resolveResolver(model: ResolverModel, provided: Readonly<Record<string, JsonValue | undefined>>,
  inspect = inspectDocuments) {
  return resolveResolverPlan(planResolver(model, provided), inspect);
}

export function resolveResolverPlan({ file, contexts, errors, contributions }: ReturnType<typeof planResolver>,
  inspect = inspectDocuments) {
  const origins = new Map<string, ResolverOrigin[]>();
  const roots = new Map<string, Site[]>();
  for (const { origin } of contributions) {
    const candidates = roots.get(origin.file) ?? [];
    candidates.push(origin);
    roots.set(origin.file, candidates);
  }

  function link(value: JsonValue | undefined, site: Site, root: Site): JsonValue | undefined {
    if (Array.isArray(value)) {
      let next: JsonValue[] | undefined;
      for (const [index, item] of value.entries()) {
        if (typeof item !== 'object' || item === null) continue;
        const substituted = link(item, child(site, String(index)), root) ?? null;
        if (substituted !== item) {
          next ??= value.slice();
          next[index] = substituted;
        }
      }
      return next ?? value;
    }
    if (!isJsonObject(value)) return value;
    let next: JsonObject | undefined;
    for (const field of Object.keys(value)) {
      const item = value[field];
      let substituted = item;
      if ((field === '$ref' || field === '$extends') && typeof item === 'string' && item.includes('#')) {
        try {
          const target = tokenPointer(item, site.file);
          if (item.startsWith('#') && !isWithin(root, target)) continue;
          const mounted = roots.get(target.file)?.filter(candidate => isWithin(candidate, target))
            .toSorted((left, right) => right.parts.length - left.parts.length)[0];
          if (mounted) substituted = serializeTokenPointer(file, file, target.parts.slice(mounted.parts.length));
        } catch {
          // Keep malformed pointers intact for token diagnostics.
        }
      } else if (field !== '$extensions' && typeof item === 'object' && item !== null) {
        substituted = link(item, child(site, field), root);
      }
      if (substituted !== item) {
        next ??= { ...value };
        Object.defineProperty(next, field, { value: substituted, enumerable: true, configurable: true, writable: true });
      }
    }
    return next ?? value;
  }

  function tokenShape(value: JsonObject, site: Site, seen = new Set<string>()): boolean {
    if (Object.hasOwn(value, '$value')) return true;
    const ref = value['$ref'];
    if (typeof ref !== 'string' || Object.keys(value).some(key => !key.startsWith('$') || key === '$root')) return false;
    try {
      const target = tokenPointer(ref, site.file);
      const key = siteKey(target);
      if (seen.has(key)) return true;
      seen.add(key);
      for (const contribution of contributions.toReversed()) {
        if (!isWithin(contribution.origin, target)) continue;
        const node = resolverValueAt(contribution.tree, target.parts.slice(contribution.origin.parts.length));
        if (isJsonObject(node)) return tokenShape(node, target, seen);
        if (node !== undefined) return true;
      }
    } catch {
      // The Format graph reports invalid references.
    }
    return true;
  }

  const mergedGroups = new WeakSet<JsonObject>();
  function merge(before: JsonValue | undefined, after: JsonValue, path: string, origin: ResolverOrigin, root: Site, fields?: ReadonlyMap<string, Site>): JsonValue {
    const history = origins.get(path) ?? [];
    history.push(origin);
    origins.set(path, history);
    if (!isJsonObject(after) || tokenShape(after, origin)) return link(after, origin, root) ?? null;
    const next: JsonObject = isJsonObject(before) && mergedGroups.has(before) ? before : {};
    for (const [name, value] of Object.entries(after)) {
      if (value === undefined || !path && name === '$schema') continue;
      const tokenPath = path ? path + '.' + name : name;
      const site = fields?.get(name) ?? child(origin, name);
      const location = { ...origin, ...site };
      const merged = !name.startsWith('$') || name === '$root' ? merge(Object.hasOwn(next, name) ? next[name] : undefined, value, tokenPath, location, root) :
        name === '$ref' || name === '$extends' ? resolverValueAt(link({ [name]: value }, origin, root), [name]) : value;
      Object.defineProperty(next, name, { value: merged, enumerable: true, configurable: true, writable: true });
    }
    mergedGroups.add(next);
    return next;
  }

  let result: JsonValue = {};
  if (!errors.length) for (const { tree, origin, fields } of contributions) result = merge(result, tree, '', origin, origin, fields);
  const tree = isJsonObject(result) ? result : {};
  const graph = inspect([{ path: file, tree }]);
  return { contexts, errors, graph, tree, origins };
}

export type ResolverResolution = ReturnType<typeof resolveResolver>;

export function winningOrigins(resolution: ResolverResolution, path: string): readonly ResolverOrigin[] {
  const inherited = resolution.graph.tokens.get(path)?.inheritedFrom;
  return resolution.origins.get(inherited?.path ?? path) ?? [];
}

// The composed graph rewrites pointers to the Resolver document. Persist new
// pointers relative to the actual definition and retain untouched authored fields.
export function authoredResolverValue(resolution: ResolverResolution, resolverFile: string, file: string,
  value: JsonValue, previous?: JsonValue, authored?: JsonValue): JsonValue {
  if (authored !== undefined && canonicalValue(value) === canonicalValue(previous)) return authored;
  if (Array.isArray(value)) return value.map((part, index) => authoredResolverValue(
    resolution, resolverFile, file, part, Array.isArray(previous) ? previous[index] : undefined,
    Array.isArray(authored) ? authored[index] : undefined));
  if (!isJsonObject(value)) return value;
  if (typeof value['$ref'] === 'string' && value['$ref'].startsWith('#')) {
    const { parts } = tokenPointer(value['$ref'], resolverFile);
    const boundary = parts.indexOf('$value');
    const tokenParts = parts.slice(0, boundary < 0 ? parts.length : boundary);
    const target = winningOrigins(resolution, tokenParts.join('.')).at(-1);
    if (!target) throw new Error('Choose an available token field.');
    const pointer = serializeTokenPointer(file, target.file, [...target.parts, ...parts.slice(tokenParts.length)]);
    return { ...value, $ref: file === target.file ? encodeURIComponent(target.file.split('/').at(-1) ?? '') + pointer : pointer };
  }
  return Object.fromEntries(Object.entries(value).map(([key, part]) => [key,
    part === undefined ? undefined : authoredResolverValue(resolution, resolverFile, file, part,
      isJsonObject(previous) ? previous[key] : undefined, isJsonObject(authored) ? authored[key] : undefined)]));
}

type ComparisonGraph = Pick<ResolverResolution['graph'], 'resolved' | 'issues' | 'validation'> & {
  tokens: ReadonlyMap<string, { type: string | undefined }>;
};
export interface ComparableContext { graph: ComparisonGraph }

export function compareContexts(before: ComparableContext, after: ComparableContext) {
  const paths = new Set([...before.graph.tokens.keys(), ...after.graph.tokens.keys()]);
  return [...paths].toSorted().flatMap(path => {
    const previous = before.graph.tokens.get(path);
    const next = after.graph.tokens.get(path);
    const beforeValue = before.graph.resolved.get(path);
    const afterValue = after.graph.resolved.get(path);
    const beforeProblem = before.graph.issues.get(path) ?? before.graph.validation.get(path)?.join('\n');
    const afterProblem = after.graph.issues.get(path) ?? after.graph.validation.get(path)?.join('\n');
    const kind = beforeProblem || afterProblem ? 'Invalid' : !previous ? 'Added' : !next ? 'Removed' : 'Changed';
    if (kind === 'Changed' && previous?.type === next?.type &&
      (beforeValue === afterValue || canonicalValue(beforeValue) === canonicalValue(afterValue))) return [];
    return [{ path, kind, before: beforeValue, after: afterValue, beforeProblem, afterProblem }];
  });
}

export function resolvedSnapshot(resolution: ResolverResolution): JsonObject {
  if (resolution.errors.length || resolution.graph.issues.size || resolution.graph.validation.size ||
    resolution.graph.documentDiagnostics.some(issue => issue.severity === 'error')) {
    throw new Error('Resolve the context’s errors before exporting.');
  }
  const root: JsonObject = {};
  function groupAt(parts: readonly string[]) {
    let parent = root;
    for (const part of parts) {
      const previous = Object.hasOwn(parent, part) ? parent[part] : undefined;
      const group = isJsonObject(previous) ? previous : {};
      Object.defineProperty(parent, part, { value: group, enumerable: true, configurable: true, writable: true });
      parent = group;
    }
    return parent;
  }
  for (const [path, group] of resolution.graph.groups) {
    const target = groupAt(path ? path.split('.') : []);
    const definition = group.definitions.values().next().value;
    if (!definition) continue;
    for (const [field, value] of Object.entries(definition.node)) {
      if (field.startsWith('$') && !['$root', '$extends', '$ref', '$value'].includes(field)) target[field] = value;
    }
  }
  for (const [path, token] of resolution.graph.tokens) {
    const parts = path.split('.');
    const name = parts.pop();
    if (name === undefined) continue;
    const parent = groupAt(parts);
    const node: JsonObject = { ...token.authoredNode, $type: token.type, $value: resolution.graph.resolved.get(path),
      ...(token.deprecated === undefined ? {} : { $deprecated: token.deprecated }) };
    delete node['$ref'];
    Object.defineProperty(parent, name, { value: node, enumerable: true, writable: true, configurable: true });
  }
  return root;
}
