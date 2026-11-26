import { isRecord } from '../lib/json.ts';

export interface PluginStorage { getPluginData: (key: string) => string; setPluginData: (key: string, value: string) => void }
const chunkSize = 16_000;
const maximumChunks = 2200;
interface Head { bank: 'a' | 'b'; count: number }
function readHead(text: string): Head | undefined {
  if (!text) return undefined;
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !['a', 'b'].includes(String(value['bank'])) || typeof value['count'] !== 'number' ||
    !Number.isSafeInteger(value['count']) || value['count'] < 1 || value['count'] > maximumChunks) throw new Error('The saved plugin storage index is invalid.');
  return { bank: value['bank'] === 'a' ? 'a' : 'b', count: value['count'] };
}

/** Write the inactive bank first. A single pointer write commits the complete value. */
export function writeStored(storage: PluginStorage, key: string, value: unknown): void {
  const head = readHead(storage.getPluginData(key));
  const bank = head?.bank === 'a' ? 'b' : 'a';
  const text = JSON.stringify(value);
  const count = Math.ceil(text.length / chunkSize);
  if (!count || count > maximumChunks) throw new Error('The plugin snapshot exceeds the storage limit.');
  const prefix = key + '-' + bank + '-';
  const oldCount = Number(storage.getPluginData(prefix + 'count'));
  for (let index = 0; index < count; index++) storage.setPluginData(prefix + index, text.slice(index * chunkSize, (index + 1) * chunkSize));
  for (let index = count; index < oldCount && index < maximumChunks; index++) storage.setPluginData(prefix + index, '');
  storage.setPluginData(prefix + 'count', String(count));
  // Distinguish consecutive commits even when two bank flips restore the same
  // bank/count pair. Other open controllers can then notice the new generation.
  storage.setPluginData(key, JSON.stringify({ bank, count, generation: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) }));
}

export function readStored<T>(storage: PluginStorage, key: string, valid: (value: unknown) => value is T): T | undefined {
  const head = readHead(storage.getPluginData(key));
  if (!head) return undefined;
  const parts = Array.from({ length: head.count }, (_, index) => storage.getPluginData(key + '-' + head.bank + '-' + index));
  if (parts.some(part => !part)) throw new Error('The saved plugin data is incomplete.');
  const value: unknown = JSON.parse(parts.join(''));
  if (!valid(value)) throw new Error('The saved plugin data is invalid.');
  return value;
}
