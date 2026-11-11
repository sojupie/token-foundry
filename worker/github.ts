import { base64url } from 'jose';
import { baseChanged, commitOid, repositoryName } from '../integrations/github/contract.ts';
import type { PullRequestProposal, RepositorySnapshot } from '../integrations/github/contract.ts';
import { isRecord, isUnknownArray } from '../lib/json.ts';
import { fail, limitedText } from './http.ts';

export const maximumFileBytes = 512 * 1024;
export const maximumWorkspaceBytes = 2 * 1024 * 1024;
const maximumFiles = 24;
const maximumChanges = 16;
const apiOrigin = 'https://api.github.com';
const pathSegment = /^[a-z\d_-][a-z\d_.-]*$/iu;
const tokenFile = /(?:^|\/)(?:tokens\.json|[^/]+\.tokens(?:\.json)?)$/iu;
const encoder = new TextEncoder();

function staleBase(): never {
  return fail(409, 'The default branch changed. Review the latest revision before opening a pull request.', baseChanged);
}

function safePath(path: string): boolean {
  return path.split('/').every((part) => pathSegment.test(part));
}

export function selectedRoot(raw: string, repository: string): string {
  if (!repositoryName.test(repository)) fail(400, 'Enter a GitHub repository as owner/name.');
  let projects: unknown;
  try { projects = JSON.parse(raw); } catch { fail(503, 'Git repositories have not been configured.'); }
  if (!isRecord(projects)) fail(503, 'Git repositories have not been configured.');
  const root = Object.hasOwn(projects, repository) ? projects[repository] : undefined;
  if (typeof root !== 'string' || !safePath(root) || root.split('/').length > 5) fail(404, 'This repository is not available.');
  return root;
}

function oid(value: unknown): string {
  if (typeof value !== 'string' || !commitOid.test(value)) fail(502, 'GitHub returned an invalid commit or tree.');
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail(502, 'GitHub returned an unexpected response.');
  return value;
}

function base64(text: string): string {
  const value = base64url.encode(encoder.encode(text)).replaceAll('-', '+').replaceAll('_', '/');
  return value.padEnd(Math.ceil(value.length / 4) * 4, '=');
}

function apiError(response: Response): never {
  if (response.status === 401) fail(401, 'Your GitHub session has expired. Sign in again.');
  if (response.status === 429 || response.headers.get('X-RateLimit-Remaining') === '0') fail(429, 'GitHub rate limited this request. Try again later.');
  if (response.status === 403 || response.status === 404) fail(403, 'Check your repository access and the GitHub App installation.');
  return fail(502, 'GitHub could not complete the request. Try again.');
}

interface Project {
  branch: string;
  revision: string;
  files: string[];
  size: number;
}

export class GitHub {
  readonly #prefix: string;
  readonly #headers: Record<string, string>;
  readonly #transport: typeof fetch;

  constructor(repository: string, token: string, transport: typeof fetch) {
    this.#prefix = '/repos/' + repository;
    this.#headers = { Authorization: 'Bearer ' + token, 'User-Agent': 'Design-Token-Editor', 'X-GitHub-Api-Version': '2022-11-28' };
    this.#transport = transport;
  }

