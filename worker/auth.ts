import { base64url, createRemoteJWKSet, customFetch, EncryptJWT, jwtDecrypt, jwtVerify } from 'jose';
import { isRecord } from '../lib/json.ts';
import { cookie, fail, readCookie, redirect } from './http.ts';

export interface AuthConfig {
  EDITOR_ORIGIN: string;
  ACCESS_ISSUER: string;
  ACCESS_AUDIENCE: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GIT_SESSION_KEY: string;
}

const stateCookie = '__Secure-token-git-state';
const sessionCookie = '__Secure-token-git-session';
const stateAge = 600;
const sessionAge = 8 * 3600;
const oauthOrigin = 'https://github.com';
const callback = (origin: string) => origin + '/git/callback';
const random = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));

export function accessVerifier(transport: typeof fetch) {
  const issuers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  return async (request: Request, config: AuthConfig): Promise<string> => {
    const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!assertion) fail(403, 'An invitation is required to use hosted Git.');
    const issuer = new URL(config.ACCESS_ISSUER);
    if (issuer.protocol !== 'https:' || !issuer.hostname.endsWith('.cloudflareaccess.com') || issuer.origin !== config.ACCESS_ISSUER || !config.ACCESS_AUDIENCE) {
      fail(503, 'The Git integration is unavailable.');
    }
    let keySet = issuers.get(issuer.origin);
    if (!keySet) {
      keySet = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), { [customFetch]: transport });
      issuers.set(issuer.origin, keySet);
    }
    try {
      const { payload } = await jwtVerify(assertion, keySet, {
        issuer: issuer.origin, audience: config.ACCESS_AUDIENCE, algorithms: ['RS256'], requiredClaims: ['exp', 'sub'],
      });
      if (payload.sub) return payload.sub;
    } catch {
      fail(403, 'An invitation is required to use hosted Git.');
    }
    return fail(403, 'An invitation is required to use hosted Git.');
  };
}

function encryptionKey(config: AuthConfig): Uint8Array {
  const encoded = config.GIT_SESSION_KEY;
  if (!/^[\w-]{43}$/u.test(encoded)) fail(503, 'The Git integration is unavailable.');
  const key = base64url.decode(encoded);
  if (key.byteLength !== 32) fail(503, 'The Git integration is unavailable.');
  return key;
}

async function seal(payload: Record<string, string>, subject: string, purpose: string, age: number, config: AuthConfig) {
  return new EncryptJWT(payload).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).setSubject(subject)
    .setAudience(purpose).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + age).encrypt(encryptionKey(config));
}

async function unseal(value: string | undefined, subject: string, purpose: string, config: AuthConfig) {
  if (!value) return undefined;
  const key = encryptionKey(config);
  try {
    const { payload } = await jwtDecrypt(value, key, {
      subject, audience: purpose, keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'], requiredClaims: ['exp'],
    });
    return payload;
  } catch {
    return undefined;
  }
}

export async function signIn(subject: string, config: AuthConfig): Promise<Response> {
  if (!config.GITHUB_CLIENT_ID) fail(503, 'The Git integration is unavailable.');
  const state = random();
  const verifier = random();
  const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL('/login/oauth/authorize', oauthOrigin);
  url.search = new URLSearchParams({
    client_id: config.GITHUB_CLIENT_ID, redirect_uri: callback(config.EDITOR_ORIGIN),
    state, code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'false',
  }).toString();
  const sealed = await seal({ state, verifier }, subject, stateCookie, stateAge, config);
  return redirect(url.href, [cookie(stateCookie, sealed, stateAge)]);
}

export async function finishSignIn(request: Request, subject: string, config: AuthConfig, transport: typeof fetch): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const state = await unseal(readCookie(request, stateCookie), subject, stateCookie, config);
  const code = query.get('code');
  if (!code || typeof state?.['state'] !== 'string' || query.get('state') !== state['state'] || typeof state['verifier'] !== 'string') {
    fail(400, 'Sign-in expired or could not be verified. Start again in the editor.');
  }
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) fail(503, 'The Git integration is unavailable.');
  const response = await transport(new URL('/login/oauth/access_token', oauthOrigin), {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: config.GITHUB_CLIENT_ID, client_secret: config.GITHUB_CLIENT_SECRET,
      redirect_uri: callback(config.EDITOR_ORIGIN), code, code_verifier: state['verifier'],
    }),
    redirect: 'manual',
  });
  if (!response.ok) fail(502, 'GitHub could not complete sign-in. Start again in the editor.');
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload['access_token'] !== 'string' || !/^ghu_\w+$/u.test(payload['access_token'])) {
    fail(401, 'GitHub did not authorize the app. Start sign-in again in the editor.');
  }
  const expires = payload['expires_in'];
  const age = typeof expires === 'number' && Number.isSafeInteger(expires) && expires > 0 ? Math.min(expires, sessionAge) : sessionAge;
  const sealed = await seal({ token: payload['access_token'] }, subject, sessionCookie, age, config);
  return redirect('/git/ready', [cookie(sessionCookie, sealed, age), cookie(stateCookie, '', 0)]);
}

export async function gitToken(request: Request, subject: string, config: AuthConfig): Promise<string> {
  const session = await unseal(readCookie(request, sessionCookie), subject, sessionCookie, config);
  if (typeof session?.['token'] !== 'string') fail(401, 'Sign in to GitHub to continue.');
  return session['token'];
}
