import { expect } from '@playwright/test';
import { test } from './runtime-test.ts';
import type { APIRequestContext, Page } from '@playwright/test';
import { isIdentity, isWorkspaceView } from '../../integrations/workspace/model.ts';
import { editSource, recoveryCopies } from './recovery-helpers.ts';
import { readFile } from 'node:fs/promises';
import { readRecoveryExport } from '../../editor/lib/recovery.ts';

async function create(request: APIRequestContext, name: string, value: number) {
  const files = [{ path: 'tokens/base.tokens.json', text: JSON.stringify({ gap: { $type: 'number', $value: value } }) }];
  const result: unknown = await (await request.post('/git/workspaces', { headers: { Origin: 'http://127.0.0.1:4319' }, data: {
    client: crypto.randomUUID(), snapshot: { name, files, baseline: files },
  } })).json();
  if (!isWorkspaceView(result)) throw new Error('Workspace fixture unavailable.');
  return result;
}

async function start(page: Page) {
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Start shared workspace', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).toMatch(/^[a-f0-9]{64}$/u);
  const id = new URL(page.url()).searchParams.get('workspace');
  if (!isIdentity(id)) throw new Error('Missing workspace address.');
  return id;
}

test('browser navigation and Back/Forward move cleanly between Foundry views without leaving the app', async ({ page, request }) => {
  const target = await create(request, 'Route nav ' + crypto.randomUUID(), 16);
  await page.goto('/?workspace=' + target.id);
  await expect(page.locator('[data-workspace-name]')).toHaveText(target.name);
  expect(new URL(page.url()).pathname).toBe('/');

  const nav = page.getByRole('navigation', { name: 'Foundry' });
  await nav.getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Workspace management', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/workspace');

  await nav.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Changes', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/changes');

  await page.reload();
  await expect(page.getByRole('main', { name: 'Changes', exact: true })).toBeVisible();
  await expect(page.locator('[data-workspace-name]')).toHaveText(target.name);
  expect(new URL(page.url()).pathname).toBe('/changes');
  expect(new URL(page.url()).searchParams.get('workspace')).toBe(target.id);

  await nav.getByRole('button', { name: 'Figma', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Figma', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/figma');

  await nav.getByRole('button', { name: 'Variants', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Variants', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/variants');

  await page.goBack();
  await expect(page.getByRole('main', { name: 'Figma', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/figma');

  await page.goBack();
  await expect(page.getByRole('main', { name: 'Changes', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/changes');

  await page.goBack();
  await expect(page.getByRole('main', { name: 'Workspace management', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/workspace');

  await page.goBack();
  await expect(page.getByRole('button', { name: 'Value for gap', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');

  await page.goForward();
  await expect(page.getByRole('main', { name: 'Workspace management', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/workspace');
});

test('Changes labels patch exports honestly and discards draft changes back to baseline', async ({ page }) => {
  await page.goto('/');
  await editSource(page, 8, 12);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();

  const changesMain = page.getByRole('main', { name: 'Changes', exact: true });
  await expect(changesMain).toContainText('No repository or folder is connected.');
  await expect(changesMain.getByRole('button', { name: 'Review and export patch', exact: true })).toBeEnabled();
  await expect(changesMain).toContainText('reference.tokens.json');

  await changesMain.getByRole('button', { name: 'Discard changes', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard changes', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(changesMain).toContainText('No source changes');
  await expect(changesMain.getByRole('button', { name: 'Discard changes', exact: true })).toBeDisabled();

  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for reference.space.small', exact: true })).toHaveText('8 px');
});

test('workspaces can be deleted from the switcher and from Workspace management', async ({ page, request }) => {
  await page.goto('/');
  const firstId = await start(page);
  await expect.poll(async () => (await recoveryCopies(page)).some(copy => copy.shared?.id === firstId)).toBe(true);

  const extra = await create(request, 'Disposable draft ' + crypto.randomUUID(), 20);

  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Open workspace', exact: true });
  await picker.getByRole('searchbox', { name: 'Find workspace', exact: true }).fill(extra.name);
  await picker.locator('li', { hasText: extra.name }).getByRole('button', { name: 'Delete workspace', exact: true }).click();
  const confirmListDelete = picker.getByRole('region', { name: 'Confirm workspace deletion', exact: true });
  await expect(confirmListDelete).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Delete workspace', exact: true })).toHaveCount(0);
  await expect(confirmListDelete.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmListDelete.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await expect(confirmListDelete).toBeHidden();
  await expect(picker.getByRole('button', { name: extra.name })).toHaveCount(0);
  expect((await request.get('/git/workspaces/' + extra.id)).status()).toBe(404);
  await picker.getByRole('button', { name: 'Close', exact: true }).click();

  const storageCard = page.getByRole('region', { name: 'Workspace storage', exact: true });
  await storageCard.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  const confirmActiveDelete = storageCard.getByRole('region', { name: 'Confirm workspace deletion', exact: true });
  await expect(page.getByRole('dialog', { name: 'Delete workspace', exact: true })).toHaveCount(0);
  await confirmActiveDelete.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await expect(confirmActiveDelete).toBeHidden();

  await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).toBeNull();
  await expect(storageCard).toContainText('Stored in this browser');
  expect((await request.get('/git/workspaces/' + firstId)).status()).toBe(404);
  await expect.poll(async () => (await recoveryCopies(page)).some(copy => copy.shared?.id === firstId)).toBe(false);
});

test('Changes supports reverting individual tokens and discarding individual source files', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    {
      name: 'ref.tokens.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        space: {
          small: { $type: 'dimension', $value: { value: 8, unit: 'px' } },
          medium: { $type: 'dimension', $value: { value: 16, unit: 'px' } },
        },
      })),
    },
    {
      name: 'sys.tokens.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        card: {
          padding: { $type: 'dimension', $value: { value: 12, unit: 'px' } },
        },
      })),
    },
  ]);

  const editDimension = async (tokenPath: string, nextValue: string) => {
    await page.getByRole('button', { name: `Value for ${tokenPath}`, exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: 'Token value', exact: true });
    await expect(input).toBeVisible();
    await input.fill(nextValue);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: `Value for ${tokenPath}`, exact: true })).toHaveText(nextValue);
  };

  await editDimension('space.small', '10 px');
  await editDimension('space.medium', '20 px');
  await editDimension('card.padding', '18 px');

  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
  const changedTokens = page.getByRole('region', { name: 'Changed tokens', exact: true });
  const draftFiles = page.getByRole('region', { name: 'Draft changes', exact: true });

  await expect(changedTokens.getByRole('button', { name: 'Revert space.small', exact: true })).toBeVisible();
  await expect(changedTokens.getByRole('button', { name: 'Revert space.medium', exact: true })).toBeVisible();
  await expect(changedTokens.getByRole('button', { name: 'Revert card.padding', exact: true })).toBeVisible();

  await changedTokens.getByRole('button', { name: 'Revert space.small', exact: true }).click();
  await expect(changedTokens.getByRole('button', { name: 'Revert space.small', exact: true })).toHaveCount(0);
  await expect(changedTokens.getByRole('button', { name: 'Revert space.medium', exact: true })).toBeVisible();
  await expect(draftFiles).toContainText('ref.tokens.json');
  await expect(draftFiles).toContainText('sys.tokens.json');

  await draftFiles.getByRole('button', { name: 'Discard changes to ref.tokens.json', exact: true }).click();
  await expect(draftFiles).not.toContainText('ref.tokens.json');
  await expect(draftFiles).toContainText('sys.tokens.json');
  await expect(changedTokens.getByRole('button', { name: 'Revert space.medium', exact: true })).toHaveCount(0);
  await expect(changedTokens.getByRole('button', { name: 'Revert card.padding', exact: true })).toBeVisible();

  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for space.small', exact: true })).toHaveText('8 px');
  await expect(page.getByRole('button', { name: 'Value for space.medium', exact: true })).toHaveText('16 px');
  await expect(page.getByRole('button', { name: 'Value for card.padding', exact: true })).toHaveText('18 px');

  await page.getByRole('button', { name: 'Value for card.padding', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByRole('button', { name: 'Value for space.medium', exact: true })).toHaveText('20 px');
});

test('Recover local work downloads, confirms deletion with snackbar retry, and clears remaining drafts', async ({ page }) => {
  await page.goto('/');
  await editSource(page, 8, 12);
  await expect.poll(async () => (await recoveryCopies(page)).length).toBe(1);

  const addDraft = async (next: number) => {
    await page.evaluate(() => sessionStorage.removeItem('foundry-active-recovery'));
    await page.reload();
    const startupDialog = page.getByRole('dialog', { name: 'Recover local work', exact: true });
    await expect(startupDialog).toBeVisible();
    await startupDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(startupDialog).toBeHidden();
    await editSource(page, 8, next);
  };
  await addDraft(14);
  await addDraft(16);
  await expect.poll(async () => (await recoveryCopies(page)).length).toBe(3);

  await page.getByRole('banner').getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Recover local work…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Recover local work', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('listitem')).toHaveCount(3);

  const card = dialog.getByRole('listitem').first();
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = readRecoveryExport(await readFile(await (await download).path(), 'utf8'));
  expect((await recoveryCopies(page)).find(record => record.id === exported.id)).toEqual(exported);
  const deleteButton = card.getByRole('button', { name: 'Delete', exact: true });
  await deleteButton.click();
  await expect(card).toContainText('Delete this recovery copy?');
  await expect(card.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(deleteButton).toBeFocused();
  expect((await recoveryCopies(page)).length).toBe(3);
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'delete');
    if (!original) throw new Error('Recovery storage is unavailable.');
    Object.defineProperty(IDBObjectStore.prototype, 'delete', { ...original, value: () => {
      Object.defineProperty(IDBObjectStore.prototype, 'delete', original);
      throw new Error('Try deleting this recovery copy again.');
    } });
  });
  await deleteButton.click();
  await deleteButton.click();
  const snackbar = dialog.getByRole('status').filter({ hasText: 'Try deleting this recovery copy again.' });
  await expect(snackbar).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect((await recoveryCopies(page)).length).toBe(3);
  await snackbar.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await expect(snackbar).toBeHidden();
  await expect(card).toContainText('Delete this recovery copy?');
  await deleteButton.click();
  await expect(dialog.getByRole('listitem')).toHaveCount(2);
  await expect(dialog.getByRole('button', { name: 'Open', exact: true })).toBeFocused();
  await expect.poll(async () => (await recoveryCopies(page)).length).toBe(2);

  await dialog.getByRole('button', { name: 'Clear all', exact: true }).click();
  const confirm = dialog.getByRole('region', { name: 'Confirm clearing local work', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Clear all local work', exact: true }).click();
  await expect(dialog.getByRole('listitem')).toHaveCount(0);
  await expect(dialog.getByText('No saved source edits in this browser.', { exact: true })).toBeVisible();
  await expect.poll(async () => (await recoveryCopies(page)).length).toBe(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toBeHidden();

});
