import { isProposal, repositoryName } from '../integrations/github/contract.ts';
import { isRecord } from '../lib/json.ts';
import { accessVerifier, finishSignIn, gitToken, signIn } from './auth.ts';
import type { AuthConfig } from './auth.ts';
import { GitHub, maximumWorkspaceBytes, selectedRoot } from './github.ts';
import { fail, HttpError, json, limitedText } from './http.ts';

interface Config extends AuthConfig {
  GIT_PROJECTS: string;
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

export function worker(transport: typeof fetch = fetch) {
  const verifiedSubject = accessVerifier(transport);
  return {
    async fetch(request: Request, config: Config): Promise<Response> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/git/') || url.origin !== config.EDITOR_ORIGIN) return json({ message: 'Route not found.' }, 404);
      try {
        const subject = await verifiedSubject(request, config);
        if (request.method === 'GET') {
          if (url.pathname === '/git/sign-in') return await signIn(subject, config);
          if (url.pathname === '/git/callback') return await finishSignIn(request, subject, config, transport);
          if (url.pathname === '/git/ready') {
            await gitToken(request, subject, config);
            return new Response('GitHub connected. Return to the editor and choose Open repository.', {
              headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
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
          if (url.pathname === '/git/open') return json(await github.open(repository, root));
          if (!isProposal(input)) fail(400, 'The reviewed proposal is incomplete.');
          return json({ url: await github.propose(root, input) });
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
