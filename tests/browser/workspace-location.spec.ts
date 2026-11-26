import { expect } from '@playwright/test';
import { test } from './runtime-test.ts';
import type { APIRequestContext, Page } from '@playwright/test';
import { isIdentity, isWorkspaceView } from '../../integrations/workspace/model.ts';
import { recoveryCopies } from './recovery-helpers.ts';

async function create(request: APIRequestContext, name: string, value: number) {
  const files = [{ path: 'tokens/base.tokens.json', text: JSON.stringify({ gap: { $type: 'number', $value: value } }) }];
  const result: unknown = await (await request.post('/git/workspaces', { headers: { Origin: 'http://127.0.0.1:4319' }, data: {
    client: crypto.randomUUID(), snapshot: { name, files, baseline: files },
  } })).json();
  if (!isWorkspaceView(result)) throw new Error('Workspace fixture unavailable.');
  return result;
}
async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Start shared workspace', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).toMatch(/^[a-f0-9]{64}$/u);
  const id = new URL(page.url()).searchParams.get('workspace'); if (!isIdentity(id)) throw new Error('Missing workspace address.');
  await expect.poll(async () => (await recoveryCopies(page)).find(copy => copy.shared?.id === id)?.id).toBeTruthy();
  return id;
}

test('a saved workspace gets a durable address and reloads its own recovery record without a dialog or duplicate', async ({ page }) => {
  const id = await start(page); const before = await recoveryCopies(page);
  const record = before.find(copy => copy.shared?.id === id); if (!record) throw new Error('Missing local record.');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('foundry-active-recovery'))).toBe(record.id);
  await page.reload();
  await expect(page.locator('[data-workspace-name]')).toHaveText(record.name);
  await expect(page.getByRole('dialog', { name: 'Recover local work', exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workspace storage' })).toContainText('Saved to workspace');
  expect(new URL(page.url()).searchParams.get('workspace')).toBe(id);
  const after = await recoveryCopies(page); expect(after.filter(copy => copy.shared?.id === id).map(copy => copy.id)).toEqual([record.id]);
});

test('a workspace address reload retains an unfinished local source form and its exact saved source', async ({ page }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  const id = await start(page);
  await page.getByRole('main', { name: 'Workspace management' }).getByRole('button', { name: 'reference.tokens.json', exact: true }).click();
  const source = page.getByRole('dialog', { name: 'Edit token source', exact: true }).getByRole('textbox', { name: 'Token source JSON', exact: true });
  await source.fill('{"unfinished":');
  await expect.poll(async () => (await recoveryCopies(page)).find(copy => copy.shared?.id === id)?.editor?.source?.text).toBe('{"unfinished":');
  const before = (await recoveryCopies(page)).find(copy => copy.shared?.id === id)?.files;
  await page.reload();
  const recovery = page.getByRole('dialog', { name: 'Recover local work', exact: true });
  await expect(recovery.getByRole('listitem')).toHaveCount(1);
  await recovery.getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await expect(source).toHaveValue('{"unfinished":');
  expect(new URL(page.url()).searchParams.get('workspace')).toBe(id);
  expect((await recoveryCopies(page)).find(copy => copy.shared?.id === id)?.files).toEqual(before);
});

test('a different workspace link opens its shared draft while retaining another workspace’s unfinished form privately', async ({ page, request }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  const original = await start(page);
  await page.getByRole('main', { name: 'Workspace management' }).getByRole('button', { name: 'reference.tokens.json', exact: true }).click();
  await page.getByRole('textbox', { name: 'Token source JSON', exact: true }).fill('{"private-form":');
  await expect.poll(async () => (await recoveryCopies(page)).find(copy => copy.shared?.id === original)?.editor?.source?.text).toBe('{"private-form":');
  const target = await create(request, 'Separate link ' + crypto.randomUUID(), 24);
  await page.goto('/?workspace=' + target.id);
  await expect(page.locator('[data-workspace-name]')).toHaveText(target.name);
  await expect(page.getByRole('dialog', { name: 'Recover local work', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Token source JSON', exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for gap', exact: true })).toHaveText('24');
  expect((await recoveryCopies(page)).find(copy => copy.shared?.id === original)?.editor?.source?.text).toBe('{"private-form":');
});

test('opening a delayed workspace hides example tokens and preserves navigation selected while loading', async ({ page, request }) => {
  const target = await create(request, 'Loading linked draft ' + crypto.randomUUID(), 16);
  let release: (() => void) | undefined; const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered: (() => void) | undefined; const loading = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/git/workspaces/' + target.id, async route => { entered?.(); await waiting; await route.continue(); });
  await page.goto('/?workspace=' + target.id); await loading;
  await expect(page.getByRole('main', { name: 'Opening workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Value for reference.space.small', exact: true })).toBeHidden();
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  release?.(); await expect(page.locator('[data-workspace-name]')).toHaveText(target.name);
  await expect(page.getByRole('button', { name: 'Value for gap', exact: true })).toHaveText('16');
  await expect(page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main', { name: 'Opening workspace', exact: true })).toBeHidden();
});

test('a delayed workspace link cannot replace a later workspace choice and local sources clear the old address', async ({ page, request }) => {
  const first = await create(request, 'Delayed link ' + crypto.randomUUID(), 8);
  const second = await create(request, 'Chosen link ' + crypto.randomUUID(), 16);
  let release: (() => void) | undefined; const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered: (() => void) | undefined; const loading = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/git/workspaces/' + first.id, async route => { entered?.(); await waiting; await route.continue(); });
  await page.goto('/?workspace=' + first.id); await loading;
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  const listing = page.getByRole('region', { name: 'Saved workspaces' });
  await listing.getByRole('searchbox', { name: 'Find workspace', exact: true }).fill(second.name);
  await listing.getByRole('button', { name: second.name }).click();
  await expect(page.locator('[data-workspace-name]')).toHaveText(second.name);
  await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).toBe(second.id);
  release?.();
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for gap', exact: true })).toHaveText('16');
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'local.tokens.json', mimeType: 'application/json', buffer: Buffer.from('{"local":{"$type":"number","$value":4}}') });
  await expect(page.getByRole('button', { name: 'Value for local', exact: true })).toHaveText('4');
  expect(new URL(page.url()).searchParams.get('workspace')).toBeNull();
});
