export const figmaRelayOrigin = 'https://token-foundry-figma-relay-staging.ollemarmenlind02.workers.dev';

export const ALLOWED_FOUNDRY_ORIGINS = [
  'https://sevan.tokenfoundry.lindstruct.com',
  'https://sevan.foundry.tokencatalog.dev',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

const foundryOriginSet = new Set<string>(ALLOWED_FOUNDRY_ORIGINS);

export const isAllowedFoundryOrigin = (origin: string): boolean =>
  foundryOriginSet.has(origin);

const allowedCodeOrigins = new Set([figmaRelayOrigin, ...ALLOWED_FOUNDRY_ORIGINS]);

export function parseConnection(value: string) {
  // Canonical codes only. This also runs in the native plugin sandbox, which
  // has no DOM URL constructor. Reject encoded/normalized lookalike origins.
  const code = value.trim();
  const match = /^(https:\/\/[^/#?]+|http:\/\/(?:localhost|127\.0\.0\.1):5173)(\/figma\/workspaces\/[a-f0-9]{64}\/files\/[a-f0-9]{64})#([a-f0-9]{64})$/u.exec(code);
  if (!match?.[1] || !match[2] || !match[3] || !allowedCodeOrigins.has(match[1])) {
    throw new Error('Paste a connection code from the Sevan Foundry or the local development server.');
  }
  return { url: match[1] + match[2], secret: match[3] };
}

export function parseInviteCode(value: string) {
  const code = value.trim();
  const match = /^(https:\/\/[^/#?]+|http:\/\/(?:localhost|127\.0\.0\.1):5173)(\/figma\/workspaces\/[a-f0-9]{64}\/invites\/[a-f0-9]{64})#([a-f0-9]{64})$/u.exec(code);
  if (!match?.[1] || !match[2] || !match[3] || !allowedCodeOrigins.has(match[1])) {
    throw new Error('Paste a valid pairing or connection code from Foundry.');
  }
  return { url: match[1] + match[2], secret: match[3] };
}
