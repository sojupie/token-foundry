import { isVariableRow, sameSourceValue } from '../integrations/figma/contract.ts';
import type { VariableRow } from '../integrations/figma/contract.ts';
import { isLocalValue } from '../integrations/figma/merge.ts';
import type { LocalValue } from '../integrations/figma/merge.ts';
import { isRecord, isUnknownArray } from '../lib/json.ts';
import { deviceFileScope, isolateDeviceFile, matchesDeviceFile } from './connection.ts';
import type { ConnectionStorage } from './connection.ts';

export interface TokenForm {
  row: VariableRow; before: LocalValue; revision: string; kind: 'value' | 'alias'; text: string;
}
export const isTokenForm = (value: unknown): value is TokenForm => isRecord(value) && isVariableRow(value['row']) && isLocalValue(value['before']) &&
  typeof value['revision'] === 'string' && /^[a-f0-9]{64}$/u.test(value['revision']) &&
  (value['kind'] === 'value' || value['kind'] === 'alias') && typeof value['text'] === 'string';
export const isTokenFormEntries = (value: unknown): value is TokenForm[] => isUnknownArray(value) && value.every(isTokenForm);
export const isTokenForms = (value: unknown): value is TokenForm[] => isTokenFormEntries(value) && new Set(value.map(form => form.row.path)).size === value.length;
export function splitTokenForms(entries: readonly TokenForm[]) {
  const groups = new Map<string, TokenForm[]>();
  for (const form of entries) {
    const group = groups.get(form.row.path) ?? [];
    if (!group.some(previous => sameSourceValue(previous, form))) group.push(form);
    groups.set(form.row.path, group);
  }
  return { forms: [...groups.values()].filter(group => group.length === 1).flat(), conflicts: [...groups.values()].filter(group => group.length > 1).flat() };
}
export const tokenFormsCopy = (forms: TokenForm[]) => JSON.stringify({ format: 'token-foundry/token-forms', version: 1, forms }, null, 2);
export function readTokenFormsCopy(text: string): TokenForm[] {
  const copy: unknown = JSON.parse(text);
  if (!isRecord(copy) || copy['format'] !== 'token-foundry/token-forms' || copy['version'] !== 1 || !isTokenFormEntries(copy['forms'])) throw new Error('Choose a Foundry token edit copy.');
  return copy['forms'];
}
interface Generation { version: 2; id: string; parents: string[]; updated: number; forms: TokenForm[]; fileKey?: string; collection?: string }
const isGeneration = (value: unknown): value is Generation => isRecord(value) && value['version'] === 2 && typeof value['id'] === 'string' && /^[a-z0-9-]+$/u.test(value['id']) &&
  isUnknownArray(value['parents']) && value['parents'].every(parent => typeof parent === 'string' && parent !== value['id'] && /^[a-z0-9-]+$/u.test(parent)) &&
  typeof value['updated'] === 'number' && Number.isFinite(value['updated']) && isTokenFormEntries(value['forms']) &&
  (value['fileKey'] === undefined || typeof value['fileKey'] === 'string') && (value['collection'] === undefined || typeof value['collection'] === 'string');

class FormStore {
  #lookup = '';
  #heads: string[] = [];
  #obsolete: string[] = [];
  #ready = false;
  async restore(figma: ConnectionStorage, attempt = 0): Promise<TokenForm[]> {
    const scope = await deviceFileScope(figma); if (!scope) { this.#ready = false; return []; }
    if (!figma.clientStorage.keysAsync) throw new Error('Saved token edits could not be listed on this device.');
    const base = scope.lookup + ':token-forms'; const prefix = base + ':';
    const keys = (await figma.clientStorage.keysAsync()).filter(key => key.startsWith(prefix));
    const values = await Promise.all(keys.map(async key => ({ key, value: await figma.clientStorage.getAsync(key) })));
    // A concurrent writer may collect a parent after listing and before reading.
    if (values.some(entry => entry.value === undefined)) {
      if (attempt >= 3) throw new Error('Another plugin window is saving edits. Retry reopening saved edits.');
      return this.restore(figma, attempt + 1);
    }
    const generations: Generation[] = values.map(({ key, value }) => {
      if (!isGeneration(value) || key !== prefix + value.id) throw new Error('A saved token edit generation could not be read. Current Figma values are retained.');
      return value;
    });
    const identities = await Promise.all(generations.map(value => matchesDeviceFile(figma, value)));
    if (identities.some(match => match !== true)) { isolateDeviceFile(figma); this.#ready = false; throw new Error('Saved token forms belong to another file or its identity was removed. Current Figma values are retained.'); }
    const parents = new Set(generations.flatMap(generation => generation.parents));
    const heads = generations.filter(generation => !parents.has(generation.id)).toSorted((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
    if (generations.length && !heads.length) throw new Error('Saved token edits have an invalid history. Current Figma values are retained.');
    this.#lookup = scope.lookup; this.#heads = heads.map(head => head.id); this.#ready = true;
    this.#obsolete = generations.filter(generation => parents.has(generation.id)).map(generation => generation.id);
    const split = splitTokenForms(heads.flatMap(head => head.forms));
    return [...split.forms, ...split.conflicts];
  }
  async save(figma: ConnectionStorage, forms: TokenForm[]) {
    const scope = await deviceFileScope(figma, true); if (!scope) throw new Error('This file cannot retain token forms.');
    if (!this.#ready || this.#lookup !== scope.lookup) throw new Error('Reopen the plugin to load saved token edits before saving this form.');
    const base = scope.lookup + ':token-forms';
    const generation: Generation = { version: 2, id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      parents: this.#heads, updated: Date.now(), forms, ...(scope.fileKey ? { fileKey: scope.fileKey } : {}), ...(scope.collection ? { collection: scope.collection } : {}) };
    // Each writer gets a new key. It only supersedes generations this UI has read.
    await figma.clientStorage.setAsync(base + ':' + generation.id, generation);
    this.#heads = [generation.id];
    const obsolete = [...new Set([...this.#obsolete, ...generation.parents])];
    const retained = await Promise.all(obsolete.map(async parent => {
      try { await figma.clientStorage.deleteAsync(base + ':' + parent); return undefined; }
      catch { return parent; }
    }));
    this.#obsolete = retained.filter(parent => parent !== undefined);
  }
}
const stores = new WeakMap<ConnectionStorage, FormStore>();
function store(figma: ConnectionStorage) { let value = stores.get(figma); if (!value) { value = new FormStore(); stores.set(figma, value); } return value; }
export const restoreTokenForms = (figma: ConnectionStorage) => store(figma).restore(figma);
export const saveTokenForms = (figma: ConnectionStorage, forms: TokenForm[]) => store(figma).save(figma, forms);
