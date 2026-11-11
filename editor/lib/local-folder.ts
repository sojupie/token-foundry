import { errorMessage, requireValue } from '../../lib/json.ts';
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
export const emptyFolder = 'The folder has no tokens.json, .tokens.json, or .tokens files.';

const bom = '\uFEFF';
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const writeOptions = { mode: 'exclusive', keepExistingData: false } as const;

async function listFiles(folder: FileSystemDirectoryHandle) {
  const files = new Map<string, FileSystemFileHandle>();
  async function visit(directory: FileSystemDirectoryHandle, prefix: string) {
    for await (const [name, entry] of directory) {
      const path = prefix + name;
      if (entry.kind === 'directory') {
        if (!ignoredDirectories.has(name)) await visit(entry, path + '/');
      } else if (isTokenFile(name)) files.set(path, entry);
    }
  }
  await visit(folder, '');
  return files;
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
  const prefixes = new Map<string, string>();
  const sources = await Promise.all([...handles.keys()].toSorted().map(async (path) => {
    const text = await readFile(requireValue(handles.get(path), path), path);
    const prefix = text.startsWith(bom) ? bom : '';
    prefixes.set(path, prefix);
    return { path, text: text.slice(prefix.length) };
  }));
  const workspace = openWorkspace(folder.name, sources);

  async function save(next: Workspace) {
    if (await folder.requestPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error('Write access was declined. Allow access and try again, or download a patch.');
    }
    const current = await listFiles(folder);
    if (current.size !== next.baseline.length || next.baseline.some(({ path }) => !current.has(path))) {
      throw new Error('The set of token files changed on disk. Download the patch or reopen the folder to review the current files.');
    }
    const changes = new Map(workspaceChanges(next).map((change) => [change.path, change.after]));
    const checked = await Promise.all(next.baseline.map(async ({ path, text }) => {
      const handle = requireValue(current.get(path), path);
      const prefix = requireValue(prefixes.get(path), 'original encoding of ' + path);
      const before = prefix + text;
      const after = prefix + (changes.get(path) ?? text);
      const observed = await readFile(handle, path);
      // A retry can encounter a file that was already committed by an earlier attempt.
      if (observed !== before && observed !== after) throw changedOnDisk(path);
      return { path, handle, observed, after };
    }));
    const streams = new Map<string, FileSystemWritableFileStream>();
    let committing = false;
    try {
      await checked.reduce(async (previous, { path, handle, observed, after }) => {
        await previous;
        if (observed === after) return;
        const stream = await handle.createWritable(writeOptions);
        streams.set(path, stream);
        await stream.write(after);
      }, Promise.resolve());
      // Writes are staged until close. Check the reviewed inputs again before committing any file.
      await Promise.all(checked.map(async ({ path, handle, observed }) => {
        if (await readFile(handle, path) !== observed) throw changedOnDisk(path);
      }));
      await checked.reduce(async (previous, { path, handle, observed }) => {
        await previous;
        const stream = streams.get(path);
        if (!stream) return;
        if (committing && await readFile(handle, path) !== observed) throw changedOnDisk(path);
        committing = true;
        await stream.close();
        streams.delete(path);
      }, Promise.resolve());
    } catch (failure) {
      await Promise.allSettled([...streams.values()].map((stream) => stream.abort()));
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
