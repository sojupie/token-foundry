import { base64url } from 'jose';
import { baseChanged, commitOid, repositoryName } from '../integrations/github/contract.ts';
import type { PullRequestProposal, RepositorySnapshot } from '../integrations/github/contract.ts';
import { compileResolver, isResolverFile } from '../lib/resolver.ts';
import { parseTokenFile } from '../lib/parse-token-file.ts';
import type { TokenFile } from '../lib/token-types.ts';
import { errorMessage, isRecord, isUnknownArray } from '../lib/json.ts';
import { reviewRepositorySources } from '../lib/workspace.ts';
import { fail, limitedText } from './http.ts';

export const maximumFileBytes = 512 * 1024;
export const maximumWorkspaceBytes = 2 * 1024 * 1024;
// Opening a workspace fetches each file plus authentication and Git metadata.
const maximumFiles = 40;
const maximumChanges = 16;
const apiOrigin = 'https://api.github.com';
const pathSegment = /^[a-z\d_-][a-z\d_.-]*$/iu;
const tokenFile = /(?:^|\/)(?:tokens\.json|[^/]+\.tokens(?:\.json)?)$/iu;
const resolverFile = /\.resolver\.json$/iu;
const encoder = new TextEncoder();

function staleBase(): never {
  return fail(409, 'The default branch changed. Review the latest revision before opening a pull request.', baseChanged);
}

function safePath(path: string): boolean {
  return path.split('/').every((part) => pathSegment.test(part));
}

function configuredProjects(raw: string): Map<string, string> {
  let projects: unknown;
  try { projects = JSON.parse(raw); } catch { fail(503, 'Git repositories have not been configured.'); }
  if (!isRecord(projects)) fail(503, 'Git repositories have not been configured.');
  return new Map(Object.entries(projects).flatMap(([repository, root]) =>
    repositoryName.test(repository) && typeof root === 'string' && safePath(root) && root.split('/').length <= 5 ?
      [[repository, root] as const] : []));
}

export function selectedRoot(raw: string, repository: string): string {
  if (!repositoryName.test(repository)) fail(400, 'Enter a GitHub repository as owner/name.');
  return configuredProjects(raw).get(repository) ?? fail(404, 'This repository is not available.');
}

