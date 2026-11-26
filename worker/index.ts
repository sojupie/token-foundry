import { isProposal, proposalBranch, repositoryName } from '../integrations/github/contract.ts';
import { isRecord } from '../lib/json.ts';
import { accessVerifier, finishSignIn, gitToken, signIn } from './auth.ts';
import type { AuthConfig } from './auth.ts';
import { GitHub, githubSession, maximumWorkspaceBytes, selectedRoot } from './github.ts';
import { fail, HttpError, json, limitedText } from './http.ts';
import { pairingPoll, workspaceInviteRedeem, workspacePlugin } from './figma-relay.ts';
import { workspaceBrowser, workspaceHeaders } from './workspace-routes.ts';
import { digest } from './workspace.ts';
import type { WorkspaceNamespace } from './workspace.ts';
import { isIdentity } from '../integrations/workspace/model.ts';

interface Config extends AuthConfig {
  GIT_PROJECTS: string;
  FIGMA_PLUGIN_ORIGIN?: string;
  FIGMA_CONNECTION_KEY?: string;
  WORKSPACES?: WorkspaceNamespace;
  WORKSPACE_INDEX?: WorkspaceNamespace;
}

async function requestJson(request: Request, origin: string): Promise<unknown> {
  if (request.headers.get('Origin') !== origin || request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
    fail(403, 'Use the editor to submit a Git request.');
  }
  const text = await limitedText(request, 6 * maximumWorkspaceBytes);
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return fail(400, 'The request does not contain valid JSON.');
  }
}

export function worker(transport: typeof fetch = (input, init) => fetch(input, init)) {
  const verifiedSubject = accessVerifier(transport);
  const repositoryPermissions = new Map<string, { allowed: boolean; expires: number }>();
  return {
    async fetch(request: Request, config: Config): Promise<Response> {
      const url = new URL(request.url);
      const pairingPath = /^\/figma\/pairing\/([a-f0-9]{64})$/u.exec(url.pathname);
      if (pairingPath?.[1] && url.origin === config.EDITOR_ORIGIN) return pairingPoll(request, config.WORKSPACE_INDEX, pairingPath[1]);
      const filePath = /^\/figma\/workspaces\/([a-f0-9]{64})\/files\/([a-f0-9]{64})$/u.exec(url.pathname);
      if (filePath && url.origin === config.EDITOR_ORIGIN) return workspacePlugin(request, config.WORKSPACES, filePath[1] ?? '', filePath[2] ?? '');
      const invitePath = /^\/figma\/workspaces\/([a-f0-9]{64})\/invites\/([a-f0-9]{64})$/u.exec(url.pathname);
      if (invitePath && url.origin === config.EDITOR_ORIGIN) return workspaceInviteRedeem(request, config.WORKSPACES, invitePath[1] ?? '', invitePath[2] ?? '', config.FIGMA_PLUGIN_ORIGIN ?? config.EDITOR_ORIGIN, config.FIGMA_PLUGIN_ORIGIN ? config.FIGMA_CONNECTION_KEY : undefined);
      if (!url.pathname.startsWith('/git/') || url.origin !== config.EDITOR_ORIGIN) return json({ message: 'Route not found.' }, 404);
      try {
        const subject = await verifiedSubject(request, config);
        const repositoryAccess = async (repository: string, root?: string): Promise<boolean> => {
          const configured = selectedRoot(config.GIT_PROJECTS, repository);
          if (root !== undefined && root !== configured) return false;
          const token = await gitToken(request, subject, config);
          const key = await digest(subject + '\0' + token + '\0' + repository.toLowerCase());
          const cached = repositoryPermissions.get(key);
          if (cached && cached.expires > Date.now()) return cached.allowed;
          const allowed = await new GitHub(repository, token, transport).canEdit();
          if (repositoryPermissions.size >= 128) repositoryPermissions.clear();
          repositoryPermissions.set(key, { allowed, expires: Date.now() + 60_000 });
          return allowed;
        };
        const shared = await workspaceBrowser(request, config, subject, repositoryAccess);
        if (shared) return shared;
        if (request.method === 'GET') {
          if (url.pathname === '/git/sign-in') return await signIn(subject, config);
          if (url.pathname === '/git/callback') return await finishSignIn(request, subject, config, transport);
          if (url.pathname === '/git/session') {
            const token = await gitToken(request, subject, config);
            return json(await githubSession(config.GIT_PROJECTS, token, transport));
          }
          if (url.pathname === '/git/ready') {
            await gitToken(request, subject, config);
            return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>GitHub connected</title>' +
              '<p>GitHub connected. <a href="/">Return to the editor</a>.</p>' +
              '<script src="/git/ready.js"></script></html>', {
              headers: {
                'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
              },
            });
          }
          if (url.pathname === '/git/ready.js') {
            return new Response("if ('BroadcastChannel' in window) { const channel = new BroadcastChannel('token-foundry-github'); channel.postMessage('ready'); channel.close(); } window.close();", {
              headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
            });
          }
        }
        if (request.method === 'POST' && (url.pathname === '/git/open' || url.pathname === '/git/propose')) {
          const token = await gitToken(request, subject, config);
          const input = await requestJson(request, url.origin);
          if (!isRecord(input) || typeof input['repository'] !== 'string' || !repositoryName.test(input['repository'])) {
            fail(400, 'Enter a GitHub repository as owner/name.');
          }
          const repository = input['repository'];
          const root = selectedRoot(config.GIT_PROJECTS, repository);
          const github = new GitHub(repository, token, transport);
          if (url.pathname === '/git/open') {
            const branch = input['branch'];
            if (branch !== undefined && (typeof branch !== 'string' || !proposalBranch.test(branch))) fail(400, 'Open a proposal created in Foundry.');
            return json(await github.open(repository, root, branch));
          }
          if (!isProposal(input)) fail(400, 'The reviewed proposal is incomplete.');
          if (input['workspace'] !== undefined) {
            if (!isIdentity(input['workspace']) || !config.WORKSPACES) fail(400, 'The shared workspace is unavailable. Retain the reviewed changes.');
            const store = config.WORKSPACES.get(config.WORKSPACES.idFromName('workspace:' + input['workspace']));
            const headers = await workspaceHeaders(store, subject, repositoryAccess);
            return store.fetch(new Request('https://workspace/proposal', {
              method: 'POST', headers: { ...headers, 'X-Foundry-Git-Token': token },
              body: JSON.stringify({ root, proposal: input }),
            }));
          }
          return json(await github.propose(root, input));
        }
        return json({ message: 'Route not found.' }, 404);
      } catch (error) {
        if (error instanceof HttpError) return json({ message: error.message, code: error.code }, error.status);
        return json({ message: 'Git could not complete the request. Try again.' }, 502);
      }
    },
  };
}

export default worker();
