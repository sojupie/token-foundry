import { errorMessage, isJsonObject, requireValue } from './json.ts';
import type { JsonObject, JsonValue } from './json.ts';
import type { TokenFile } from './token-types.ts';
import type { DocumentDiagnostic } from './document-diagnostics.ts';
import { tokenPointer } from './token-path.ts';

export interface AuthoredLocation { file: string; path: string }

export interface EffectiveEntry {
  value: JsonValue;
  source: AuthoredLocation;
  token: boolean;
  children?: ReadonlyMap<string, EffectiveEntry>;
  extends?: AuthoredLocation;
  overrides?: AuthoredLocation;
  invalidExtension?: boolean;
}

function isChild(key: string): boolean {
  return !key.startsWith('$') || key === '$root';
}

function overlay(inherited: EffectiveEntry, local: EffectiveEntry): EffectiveEntry {
  return !inherited.token && !local.token && inherited.children && local.children
    ? mergeGroup(inherited, local) : { ...local, overrides: inherited.source };
}

function mergeGroup(base: EffectiveEntry, local: EffectiveEntry): EffectiveEntry {
  const children = new Map(base.children);
  for (const [key, child] of local.children ?? []) {
    const inherited = children.get(key);
    children.set(key, inherited ? overlay(inherited, child) : child);
  }
  const inheritedMetadata = groupMetadata(base.value);
  const localMetadata = groupMetadata(local.value);
  const value = { ...inheritedMetadata, ...localMetadata };
  const inheritedExtensions = inheritedMetadata['$extensions'];
  const localExtensions = localMetadata['$extensions'];
  if (isJsonObject(inheritedExtensions) && isJsonObject(localExtensions)) {
    value['$extensions'] = { ...inheritedExtensions, ...localExtensions };
  }
  return { ...local, value, children };
}

function groupMetadata(value: JsonValue): JsonObject {
  return isJsonObject(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !isChild(key) &&
    key !== '$extends' && key !== '$ref' && key !== '$schema')) : {};
}

function entryKey({ file, path }: AuthoredLocation): string {
  return JSON.stringify([file, path]);
}