export async function githubSession(raw: string, token: string, transport: typeof fetch) {
  const projects = configuredProjects(raw);
  const client = new GitHub('', token, transport);
  return { login: await client.login(), repositories: await client.availableRepositories(projects.keys()) };
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
  documents: Map<string, string>;
  entries: Map<string, unknown>;
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
      redirect: 'manual',
    });
  }

  async #json(path: string, body?: Record<string, unknown>): Promise<unknown> {
    const response = await this.#request(path, body);
    if (!response.ok) apiError(response);
    const value: unknown = JSON.parse(await limitedText(response, maximumWorkspaceBytes, 502));
    return value;
  }

  async login(): Promise<string> {
    const profile = object(await this.#json('/user'));
    if (typeof profile['login'] !== 'string' || !profile['login']) fail(502, 'GitHub did not return an account name.');
    return profile['login'];
  }

  async #list(path: string, key: string, page = 1): Promise<Record<string, unknown>[]> {
    const payload = object(await this.#json(path + '?per_page=100&page=' + page));
    const entries = payload[key];
    if (!isUnknownArray(entries)) fail(502, 'GitHub did not return a repository list.');
    const batch = entries.map(object);
    return entries.length === 100 ? batch.concat(await this.#list(path, key, page + 1)) : batch;
  }

  async availableRepositories(names: Iterable<string>): Promise<string[]> {
    const projects = [...names];
    if (!projects.length) return [];
    const owners = new Set(projects.map((name) => name.split('/')[0]?.toLowerCase()));
    const installations = await this.#list('/user/installations', 'installations');
    const eligible = installations.flatMap(({ account, id }) =>
      typeof id === 'number' && Number.isSafeInteger(id) && id > 0 &&
      isRecord(account) && typeof account['login'] === 'string' && owners.has(account['login'].toLowerCase()) ? [id] : []);
    const repositories = await Promise.all(eligible.map((id) => this.#list('/user/installations/' + id + '/repositories', 'repositories')));
    const available = new Set(repositories.flat().flatMap(({ full_name: name }) => typeof name === 'string' ? [name.toLowerCase()] : []));
    return projects.filter((name) => available.has(name.toLowerCase())).toSorted();
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
    const occupied = new Map(entries.flatMap(({ path, type }) =>
      typeof path === 'string' ? [[root + '/' + path, type] as const] : []));
    const candidates = new Map(entries.flatMap(({ path, type, mode, size: bytes }) =>
      type === 'blob' && mode === '100644' && typeof path === 'string' && safePath(path) ?
        [[root + '/' + path, bytes] as const] : []));
    const files = new Set<string>();
    const documents = new Map<string, string>();
    let size = 0;
    function include(path: string) {
      if (files.has(path) || !candidates.has(path)) return;
      const bytes = candidates.get(path);
      if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumFileBytes) {
        fail(422, 'A token or Resolver source exceeds the size limit or could not be read.');
      }
      size += bytes;
      files.add(path);
      if (files.size > maximumFiles || size > maximumWorkspaceBytes) fail(422, 'The token workspace exceeds the size limit.');
    }
    for (const path of candidates.keys()) {
      if (tokenFile.test(path) || resolverFile.test(path)) include(path);
    }
    if (!files.size) fail(422, 'The token folder contains no token files or Resolver documents.');

    if ([...files].some(path => resolverFile.test(path))) {
      const expandSources = async (): Promise<void> => {
        const pending = [...files].filter(path => !documents.has(path));
        if (!pending.length) return;
        const texts = await Promise.all(pending.map(async path => [path, await this.#file(path, revision)] as const));
        for (const [path, text] of texts) documents.set(path, text);
        const parsed = [...documents].flatMap(([path, text]): TokenFile[] => {
          try { return [{ path, tree: parseTokenFile(text, path) }]; }
          catch { return []; }
        });
        for (const document of parsed.filter(isResolverFile)) {
          for (const path of compileResolver(document, parsed).sourceFiles) {
            if (path.toLowerCase().endsWith('.json') || tokenFile.test(path)) include(path);
          }
        }
        await expandSources();
      };
      await expandSources();
    }
    return { branch, revision, files: [...files].toSorted(), size, documents, entries: occupied };
  }

  async #file(path: string, revision: string): Promise<string> {
    const response = await this.#request(this.#prefix + '/contents/' + path + '?ref=' + revision, undefined, 'application/vnd.github.raw+json');
    if (!response.ok) apiError(response);
    return limitedText(response, maximumFileBytes, 422, true);
  }

  async open(repository: string, root: string): Promise<RepositorySnapshot> {
    const { revision, files, documents } = await this.#project(root);
    const sources = await Promise.all(files.map(async (path) => ({ path, text: documents.get(path) ?? await this.#file(path, revision) })));
    return { repository, revision, root, files: sources };
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
        fileChanges: {
          additions: changes.flatMap(({ path, after }) => after === null ? [] : [{ path, contents: base64(after) }]),
          ...(changes.some(({ after }) => after === null) ? { deletions: changes.flatMap(({ path, after }) => after === null ? [{ path }] : []) } : {}),
        },
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
    const expected = new Map(changes.map(({ path, before, after }) => [path, before === null ? 'added' : after === null ? 'removed' : 'modified']));
    function accepts(path: unknown, status: unknown) {
      return typeof path === 'string' && expected.get(path) === status && expected.delete(path);
    }
    if (comparison['total_commits'] !== 1 || !isUnknownArray(changed) ||
      !changed.every(value => isRecord(value) && (value['status'] === 'renamed'
        ? accepts(value['previous_filename'], 'removed') && accepts(value['filename'], 'added')
        : accepts(value['filename'], value['status']))) || expected.size) {
      fail(409, 'The proposal branch contains different changes.');
    }
    const matches = await Promise.all(changes.map(async ({ path, after }) => after === null || await this.#file(path, headOid) === after));
    if (matches.includes(false)) fail(409, 'The proposal branch contains different file contents.');
  }

  async propose(root: string, { repository, revision, changes }: PullRequestProposal): Promise<string> {
    if (changes.length > maximumChanges) fail(422, 'Review at most ' + maximumChanges + ' changed files at once.');
    const project = await this.#project(root);
    if (revision !== project.revision) staleBase();
    const paths = new Set(project.files);
    const seen = new Set<string>();
    const prospective = new Map(project.documents);
    const additions = new Set<string>();
    let size = project.size;
    let count = paths.size;
    for (const { path, before, after } of changes) {
      if (seen.has(path) || !safePath(path) || !path.startsWith(root + '/')) {
        fail(400, 'A proposed file is duplicated or outside the configured token workspace.');
      }
      seen.add(path);
      if (before === null) {
        const parts = path.split('/');
        if (project.entries.has(path) || (!tokenFile.test(path) && !path.toLowerCase().endsWith('.json')) ||
          parts.slice(root.split('/').length, -1).some((_, index) => {
            const type = project.entries.get(parts.slice(0, root.split('/').length + index + 1).join('/'));
            return type !== undefined && type !== 'tree';
          })) {
          fail(400, 'A new file would overwrite a repository entry or has an unsupported name.');
        }
        additions.add(path);
        count++;
      } else if (!paths.has(path)) fail(400, 'The proposed file is outside the opened token workspace.');
      if (after === null) count--;
      const bytes = after === null ? 0 : encoder.encode(after).byteLength;
      if (after === before || bytes > maximumFileBytes) fail(400, 'A changed file is unchanged or too large.');
      size += bytes - (before === null ? 0 : encoder.encode(before).byteLength);
      if (after === null) {
        prospective.delete(path);
        continue;
      }
      prospective.set(path, after);
      let value: unknown;
      try { value = JSON.parse(after.replace(/^\uFEFF/u, '')); } catch { fail(422, path + ' is not valid JSON.'); }
      if (!isRecord(value)) fail(422, path + ' must contain a token document.');
    }
    if ([...additions].some(path => [...additions].some(other => path !== other && path.startsWith(other + '/')))) {
      fail(400, 'A proposed destination conflicts with another new file.');
    }
    const dependentAdditions = [...additions].filter(path => !tokenFile.test(path) && !resolverFile.test(path));
    if (dependentAdditions.length) {
      const parsed = [...prospective].flatMap(([path, text]): TokenFile[] => {
        try { return [{ path, tree: parseTokenFile(text, path) }]; }
        catch { return []; }
      });
      const referenced = new Set<string>();
      for (const file of parsed.filter(isResolverFile)) {
        for (const path of compileResolver(file, parsed).sourceFiles) referenced.add(path);
      }
      if (dependentAdditions.some(path => !referenced.has(path))) {
        fail(400, 'A new JSON file must be referenced by a Resolver or use a token file name.');
      }
    }
    if (size > maximumWorkspaceBytes || count > maximumFiles) fail(422, 'The proposed token workspace exceeds the size limit.');
    const sources = await Promise.all(project.files.map(async path => ({
      path, text: project.documents.get(path) ?? await this.#file(path, revision),
    })));
    const original = new Map(sources.map(({ path, text }) => [path, text]));
    for (const { path, before } of changes) {
      if ((original.get(path) ?? null) !== before) fail(409, 'The proposal no longer matches the original file contents.');
    }
    const proposed = new Map(original);
    for (const { path, after } of changes) {
      if (after === null) proposed.delete(path);
      else proposed.set(path, after);
    }
    let validation: ReturnType<typeof reviewRepositorySources>;
    try {
      validation = reviewRepositorySources(repository, sources, [...proposed].map(([path, text]) => ({ path, text })));
    } catch (failure) {
      fail(422, errorMessage(failure));
    }
    if (validation.validationErrors?.length) fail(422, validation.validationErrors.join('\n'));

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
