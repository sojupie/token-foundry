import { errorMessage, requireValue } from '../../lib/json.ts';
import { parseTokenFile } from '../../lib/parse-token-file.ts';
import { compileResolver, isResolverFile } from '../../lib/resolver.ts';
import type { TokenFile } from '../../lib/token-types.ts';
import { openWorkspaceInWorker } from './workspace-review.ts';
import { openWorkspace, workspaceChanges } from '../../lib/workspace.ts';
import type { Workspace } from '../../lib/workspace.ts';

type WritableDirectory = FileSystemDirectoryHandle & {
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};

declare global {
  interface Window {
    showDirectoryPicker?(options: { id: string; mode: 'read' }): Promise<WritableDirectory>;
  }
}

export const ignoredDirectories = new Set(['.git', 'node_modules', 'dist']);
export const isTokenFile = (name: string) => /^(?:tokens\.json|.+\.tokens(?:\.json)?)$/iu.test(name);
export const isResolverName = (name: string) => name.toLowerCase().endsWith('.resolver.json');
export const emptyFolder = 'The folder has no token files or Resolver documents.';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const writeOptions = { mode: 'exclusive', keepExistingData: false } as const;

async function listFiles(folder: FileSystemDirectoryHandle, includeAll = false) {
  const files = new Map<string, FileSystemFileHandle>();
  async function visit(directory: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, entry] of directory) {
      const path = prefix + name;
      if (entry.kind === 'directory') {
        if (!ignoredDirectories.has(name)) await visit(entry, path + '/');
      } else if (isTokenFile(name) || name.toLowerCase().endsWith('.json')) files.set(path, entry);
    }
  }
  await visit(folder, '');
  if (includeAll || [...files.keys()].some(isResolverName)) return files;
  return new Map([...files].filter(([path]) => isTokenFile(path.split('/').at(-1) ?? '')));
}

export function folderTokenSources(sources: readonly { path: string; text: string }[]) {
  if (!sources.some(source => isResolverName(source.path))) return sources;
  const parsed = sources.flatMap(({ path, text }): TokenFile[] => {
    try { return [{ path, tree: parseTokenFile(text, path) }]; }
    catch { return []; }
  });
  const used = new Set<string>();
  for (const resolver of parsed.filter(isResolverFile)) {
    for (const path of compileResolver(resolver, parsed).sourceFiles) used.add(path);
  }
  return sources.filter(({ path }) => isTokenFile(path.split('/').at(-1) ?? '') || isResolverName(path) || used.has(path));
}

async function readFile(handle: FileSystemFileHandle, path: string) {
  try {
    return decoder.decode(await (await handle.getFile()).arrayBuffer());
  } catch (failure) {
    throw new Error('Could not read ' + path + ' as UTF-8. ' + errorMessage(failure), { cause: failure });
  }
}

export async function openLocalFolder(folder: WritableDirectory) {
  const handles = await listFiles(folder);
  if (!handles.size) throw new Error(emptyFolder);
  const sources = await Promise.all([...handles.keys()].toSorted().map(async (path) => {
    const text = await readFile(requireValue(handles.get(path), path), path);
    return { path, text };
  }));
  const selected = folderTokenSources(sources);
  const workspace = selected.reduce((sum, file) => sum + file.text.length, 0) >= 64_000 ?
    await openWorkspaceInWorker(folder.name, selected) : openWorkspace(folder.name, selected);

  const reserved = new Map<string, string>();
  async function parentHandle(path: string, create: boolean) {
    const parts = path.split('/');
    const name = requireValue(parts.pop(), 'file name');
    let directory: FileSystemDirectoryHandle = folder;
    directory = await parts.reduce(async (parent, part) =>
      (await parent).getDirectoryHandle(part, { create }), Promise.resolve(directory));
    return { directory, name };
  }

  async function save(next: Workspace) {
    if (await folder.requestPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error('Write access was declined. Allow access and try again, or download a patch.');
    }
    const current = await listFiles(folder, true);
    const changes = new Map(workspaceChanges(next).map(change => [change.path, change]));
    const paths = new Set([...next.baseline.map(({ path }) => path), ...changes.keys()]);
    if ([...current.keys()].some(path => (isTokenFile(path.split('/').at(-1) ?? '') || isResolverName(path)) && !paths.has(path))) {
      throw new Error('The set of token files changed on disk. Download the patch or reopen the folder to review the current files.');
    }
    const checked = await Promise.all([...paths].map(async path => {
      const handle = current.get(path);
      const change = changes.get(path);
      const baseline = next.baseline.find(source => source.path === path);
      const before = baseline?.text ?? null;
      const after = change ? change.after : before;
      const observed = handle ? await readFile(handle, path) : null;
      if (before === null && observed !== null && reserved.get(path) !== after) throw changedOnDisk(path);
      if (observed !== before && observed !== after && !(observed === '' && reserved.get(path) === after)) throw changedOnDisk(path);
      return { path, handle, observed, after };
    }));
    const streams = new Map<string, FileSystemWritableFileStream>();
    let committing = false;
    // Serialize writes and deletes so retries can identify what reached disk.
    async function inOrder(action: (file: typeof checked[number]) => Promise<void>) {
      await checked.reduce(async (previous, file) => {
        await previous;
        await action(file);
      }, Promise.resolve());
    }
    try {
      await inOrder(async file => {
        const { path, observed, after } = file;
        if (after === null || observed === after) return;
        if (!file.handle) {
          const { directory, name } = await parentHandle(path, true);
          try {
            await directory.getFileHandle(name);
            throw changedOnDisk(path);
          } catch (failure) {
            if (!(failure instanceof DOMException) || failure.name !== 'NotFoundError') throw failure;
          }
          file.handle = await directory.getFileHandle(name, { create: true });
          reserved.set(path, after);
          committing = true;
          if (await readFile(file.handle, path) !== '') throw changedOnDisk(path);
          file.observed = '';
        }
        const stream = await file.handle.createWritable(writeOptions);
        streams.set(path, stream);
        await stream.write(after);
      });
      await Promise.all(checked.map(async ({ path, handle, observed }) => {
        if (handle && await readFile(handle, path) !== observed) throw changedOnDisk(path);
      }));
      await inOrder(async ({ path, handle, observed }) => {
        const stream = streams.get(path);
        if (!stream || !handle) return;
        if (await readFile(handle, path) !== observed) throw changedOnDisk(path);
        committing = true;
        await stream.close();
        streams.delete(path);
      });
      await inOrder(async ({ path, handle, observed, after }) => {
        if (after !== null || !handle) return;
        if (await readFile(handle, path) !== observed) throw changedOnDisk(path);
        const { directory, name } = await parentHandle(path, false);
        committing = true;
        await directory.removeEntry(name);
      });
      reserved.clear();
    } catch (failure) {
      await Promise.allSettled([...streams.values()].map(stream => stream.abort()));
      if (!committing) throw failure;
      throw new Error('Saving stopped partway through. Retry this review to finish saving files that still match. ' +
        errorMessage(failure), { cause: failure });
    }
  }

  return { workspace, save };
}

function changedOnDisk(path: string): Error {
  return new Error(path + ' changed on disk. Download the patch or reopen the folder to review the current files.');
}
