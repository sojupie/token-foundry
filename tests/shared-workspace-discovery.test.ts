import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digest, WorkspaceRegistry } from '../worker/workspace.ts';
import type { WorkspaceNamespace } from '../worker/workspace.ts';
import { workspaceBrowser } from '../worker/workspace-routes.ts';
import { HttpError } from '../worker/http.ts';
import { isRecord } from '../lib/json.ts';

await test('an owner-only legacy index migrates accessible repository drafts without exposing personal drafts or repeating idle writes', async () => {
  const registries = new Map<string, WorkspaceRegistry>(); let writes = 0;
  const registry: WorkspaceNamespace = { idFromName: name => name, get: name => {
    if (typeof name !== 'string') throw new Error('Invalid registry name.');
    let instance = registries.get(name);
    if (!instance) {
      const values = new Map<string, unknown>(); let sequence = Promise.resolve();
      instance = new WorkspaceRegistry({ storage: { get: key => Promise.resolve(structuredClone(values.get(key))), put: (key, value) => { writes++; values.set(key, structuredClone(value)); return Promise.resolve(); } },
        blockConcurrencyWhile: <T>(action: () => Promise<T>) => { const next = sequence.then(action); sequence = next.then(() => undefined, () => undefined); return next; } });
      registries.set(name, instance);
    }
    return instance;
  } };
  const owner = registry.get(registry.idFromName('owner:' + await digest('owner')));
  const privateEntry = { id: 'b'.repeat(64), name: 'Personal experiment', version: 1 };
  const sharedEntry = { id: 'a'.repeat(64), name: 'Legacy repository draft', repository: 'org/tokens', version: 1 };
  const seed = (entry: object) => owner.fetch(new Request('https://index/', { method: 'POST', headers: { 'X-Foundry-Subject': 'owner' }, body: JSON.stringify(entry) }));
  await seed(privateEntry); await seed(sharedEntry);
  const origin = 'https://sevan.tokenfoundry.lindstruct.com';
  const config = { EDITOR_ORIGIN: origin, WORKSPACE_INDEX: registry, WORKSPACES: registry, GIT_PROJECTS: '{"org/tokens":"tokens"}' };
  const list = (subject: string, allowed = true) => workspaceBrowser(new Request(origin + '/git/workspaces'), config, subject, () => Promise.resolve(allowed));
  const migrated: unknown = await (await list('owner'))?.json(); assert(isRecord(migrated));
  assert.equal(JSON.stringify(migrated).includes(privateEntry.name), true); assert.equal(JSON.stringify(migrated).includes(sharedEntry.name), true);
  const afterMigration = writes;
  const peer: unknown = await (await list('writer'))?.json(); assert(isRecord(peer));
  assert.equal(JSON.stringify(peer).includes(sharedEntry.name), true); assert.equal(JSON.stringify(peer).includes(privateEntry.name), false);
  await list('owner'); assert.equal(writes, afterMigration, 'Discovery backfills missing metadata once, then remains read-only.');
  const denied: unknown = await (await list('owner', false))?.json(); assert(isRecord(denied));
  assert.equal(JSON.stringify(denied).includes(sharedEntry.name), false); assert.equal(JSON.stringify(denied).includes(privateEntry.name), true);
  const offline: unknown = await (await workspaceBrowser(new Request(origin + '/git/workspaces'), config, 'owner', () => { throw new HttpError(503, 'GitHub unavailable.'); }))?.json();
  assert(isRecord(offline)); assert.equal(offline['repositoryDiscovery'], 'partial'); assert.equal(JSON.stringify(offline).includes(privateEntry.name), true); assert.equal(JSON.stringify(offline).includes(sharedEntry.name), false);
});
