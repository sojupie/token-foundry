import { fail } from './http.ts';

async function key(value: string | undefined) {
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) fail(503, 'Figma relay is not configured.');
  const bytes = Uint8Array.from(value.match(/../gu) ?? [], part => Number.parseInt(part, 16));
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
const message = (id: string) => new TextEncoder().encode('foundry-figma-sync-v1\0' + id);

export async function figmaCapability(id: string, secret: string | undefined): Promise<string> {
  const signed = await crypto.subtle.sign('HMAC', await key(secret), message(id));
  return [...new Uint8Array(signed)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function verifyFigmaCapability(request: Request, id: string, secret: string | undefined): Promise<boolean> {
  const imported = await key(secret);
  const bearer = /^Bearer ([a-f0-9]{64})$/iu.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!bearer) return false;
  const bytes = Uint8Array.from(bearer.match(/../gu) ?? [], part => Number.parseInt(part, 16));
  return crypto.subtle.verify('HMAC', imported, bytes, message(id));
}
