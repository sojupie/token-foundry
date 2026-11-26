import { isIdentity } from '../../integrations/workspace/model.ts';

export type WorkspaceDestination = 'tokens' | 'variants' | 'workspace' | 'changes' | 'figma';

const activeRecoveryKey = 'foundry-active-recovery';
const viewPaths: Record<WorkspaceDestination, string> = {
  tokens: '/',
  variants: '/variants',
  workspace: '/workspace',
  changes: '/changes',
  figma: '/figma',
};
const pathViews = new Map<string, WorkspaceDestination>([
  ['/', 'tokens'],
  ['/variants', 'variants'],
  ['/workspace', 'workspace'],
  ['/changes', 'changes'],
  ['/figma', 'figma'],
]);

export function activeRecovery(): string | undefined {
  try { return sessionStorage.getItem(activeRecoveryKey) ?? undefined; } catch { return undefined; }
}
export function rememberActiveRecovery(id: string): void {
  try { sessionStorage.setItem(activeRecoveryKey, id); } catch { /* Recovery source data remains in IndexedDB. */ }
}
export function clearActiveRecovery(id?: string): void {
  try {
    if (id === undefined || sessionStorage.getItem(activeRecoveryKey) === id) sessionStorage.removeItem(activeRecoveryKey);
  } catch { /* Ignore unavailable sessionStorage. */ }
}
export function routeView(location: { pathname: string; hash: string } = window.location): WorkspaceDestination {
  if (location.hash.includes('pair=')) return 'figma';
  const path = location.pathname.replace(/\/+$/u, '') || '/';
  return pathViews.get(path) ?? 'tokens';
}
export function routeWorkspace(location: { search: string } = window.location): string | undefined {
  const id = new URLSearchParams(location.search).get('workspace');
  return isIdentity(id) ? id : undefined;
}
export function navigateLocation(view: WorkspaceDestination, workspaceId?: string | null, mode: 'push' | 'replace' = 'push'): void {
  const url = new URL(window.location.href);
  url.pathname = viewPaths[view];
  if (workspaceId === null) url.searchParams.delete('workspace');
  else if (typeof workspaceId === 'string') url.searchParams.set('workspace', workspaceId);
  if (view !== 'figma' || !url.hash.includes('pair=')) url.hash = '';
  if (url.href === window.location.href) return;
  const workspace = url.searchParams.get('workspace') ?? undefined;
  const state = { view, ...(workspace ? { workspace } : {}) };
  if (mode === 'push') history.pushState(state, '', url);
  else history.replaceState(state, '', url);
}
export function workspaceLocation(id?: string): void {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('workspace', id); else url.searchParams.delete('workspace');
  if (url.href !== window.location.href) history.replaceState(history.state, '', url);
}
