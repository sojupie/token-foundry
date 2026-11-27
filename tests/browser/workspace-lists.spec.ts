import { mkdir } from 'node:fs/promises';
import { expect } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
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

test('saved workspaces use segmented rows, page position and counts through filtering', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const region = await listing(page);
  await expect(region.locator('.md-list')).toHaveAttribute('data-variant', 'segmented');
  expect(await region.locator('.md-list').evaluate(element => parseFloat(getComputedStyle(element).rowGap))).toBeGreaterThan(0);
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
  await mkdir('tmp/workspace-list', { recursive: true });
  await region.screenshot({ path: `tmp/workspace-list/${info.project.name}-saved-workspaces.png` });
});

test('workspace deletion stays in its item, preserves focus on cancel, and retains retry after failure', async ({ page }, info) => {
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
  await expect(picker.locator('.md-list')).toHaveAttribute('data-variant', 'segmented');
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
  await expect(notice).toHaveClass(/md-snackbar/u);
  await expect(confirm.getByRole('alert')).toHaveCount(0);
  await expect(confirm.getByRole('button', { name: 'Delete workspace', exact: true })).toBeEnabled();
  await mkdir('tmp/workspace-list', { recursive: true });
  await page.screenshot({ path: `tmp/workspace-list/${info.project.name}-delete-in-item.png` });
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

async function alongsideIcon(scope: Page | Locator, path: string) {
  const row = scope.locator(`[data-group-path="${path}"]`);
  const icon = await row.locator('.md-list-leading').boundingBox();
  const label = await row.locator('.md-list-label').boundingBox();
  expect(icon && label).toBeTruthy();
  if (!icon || !label) throw new Error('Group icon or label is missing');
  expect(label.x).toBeGreaterThanOrEqual(icon.x + icon.width);
  expect(Math.abs(label.y + label.height / 2 - icon.y - icon.height / 2)).toBeLessThan(1);
}

async function expand(scope: Page | Locator, path: string) {
  await expect(scope.locator(`[data-group-path="${path}"]`)).toBeVisible();
  const control = scope.getByRole('button', { name: 'Expand ' + path, exact: true });
  if (await control.count()) await control.click();
}

test('deep group labels stay beside their icons in the sidebar and reference picker', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const group = 'root.section.deep.a-very-long-group-label';
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'nested.tokens.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    root: { section: { deep: { 'a-very-long-group-label': { branch: { a: { $type: 'number', $value: 1 }, b: { $type: 'number', $value: 2 } } } } } },
  })) });
  await expand(page, 'root');
  await expand(page, 'root.section');
  await expand(page, 'root.section.deep');
  await alongsideIcon(page, group);
  await page.locator(`[data-group-path="${group}"]`).click();
  await page.getByRole('button', { name: `Name for ${group}.branch.a`, exact: true }).click();
  await page.getByRole('button', { name: `Link reference for ${group}.branch.a`, exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Link a token', exact: true });
  await expand(picker, 'root');
  await expand(picker, 'root.section');
  await expand(picker, 'root.section.deep');
  await alongsideIcon(picker, group);
  await mkdir('tmp/workspace-list', { recursive: true });
  await picker.screenshot({ path: `tmp/workspace-list/${info.project.name}-group-labels.png` });
});
