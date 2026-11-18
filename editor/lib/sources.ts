import { diffFile, openWorkspace, workspaceChanges } from '../../lib/workspace.ts';
import { openSampleInWorker, openWorkspaceInWorker } from './workspace-review.ts';
import type { Workspace } from '../../lib/workspace.ts';
import { decodeFolderCandidate, emptyFolder, folderTokenSources, ignoredDirectories, isFolderCandidate } from './local-folder.ts';
import reference from '../../examples/reference.tokens.json?raw';
import system from '../../examples/system.tokens.json?raw';

export function openExample(): Workspace {
  return openWorkspace('Example', [
    { path: 'reference.tokens.json', text: reference },
    { path: 'system.tokens.json', text: system },
  ]);
}

export async function openMaterialExample(): Promise<Workspace> {
  const { default: url } = await import('../../examples/material-3.zip?url&no-inline');
  return openSampleInWorker(new URL(url, document.baseURI).href);
}

export async function openFiles(files: readonly File[], folder: boolean): Promise<Workspace> {
  const first = files[0];
  if (!first) throw new Error('Choose at least one token file.');
  const name = folder ? first.webkitRelativePath.split('/')[0] : first.name;
  const available = folder ? files.filter((file) =>
    !file.webkitRelativePath.split('/').slice(1, -1).some((part) => ignoredDirectories.has(part))) : files;
  const selected = folder ? available.filter(file => isFolderCandidate(file.name)) : available;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const sources = (await Promise.all(selected.map(async file => {
    const path = folder ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
    const bytes = await file.arrayBuffer();
    const text = folder ? decodeFolderCandidate(path, bytes) : decoder.decode(bytes);
    return text === undefined ? [] : [{ path, text }];
  }))).flat();
  const input = folder ? folderTokenSources(sources) : sources;
  if (!input.length) throw new Error(emptyFolder);
  return input.reduce((sum, file) => sum + file.text.length, 0) >= 64_000 ?
    openWorkspaceInWorker(name ?? 'Token files', input) : openWorkspace(name ?? 'Token files', input);
}

export function download(name: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadPatch(workspace: Workspace): void {
  download('token-changes.patch', workspaceChanges(workspace).map(diffFile).join(''), 'text/plain');
}