export function resolveGroupInheritance(files: readonly TokenFile[]) {
  const entries = new Map<string, { source: AuthoredLocation; value: JsonValue }>();
  const groupDiagnostics: DocumentDiagnostic[] = [];
  const active = new Set<string>();
  const pendingBases = new Map<string, EffectiveEntry>();
  const classifying = new Set<string>();
  const completed = new Map<string, EffectiveEntry>();
  const tokenKinds = new Map<string, boolean>();

  function indexEntries(value: JsonValue, source: AuthoredLocation) {
    const key = entryKey(source);
    entries.set(key, { source, value });
    if (!isJsonObject(value) || Object.hasOwn(value, '$value')) return;
    for (const [name, child] of Object.entries(value)) {
      if (isChild(name) && name && !/[.{}]/u.test(name) && child !== undefined) {
        indexEntries(child, { file: source.file, path: source.path ? source.path + '.' + name : name });
      }
    }
  }

  for (const { path, tree } of files) indexEntries(tree, { file: path, path: '' });

  function pointedLocation(ref: string, source: AuthoredLocation): AuthoredLocation | undefined {
    const { file, parts } = tokenPointer(ref, source.file);
    if (parts.some(part => !part || /[.{}]/u.test(part) || part.startsWith('$') && part !== '$root')) return undefined;
    return { file, path: parts.join('.') };
  }

  function effectiveAt(source: AuthoredLocation): EffectiveEntry | undefined {
    const parts = source.path ? source.path.split('.') : [];
    for (let index = 0; index <= parts.length; index++) {
      const location = { file: source.file, path: parts.slice(0, index).join('.') };
      const key = entryKey(location);
      const raw = entries.get(key)?.value;
      if (!isJsonObject(raw)) return undefined;
      const extendsGroup = Object.hasOwn(raw, '$extends') || typeof raw['$ref'] === 'string';
      if (index === parts.length || extendsGroup && !active.has(key)) {
        return parts.slice(index).reduce<EffectiveEntry | undefined>((entry, child) => entry?.children?.get(child), expand(location));
      }
      const name = requireValue(parts[index], 'group child');
      const inherited = pendingBases.get(key)?.children?.get(name);
      if (inherited) {
        const child = { file: source.file, path: parts.slice(0, index + 1).join('.') };
        const entry = entries.has(entryKey(child)) ? overlay(inherited, expand(child)) : inherited;
        return parts.slice(index + 1).reduce<EffectiveEntry | undefined>((node, childName) => node?.children?.get(childName), entry);
      }
    }
    return undefined;
  }

  function isToken(source: AuthoredLocation): boolean {
    const key = entryKey(source);
    const remembered = tokenKinds.get(key);
    if (remembered !== undefined) return remembered;
    const value = entries.get(key)?.value;
    if (!isJsonObject(value)) return false;
    if (Object.hasOwn(value, '$value')) return true;
    const ref = value['$ref'];
    if (typeof ref !== 'string') return false;
    if (source.path === '$root' || source.path.endsWith('.$root')) return true;
    if (Object.hasOwn(value, '$extends') || Object.keys(value).some(isChild)) return false;
    if (classifying.has(key)) return false;
    let token = true;
    classifying.add(key);
    try {
      const target = pointedLocation(ref, source);
      if (target) token = entries.has(entryKey(target)) ? isToken(target) : effectiveAt(target)?.token ?? true;
    } catch {
      // The reference resolver reports malformed or missing leaf pointers.
    } finally {
      classifying.delete(key);
    }
    tokenKinds.set(key, token);
    return token;
  }

  function extensionTarget(ref: JsonValue | undefined, source: AuthoredLocation): { target: AuthoredLocation; base: EffectiveEntry } | undefined {
    const text = typeof ref === 'string' ? ref : isJsonObject(ref) ? ref['$ref'] : undefined;
    if (typeof text !== 'string') throw new Error('Expected a group reference.');
    const alias = /^\{([^{}]+)\}$/u.exec(text)?.[1];
    if (!alias) {
      const target = pointedLocation(text, source);
      const base = target && effectiveAt(target);
      return target && base ? { target, base } : undefined;
    }
    const local = { file: source.file, path: alias };
    const localBase = effectiveAt(local);
    if (localBase) return { target: local, base: localBase };
    const candidates = files.filter(file => file.path !== source.file).flatMap(({ path: file }) => {
      const target = { file, path: alias };
      const base = effectiveAt(target);
      return base ? [{ target, base }] : [];
    });
    if (candidates.length > 1) throw new Error('Group reference has more than one source: ' + text + '. Use a file-relative pointer.');
    return candidates[0];
  }

  function expand(source: AuthoredLocation): EffectiveEntry {
    const key = entryKey(source);
    const cached = completed.get(key);
    if (cached) return cached;
    if (active.has(key)) throw new Error('Circular group extension at ' + (source.path || source.file) + '.');
    const { value } = requireValue(entries.get(key), 'source entry');
    const token = isToken(source);
    if (token || !isJsonObject(value)) return { value, source, token };

    active.add(key);
    try {
      const field = Object.hasOwn(value, '$extends') ? '$extends' : typeof value['$ref'] === 'string' ? '$ref' : undefined;
      const children = new Map<string, EffectiveEntry>();
      let result: EffectiveEntry = { value, source, token, children };
      let base: EffectiveEntry | undefined;
      if (field) {
        try {
          const extension = extensionTarget(value[field], source);
          if (!extension) throw new Error('The extension target could not be found.');
          if (extension.base.token || !extension.base.children) throw new Error('The extension target must be a group.');
          if (extension.base.invalidExtension) throw new Error('The extension target has an invalid or circular extension.');
          if (extension.target.file === source.file && extension.target.path.startsWith(source.path ? source.path + '.' : '')) {
            throw new Error('Circular group extension at ' + (source.path || source.file) + '.');
          }
          base = extension.base;
          pendingBases.set(key, base);
          result.extends = extension.target;
        } catch (failure) {
          base = undefined;
          result.invalidExtension = true;
          groupDiagnostics.push({ ...source, field, message: errorMessage(failure), severity: 'error',
            target: { kind: 'group', path: source.path } });
        }
      }
      for (const [name, item] of Object.entries(value)) {
        if (!isChild(name) || !name || /[.{}]/u.test(name) || item === undefined) continue;
        children.set(name, expand({ file: source.file, path: source.path ? source.path + '.' + name : name }));
      }
      if (base) result = mergeGroup(base, result);
      completed.set(key, result);
      return result;
    } finally {
      pendingBases.delete(key);
      active.delete(key);
    }
  }

  return { roots: files.map(file => expand({ file: file.path, path: '' })), groupDiagnostics };
}