  async #request(path: string, body?: Record<string, unknown>, accept = 'application/vnd.github+json') {
    return this.#transport(new URL(path, apiOrigin), {
      method: body ? 'POST' : 'GET',
      headers: { ...this.#headers, Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : null,
      redirect: 'error',
    });
  }

  async #json(path: string, body?: Record<string, unknown>): Promise<unknown> {
    const response = await this.#request(path, body);
    if (!response.ok) apiError(response);
    const value: unknown = JSON.parse(await limitedText(response, maximumWorkspaceBytes, 502));
    return value;
  }

  async #tree(tree: string, recursive = false) {
    const response = object(await this.#json(this.#prefix + '/git/trees/' + tree + (recursive ? '?recursive=1' : '')));
    if (response['truncated'] !== false || !isUnknownArray(response['tree'])) fail(422, 'The repository tree is too large or could not be read.');
    return response['tree'].map(object);
  }

  async #directoryTree(tree: string, [directory, ...rest]: string[]): Promise<string> {
    if (!directory) return tree;
    const entries = await this.#tree(tree);
    const next = entries.find((item) => item['path'] === directory && item['type'] === 'tree');
    if (!next) fail(422, 'The configured token folder does not exist on the default branch.');
    return this.#directoryTree(oid(next['sha']), rest);
  }

  async #project(root: string): Promise<Project> {
    const metadata = object(await this.#json(this.#prefix));
    const branch = metadata['default_branch'];
    if (typeof branch !== 'string' || !branch) fail(422, 'The repository has no default branch.');
    const ref = object(await this.#json(this.#prefix + '/git/ref/heads/' + encodeURIComponent(branch)));
    const revision = oid(object(ref['object'])['sha']);
    const commit = object(await this.#json(this.#prefix + '/git/commits/' + revision));
    const tree = await this.#directoryTree(oid(object(commit['tree'])['sha']), root.split('/'));
    const entries = await this.#tree(tree, true);
    let size = 0;
    const files = entries.flatMap(({ path, type, mode, size: bytes }) => {
      if (type !== 'blob' || mode !== '100644' || typeof path !== 'string' || !safePath(path) || !tokenFile.test(path)) return [];
      if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumFileBytes) {
        fail(422, 'A token file exceeds the size limit or could not be read.');
      }
      size += bytes;
      return [root + '/' + path];
    }).toSorted();
    if (!files.length || files.length > maximumFiles) fail(422, 'The token folder must contain between 1 and ' + maximumFiles + ' token files.');
    if (size > maximumWorkspaceBytes) fail(422, 'The token workspace exceeds the size limit.');
    return { branch, revision, files, size };
  }

  async #file(path: string, revision: string): Promise<string> {
    const response = await this.#request(this.#prefix + '/contents/' + path + '?ref=' + revision, undefined, 'application/vnd.github.raw+json');
    if (!response.ok) apiError(response);
    return limitedText(response, maximumFileBytes, 422);
  }

  async open(repository: string, root: string): Promise<RepositorySnapshot> {
    const { revision, files } = await this.#project(root);
    const sources = await Promise.all(files.map(async (path) => ({ path, text: await this.#file(path, revision) })));
    return { repository, revision, files: sources };
  }

  async #findPull(repository: string, head: string, base: string): Promise<string | undefined> {
    const query = new URLSearchParams({ head: repository.split('/')[0] + ':' + head, base, state: 'open' });
    const pulls = await this.#json(this.#prefix + '/pulls?' + query.toString());
    if (!isUnknownArray(pulls)) fail(502, 'GitHub returned an unexpected pull request list.');
    return pulls.length ? this.#pullUrl(repository, object(pulls[0])) : undefined;
  }

  #pullUrl(repository: string, result: Record<string, unknown>): string {
    const number = result['number'];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) fail(502, 'GitHub did not return a pull request number.');
    return 'https://github.com/' + repository + '/pull/' + number;
  }

  async #ref(head: string): Promise<string | undefined> {
    const response = await this.#request(this.#prefix + '/git/ref/heads/' + encodeURIComponent(head));
    if (response.status === 404) return undefined;
    if (!response.ok) apiError(response);
    const result: unknown = await response.json();
    return oid(object(object(result)['object'])['sha']);
  }

  async #commit(repository: string, revision: string, head: string, changes: PullRequestProposal['changes']) {
    const response = object(await this.#json('/graphql', {
      query: 'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
      variables: { input: {
        branch: { repositoryNameWithOwner: repository, branchName: head },
        expectedHeadOid: revision,
        message: { headline: 'Update design tokens' },
        fileChanges: { additions: changes.map(({ path, after }) => ({ path, contents: base64(after) })) },
      } },
    }));
    if (!isRecord(response['data']) || !isRecord(response['data']['createCommitOnBranch'])) {
      fail(409, 'The proposal branch could not be committed. Retry or check repository branch rules.');
    }
    oid(object(response['data']['createCommitOnBranch']['commit'])['oid']);
  }

  async #verifyCommit(revision: string, headOid: string, changes: PullRequestProposal['changes']) {
    const comparison = object(await this.#json(this.#prefix + '/compare/' + revision + '...' + headOid));
    const changed = comparison['files'];
    const expected = new Set(changes.map(({ path }) => path));
    if (comparison['total_commits'] !== 1 || !isUnknownArray(changed) || changed.length !== expected.size ||
      !changed.every((value) => isRecord(value) && typeof value['filename'] === 'string' &&
        value['status'] === 'modified' && expected.delete(value['filename']))) {
      fail(409, 'The proposal branch contains different changes.');
    }
    const matches = await Promise.all(changes.map(async ({ path, after }) => await this.#file(path, headOid) === after));
    if (matches.includes(false)) fail(409, 'The proposal branch contains different file contents.');
  }

  async propose(root: string, { repository, revision, changes }: PullRequestProposal): Promise<string> {
    if (changes.length > maximumChanges) fail(422, 'Review at most ' + maximumChanges + ' changed files at once.');
    const project = await this.#project(root);
    if (revision !== project.revision) staleBase();
    const paths = new Set(project.files);
    let size = project.size;
    for (const { path, before, after } of changes) {
      if (!paths.delete(path)) fail(400, 'A proposed file is duplicated or outside the configured token workspace.');
      const bytes = encoder.encode(after).byteLength;
      if (after === before || bytes > maximumFileBytes) fail(400, 'A changed file is unchanged or too large.');
      size += bytes - encoder.encode(before).byteLength;
      let value: unknown;
      try { value = JSON.parse(after); } catch { fail(422, path + ' is not valid JSON.'); }
      if (!isRecord(value)) fail(422, path + ' must contain a token document.');
    }
    const matches = await Promise.all(changes.map(async ({ path, before }) => await this.#file(path, revision) === before));
    if (matches.includes(false)) fail(409, 'The proposal no longer matches the original file contents.');
    if (size > maximumWorkspaceBytes) fail(422, 'The proposed token workspace exceeds the size limit.');

    const ordered = changes.toSorted((left, right) => left.path.localeCompare(right.path, 'en'));
    const digest = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([revision, ordered.map(({ path, after }) => [path, after])])))));
    const head = 'token-editor/' + digest;
    let headOid = await this.#ref(head);
    if (!headOid) {
      const response = await this.#request(this.#prefix + '/git/refs', { ref: 'refs/heads/' + head, sha: revision });
      if (!response.ok && response.status !== 422) apiError(response);
      headOid = response.ok ? revision : await this.#ref(head);
      if (!headOid) fail(409, 'The proposal branch could not be created. Check repository branch rules.');
    }
    if (headOid === revision) await this.#commit(repository, revision, head, ordered);
    else {
      await this.#verifyCommit(revision, headOid, ordered);
      const existing = await this.#findPull(repository, head, project.branch);
      if (existing) return existing;
    }
    if (await this.#ref(project.branch) !== revision) staleBase();
    const response = await this.#request(this.#prefix + '/pulls', {
      title: 'Update design tokens', head, base: project.branch, body: 'Proposed from Token Editor.',
    });
    if (response.status === 422) {
      const existing = await this.#findPull(repository, head, project.branch);
      if (existing) return existing;
      fail(409, 'GitHub could not open the pull request. The proposal branch is available for retry.');
    }
    if (!response.ok) apiError(response);
    const result: unknown = await response.json();
    return this.#pullUrl(repository, object(result));
  }
}
