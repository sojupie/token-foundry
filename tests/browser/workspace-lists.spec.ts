import { expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { test } from './runtime-test.ts';

async function listing(page: Page) {
  const entries = Array.from({ length: 13 }, (_, index) => ({ id: (index + 1).toString(16).padStart(64, '0'), name: `Workspace ${index + 1}` }));
  await page.route('**/git/workspaces?refresh=*', route => route.fulfill({ json: { workspaces: entries } }));
  await page.goto('/#pair=' + 'a'.repeat(64) + '&secret=' + 'b'.repeat(64) + '&document=workspace-list&name=Library');
  const region = page.getByRole('region', { name: 'Saved workspaces', exact: true });
  await expect(region).toHaveAttribute('aria-busy', 'false');
  return region;
}

test('global Review changes opens Changes without opening a save dialog or submitting', async ({ page }) => {
  let writes = 0;
  await page.route('**/git/propose', route => { writes++; return route.fulfill({ status: 500, json: {} }); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Value for reference.space.small', exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'Token value', exact: true }).fill('9 px');
  await page.keyboard.press('Enter');
  const banner = page.getByRole('banner');
  await banner.getByRole('button', { name: 'Review changes', exact: true }).click();
  const changes = page.getByRole('main', { name: 'Changes', exact: true });
  await expect(changes).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(changes).toContainText('1 changed token');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await banner.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Review changes', exact: true }).click();
  await expect(changes).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toBe(0);
});

test('saved workspace pagination tracks page position and counts through filtering', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const region = await listing(page);
  await expect(region.locator('.workspace-list-footer')).toContainText('1–6 of 13 workspaces');
  await expect(region.getByRole('navigation', { name: 'Workspace pages' })).toContainText('Page 1 of 3');
  await expect(region.getByRole('button', { name: 'Previous workspaces', exact: true })).toBeDisabled();
  await region.getByRole('button', { name: 'Next workspaces', exact: true }).click();
  await expect(region.locator('.workspace-list-footer')).toContainText('7–12 of 13 workspaces');
  await region.getByRole('button', { name: 'Next workspaces', exact: true }).click();
  await expect(region.locator('.workspace-list-footer')).toContainText('13–13 of 13 workspaces');
  await expect(region.getByRole('navigation', { name: 'Workspace pages' })).toContainText('Page 3 of 3');
  await expect(region.getByRole('button', { name: 'Next workspaces', exact: true })).toBeDisabled();
  const search = region.getByRole('searchbox', { name: 'Find workspace', exact: true });
  await search.fill('Workspace 1');
  await expect(region.locator('.workspace-list-footer')).toHaveText('1–5 of 5 workspaces');
  await expect(region.getByRole('navigation', { name: 'Workspace pages' })).toHaveCount(0);
  await search.fill('missing');
  await expect(region.locator('.workspace-list-footer')).toHaveText('0 workspaces');
  await search.clear();
  await expect(region.getByRole('navigation', { name: 'Workspace pages' })).toContainText('Page 1 of 3');

});

test('workspace deletion stays in its item, preserves focus on cancel, and retains retry after failure', async ({ page }) => {
  await listing(page);
  let deletes = 0;
  let held: Route | undefined;
  await page.route('**/git/workspaces/*', route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    deletes++;
    if (deletes === 1) { held = route; return undefined; }
    return route.fulfill({ json: { deleted: true } });
  });
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Open workspace', exact: true, includeHidden: true });
  await picker.getByRole('button', { name: 'Next workspaces', exact: true }).click();
  await picker.getByRole('button', { name: 'Next workspaces', exact: true }).click();
  const remove = picker.locator('li', { hasText: 'Workspace 13' }).getByRole('button', { name: 'Delete workspace', exact: true });
  await remove.click();
  const confirm = picker.getByRole('region', { name: 'Confirm workspace deletion', exact: true });
  await expect(page.getByRole('dialog', { name: 'Delete workspace', exact: true })).toHaveCount(0);
  await expect(confirm.locator('xpath=ancestor::li')).toContainText('Workspace 13');
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(remove).toBeFocused();
  expect(deletes).toBe(0);
  await remove.click();
  await confirm.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await expect.poll(() => !!held).toBe(true);
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeVisible();
  await held?.fulfill({ status: 503, json: { message: 'Please retry deleting this workspace.' } });
  const notice = page.getByRole('status').filter({ hasText: 'Please retry deleting this workspace.' });
  await expect(notice).toBeVisible();
  await expect(confirm.getByRole('alert')).toHaveCount(0);
  await expect(confirm.getByRole('button', { name: 'Delete workspace', exact: true })).toBeEnabled();

  await notice.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await expect(notice).toBeHidden();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(picker).toBeVisible();
  await expect(picker.locator('.workspace-list-footer')).toContainText('7–12 of 12 workspaces');
  await expect(picker.getByRole('navigation', { name: 'Workspace pages' })).toContainText('Page 2 of 2');
  await expect(picker.getByRole('searchbox', { name: 'Find workspace', exact: true })).toBeFocused();
  expect(deletes).toBe(2);
});
