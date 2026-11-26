import { isRecord } from '../../lib/json.ts';
import { isIdentity } from './model.ts';

export interface PairingRequest { pair: string; secret: string; document: string; name: string }
export const isPairingRequest = (value: unknown): value is PairingRequest => isRecord(value) && isIdentity(value['pair']) && isIdentity(value['secret']) && typeof value['document'] === 'string' && !!value['document'] && typeof value['name'] === 'string' && !!value['name'].trim();
export function readPairing(fragment: string): PairingRequest | undefined {
  const params = new URLSearchParams(fragment.replace(/^#/u, ''));
  const value = Object.fromEntries(params);
  return isPairingRequest(value) ? value : undefined;
}
