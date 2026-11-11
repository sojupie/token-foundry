import { diffFile, openWorkspace, workspaceChanges } from '../../lib/workspace.ts';
import type { Workspace } from '../../lib/workspace.ts';
import reference from '../../examples/reference.tokens.json?raw';
import system from '../../examples/system.tokens.json?raw';

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist']);

export function openExample(): Workspace {
  return openWorkspace('Example', [
    { path: 'reference.tokens.json', text: reference },
    { path: 'system.tokens.json', text: system },
  ]);
}

export async function openFiles(files: readonly File[], folder: boolean): Promise<Workspace> {
  const first = files[0];
  if (!first) throw new Error('Choose at least one token file.');
  const name = folder ? first.webkitRelativePath.split('/')[0] : first.name;
  const selected = folder ? files.filter((file) => /\.tokens(?:\.json)?$/iu.test(file.name) &&
    !file.webkitRelativePath.split('/').slice(1, -1).some((part) => ignoredDirectories.has(part))) : files;
  const sources = await Promise.all(selected.map(async (file) => ({
    path: folder ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name,
    text: await file.text(),
  })));
  if (!sources.length) throw new Error('The folder has no .tokens.json or .tokens files.');
  return openWorkspace(name ?? 'Token files', sources);
}

export function download(name: string, content: string, type: string): void {
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
