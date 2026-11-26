import { isRecord } from '../lib/json.ts';
import { parseConnection } from '../integrations/figma/transport.ts';

interface DeviceConnection { version: 1; code: string; name: string; expires?: number; fileKey?: string; collection?: string; concept?: boolean }
export interface ConnectionStorage {
  fileKey?: string | undefined;
  variables?: {
    getLocalVariableCollectionsAsync: () => Promise<{ key: string; getPluginData: (key: string) => string }[]>;
    createVariableCollection?: (name: string) => { key: string; hiddenFromPublishing: boolean; setPluginData: (key: string, value: string) => void };
  };
  root: { getPluginData: (key: string) => string; setPluginData: (key: string, value: string) => void };
  clientStorage: { getAsync: (key: string) => Promise<unknown>; setAsync: (key: string, value: unknown) => Promise<void>; deleteAsync: (key: string) => Promise<void>; keysAsync?: () => Promise<string[]> };
  ui: { postMessage: (message: unknown, options: { origin: string }) => void };
}
function read(value: unknown): DeviceConnection | undefined {
  if (!isRecord(value) || value['version'] !== 1 || typeof value['code'] !== 'string' || typeof value['name'] !== 'string' ||
    value['expires'] !== undefined && (typeof value['expires'] !== 'number' || !Number.isFinite(value['expires'])) ||
    value['fileKey'] !== undefined && typeof value['fileKey'] !== 'string' || value['collection'] !== undefined && typeof value['collection'] !== 'string' || value['concept'] !== undefined && typeof value['concept'] !== 'boolean') return undefined;
  parseConnection(value['code']);
  return { version: 1, code: value['code'], name: value['name'], ...(typeof value['expires'] === 'number' ? { expires: value['expires'] } : {}),
    ...(typeof value['fileKey'] === 'string' ? { fileKey: value['fileKey'] } : {}), ...(typeof value['collection'] === 'string' ? { collection: value['collection'] } : {}), ...(typeof value['concept'] === 'boolean' ? { concept: value['concept'] } : {}) };
}
const identityValue = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const collectionKeys = async (figma: ConnectionStorage) => (await figma.variables?.getLocalVariableCollectionsAsync())?.filter(collection =>
  collection.getPluginData('foundry-collection') === '1' || collection.getPluginData('foundry-connection-anchor') === '1').map(collection => collection.key) ?? [];
function resetIdentity(figma: ConnectionStorage) {
  figma.root.setPluginData('foundry-device-connection', identityValue());
  figma.root.setPluginData('foundry-document-identity', identityValue());
}
export { resetIdentity as isolateDeviceFile };
export async function matchesDeviceFile(figma: ConnectionStorage, value: { fileKey?: string; collection?: string }): Promise<boolean | undefined> {
  if (value.fileKey && figma.fileKey) return value.fileKey === figma.fileKey;
  const collections = await collectionKeys(figma);
  return value.collection ? collections.includes(value.collection) : undefined;
}
export async function deviceFileScope(figma: ConnectionStorage, create = false) {
  // inspect() establishes this identity once. Form writes stay in device storage
  // and must not add document mutations to native Undo/Redo.
  const identity = figma.root.getPluginData('foundry-document-identity');
  const collection = (await collectionKeys(figma))[0];
  if (create && !identity) throw new Error('Open this file again before saving token forms.');
  if (create && !figma.fileKey && !collection) throw new Error('Import source variables or connect this file before saving token forms.');
  return identity ? { lookup: 'foundry-file:' + identity, ...(figma.fileKey ? { fileKey: figma.fileKey } : {}), ...(collection ? { collection } : {}) } : undefined;
}
function key(figma: ConnectionStorage, create = false): string | undefined {
  let identity = figma.root.getPluginData('foundry-device-connection');
  if (!identity && create) {
    // The lookup is copied with the file. A native file/collection key must
    // also match before its saved capability can resume automatically.
    identity = identityValue();
    figma.root.setPluginData('foundry-device-connection', identity);
  }
  return identity ? 'foundry-connection:' + identity : undefined;
}
export async function restoreConnection(figma: ConnectionStorage, ready?: (code: string, concept?: boolean) => Promise<void>) {
  const identity = key(figma);
  const stored: unknown = identity ? await figma.clientStorage.getAsync(identity) : undefined;
  const value = read(stored);
  const match = value ? await matchesDeviceFile(figma, value) : undefined;
  if (value && match !== true) {
    resetIdentity(figma);
    await ready?.('');
    figma.ui.postMessage({ type: 'saved-connection', code: '', problem: 'Connect this file again to verify its identity. Local values are retained; the saved connection has not been used.' }, { origin: '*' });
  } else {
    const concept = value?.concept ?? !!(value?.collection && (await figma.variables?.getLocalVariableCollectionsAsync())?.some(collection => collection.key === value.collection && collection.getPluginData('foundry-connection-anchor') === '1'));
    await ready?.(value?.code ?? '', concept);
    figma.ui.postMessage({ type: 'saved-connection', ...(value ? { ...value, concept, resume: true } : { code: '' }) }, { origin: '*' });
  }
}
export async function rememberConnection(figma: ConnectionStorage, code: string, name: string, expires?: number, concept = false) {
  parseConnection(code);
  let identity = key(figma, true);
  if (!identity) throw new Error('The file cannot retain a device connection.');
  const previous = read(await figma.clientStorage.getAsync(identity));
  if (previous && await matchesDeviceFile(figma, previous) === false) { resetIdentity(figma); identity = key(figma, true); }
  if (!identity) throw new Error('The file cannot retain a device connection.');
  const collections = await collectionKeys(figma);
  let collection = previous?.collection && collections.includes(previous.collection) ? previous.collection : collections[0];
  if (!collection && !figma.fileKey && concept) {
    const anchor = figma.variables?.createVariableCollection?.('Foundry connection');
    if (!anchor) throw new Error('The concept file cannot retain its connection identity.');
    anchor.setPluginData('foundry-connection-anchor', '1');
    anchor.hiddenFromPublishing = true;
    collection = anchor.key;
  }
  await figma.clientStorage.setAsync(identity, { version: 1, code, name, concept, ...(expires !== undefined ? { expires } : previous?.expires !== undefined ? { expires: previous.expires } : {}),
    ...(figma.fileKey ? { fileKey: figma.fileKey } : {}), ...(collection ? { collection } : {}) });
}
export async function forgetConnection(figma: ConnectionStorage) {
  const identity = key(figma);
  const stored = identity ? read(await figma.clientStorage.getAsync(identity)) : undefined;
  if (stored && await matchesDeviceFile(figma, stored) === false) resetIdentity(figma);
  else if (identity) await figma.clientStorage.deleteAsync(identity);
  figma.ui.postMessage({ type: 'connection-forgotten' }, { origin: '*' });
}
