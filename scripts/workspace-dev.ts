import type { Plugin } from 'vite';
import { SharedWorkspaceStore, WorkspaceRegistry } from '../worker/workspace.ts';
import type { WorkspaceNamespace } from '../worker/workspace.ts';
import { workspaceBrowser } from '../worker/workspace-routes.ts';
import { pairingPoll, workspaceInviteRedeem, workspacePlugin } from '../worker/figma-relay.ts';
import { HttpError } from '../worker/http.ts';

function createNamespace(registry = false, index?: WorkspaceNamespace): WorkspaceNamespace {
      const instances = new Map<string, SharedWorkspaceStore | WorkspaceRegistry>();
      return { idFromName: name => name, get: name => {
        if (typeof name !== 'string') throw new Error('Invalid workspace identity.');
        const previous = instances.get(name); if (previous) return previous;
        const values = new Map<string, unknown>(); let sequence = Promise.resolve();
        const state = { storage: { get: (key: string) => Promise.resolve(structuredClone(values.get(key))), put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); return Promise.resolve(); },
          delete: (key: string) => Promise.resolve(values.delete(key)), deleteAll: () => { values.clear(); return Promise.resolve(); } },
          blockConcurrencyWhile: <T>(action: () => Promise<T>) => { const next = sequence.then(action); sequence = next.then(() => undefined, () => undefined); return next; } };
        const instance = registry ? new WorkspaceRegistry(state) : new SharedWorkspaceStore(state, index ? { WORKSPACE_INDEX: index } : {}); instances.set(name, instance); return instance;
      } };
}

export function workspaceDev(): Plugin {
  return { name: 'foundry-shared-workspace-development', apply: 'serve', configureServer(server) {
    const index = createNamespace(true); const workspaces = createNamespace(false, index);
    server.middlewares.use((incoming, outgoing, next) => {
      const path = incoming.url?.split('?')[0] ?? '';
      const plugin = /^\/figma\/workspaces\/([a-f0-9]{64})\/files\/([a-f0-9]{64})$/u.exec(path);
      const invite = /^\/figma\/workspaces\/([a-f0-9]{64})\/invites\/([a-f0-9]{64})$/u.exec(path);
      const pair = /^\/figma\/pairing\/([a-f0-9]{64})$/u.exec(path);
      if (!plugin && !invite && !pair && !path.startsWith('/git/workspaces')) { next(); return; }
      const host = incoming.headers.host ?? ''; const port = server.config.server.port ?? 5173;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(incoming.socket.remoteAddress ?? '') || !['localhost:' + port, '127.0.0.1:' + port].includes(host)) { outgoing.writeHead(403).end(); return; }
      const handle = async () => {
        const method = incoming.method ?? 'GET'; const headers = new Headers();
        for (const name of ['origin', 'content-type', 'authorization']) if (typeof incoming.headers[name] === 'string') headers.set(name, incoming.headers[name]);
        let text = ''; let bytes = 0;
        for await (const chunk of incoming) {
          if (!(chunk instanceof Buffer)) throw new Error('Invalid workspace request.');
          bytes += chunk.byteLength; if (bytes > 24 * 1024 * 1024) throw new HttpError(413, 'The workspace request exceeds the configured limit.');
          text += chunk.toString('utf8');
        }
        const origin = 'http://' + host;
        const request = new Request(origin + (incoming.url ?? path), { method, headers, ...(text ? { body: text } : {}) });
        return pair?.[1] ? pairingPoll(request, index, pair[1]) : invite ? workspaceInviteRedeem(request, workspaces, invite[1] ?? '', invite[2] ?? '', origin) :
          plugin ? workspacePlugin(request, workspaces, plugin[1] ?? '', plugin[2] ?? '') :
          workspaceBrowser(request, { EDITOR_ORIGIN: origin, WORKSPACES: workspaces, WORKSPACE_INDEX: index }, 'local-developer', () => Promise.resolve(true));
      };
      void handle().then(async response => {
        if (!response) { outgoing.writeHead(404).end(); return undefined; }
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
        return undefined;
      }).catch((error: unknown) => {
        outgoing.writeHead(error instanceof HttpError ? error.status : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: error instanceof Error ? error.message : 'The workspace request failed.' }));
      });
    });
  } };
}
