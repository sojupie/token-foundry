import { mkdir, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './runtime-test.ts';
import { isRecord } from '../../lib/json.ts';

async function edit(page: Page, path: string, value: string) {
  await page.getByRole('button', { name: `Value for ${path}`, exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'Token value', exact: true }).fill(value);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: `Value for ${path}`, exact: true })).toHaveText(value);
}

test('changes badge counts authored tokens across files and reverts; footers and review content remain usable', async ({ page }, info) => {
  await mkdir('tmp/ui-footer', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'reference.tokens.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ space: { $type: 'dimension', small: { $value: { value: 8, unit: 'px' } }, medium: { $value: { value: 16, unit: 'px' } } } }, null, 2)) },
    { name: 'system.tokens.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ relative: { $type: 'dimension', $value: { value: 1.25, unit: 'rem' } }, smallAlias: { $type: 'dimension', $value: '{space.small}' }, mediumAlias: { $type: 'dimension', $value: '{space.medium}' } }, null, 2)) },
  ]);
  await edit(page, 'space.small', '5 px');
  await edit(page, 'space.medium', '1 px');
  await edit(page, 'relative', '1.2 rem');
  const changes = page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true });
  await expect(changes.locator('.md-badge')).toHaveText('3');
  const reviewButton = page.getByRole('banner').getByRole('button', { name: 'Review changes', exact: true });
  await expect(reviewButton).toHaveAttribute('data-size', 'xsmall');
  await expect(reviewButton).toHaveAttribute('data-color', 'tertiary');
  const tableFooter = page.locator('#token-library > .workspace-table-footer');
  await expect(tableFooter).toContainText('5 tokens');
  await expect(tableFooter).toContainText('Unsaved changes');
  const selectedFooter = await tableFooter.boundingBox();
  await tableFooter.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(tableFooter.getByRole('button', { name: 'Clear selection', exact: true })).toHaveCount(0);
  expect(await tableFooter.boundingBox()).toEqual(selectedFooter);
  await page.getByRole('checkbox', { name: 'Select row Name for space.small', exact: true }).check();
  await expect(tableFooter).toContainText('1 selected');
  expect(await tableFooter.boundingBox()).toEqual(selectedFooter);
  const footer = await page.locator('.workspace-footer').boundingBox();
  const identity = await page.locator('.workspace-footer-identity').boundingBox();
  expect(footer && identity && identity.x > footer.x + footer.width / 2).toBeTruthy();
  await expect(page.locator('[data-service=workspace] .workspace-status-light')).toHaveAttribute('data-status', 'bad');
  await expect(page.locator('[data-service=local] .workspace-status-light')).toHaveAttribute('data-status', 'good');
  await page.screenshot({ path: `tmp/ui-footer/${info.project.name}-tokens.png` });
  await tableFooter.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(tableFooter).not.toContainText('1 selected');
  await changes.click();
  await expect(page.getByRole('heading', { name: '3 changed tokens', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '2 changed source files', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Changed tokens', exact: true }).locator('.md-list')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Draft changes', exact: true }).locator('.md-list')).toHaveCount(0);
  async function captureTheme(theme: string) {
    const toggle = page.getByRole('button', { name: `Switch to ${theme} mode`, exact: true });
    if (await toggle.count()) await toggle.click();
    await expect(reviewButton).toBeEnabled();
    await page.screenshot({ path: `tmp/ui-footer/${info.project.name}-changes-${theme}.png`, animations: 'disabled' });
    const colors = await reviewButton.evaluate(element => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor, opacity: style.opacity };
    });
    await writeFile(`tmp/ui-footer/${info.project.name}-button-${theme}.json`, JSON.stringify(colors));
  }
  await captureTheme('light');
  await captureTheme('dark');
  await reviewButton.click();
  await expect(page.getByRole('main', { name: 'Changes', exact: true })).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Review changes', exact: true })).toHaveCount(0);
  await page.getByRole('main', { name: 'Changes', exact: true }).getByRole('button', { name: 'Review and export patch', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review changes', exact: true });
  await review.getByText('Resolved value changes (5)', { exact: true }).click();
  await review.getByText('Show file changes', { exact: true }).click();
  await expect(review.locator('.md-list')).toHaveCount(0);
  await expect(review.getByRole('region', { name: 'File changes', exact: true })).toHaveCSS('border-radius', '0px');
  await page.screenshot({ path: `tmp/ui-footer/${info.project.name}-review.png` });
  await page.keyboard.press('Escape');
  async function revert(path: string, remaining: number) {
    await page.getByRole('button', { name: `Revert ${path}`, exact: true }).click();
    if (remaining) await expect(changes.locator('.md-badge')).toHaveText(String(remaining));
    else await expect(changes.locator('.md-badge')).toHaveCount(0);
  }
  await revert('space.small', 2);
  await revert('space.medium', 1);
  await revert('relative', 0);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tableFooter).toBeVisible();
  const mobileFooter = await tableFooter.boundingBox();
  await page.getByRole('checkbox', { name: 'Select row Name for space.small', exact: true }).check();
  await expect(tableFooter).toContainText('1 selected');
  expect(await tableFooter.boundingBox()).toEqual(mobileFooter);
  await tableFooter.getByRole('button', { name: 'Clear selection', exact: true }).click();
  expect(await tableFooter.boundingBox()).toEqual(mobileFooter);
  await expect(page.locator('[data-service=workspace]')).toBeVisible();
  await expect.poll(() => page.locator('.md-snackbar:popover-open').evaluate(element => {
    const snack = element.getBoundingClientRect();
    return [...document.querySelectorAll('[data-snackbar-avoid]')].every(region => snack.bottom <= region.getBoundingClientRect().top);
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `tmp/ui-footer/${info.project.name}-mobile.png` });
});

test('workspace connection and sync indicators follow actual offline and reconnect states', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Start shared workspace', exact: true }).click();
  const connection = page.locator('[data-service=workspace]');
  const sync = page.locator('[data-service=workspace]');
  await expect(connection.locator('.workspace-status-light')).toHaveAttribute('data-status', 'good');
  await expect(sync).toContainText('Saved to workspace');
  await expect(sync.locator('.workspace-status-light')).toHaveAttribute('data-status', 'good');
  await context.setOffline(true);
  await expect(connection).toContainText('Offline');
  await expect(connection.locator('.workspace-status-light')).toHaveAttribute('data-status', 'bad');
  await expect(page.locator('.workspace-save-state')).toContainText('Workspace sync unavailable');
  await expect(sync.locator('.workspace-status-light')).toHaveAttribute('data-status', 'bad');
  await context.setOffline(false);
  await expect(connection.locator('.workspace-status-light')).toHaveAttribute('data-status', 'good');
  await expect(sync.locator('.workspace-status-light')).toHaveAttribute('data-status', 'good');
});

test('GitHub account state is shared with its footer and remains separate from a saved workspace', async ({ page }) => {
  let signedIn = true;
  let checks = 0;
  await page.route('**/git/session', route => {
    checks++;
    return signedIn ? route.fulfill({ json: { login: 'designer', repositories: ['example/tokens'] } }) : route.fulfill({ status: 401, json: {} });
  });
  await page.goto('/');
  const github = page.locator('[data-service=github]');
  await expect(github).toHaveAttribute('data-connection-status', 'good');
  const initialChecks = checks;
  await expect(github).toHaveAttribute('title', 'GitHub\nChoose a repository');
  await expect(github.locator('svg')).toHaveCount(1);
  await expect(github.locator('.workspace-status-light')).toHaveAttribute('data-status', 'pending');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'GitHub', exact: true })).toContainText('Connected as @designer');
  expect(checks).toBe(initialChecks);
  await page.getByRole('button', { name: 'Start shared workspace', exact: true }).click();
  await expect(page.locator('[data-service=workspace]')).toContainText('Saved to workspace');
  signedIn = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(github).toHaveAttribute('title', 'GitHub\nSign in to connect');
  await expect(github.locator('.workspace-status-light')).toHaveAttribute('data-status', 'bad');
  await expect(page.locator('[data-service=workspace] .workspace-status-light')).toHaveAttribute('data-status', 'good');
  signedIn = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(github).toHaveAttribute('data-connection-status', 'good');
});

test('Figma footer follows real pairing, acknowledged revision, and single-device revocation', async ({ page, request, context }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Start shared workspace', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('workspace')).toBeTruthy();
  const id = new URL(page.url()).searchParams.get('workspace');
  if (!id) throw new Error('Missing shared workspace');
  const paired: unknown = await (await request.post(`/git/workspaces/${id}/documents`, { headers: { Origin: 'http://127.0.0.1:4319' }, data: { document: 'footer-library', name: 'Footer library', role: 'library' } })).json();
  if (!isRecord(paired) || typeof paired['connection'] !== 'string') throw new Error('Missing Figma connection');
  const connection = new URL(paired['connection']);
  const headers = { Authorization: 'Bearer ' + connection.hash.slice(1) }; connection.hash = '';
  const snapshot: unknown = await (await request.get(connection.href, { headers })).json();
  if (!isRecord(snapshot) || typeof snapshot['revision'] !== 'string') throw new Error('Missing Figma source revision');
  const figma = page.locator('[data-service=figma]');
  await expect(figma).toHaveAttribute('data-connection-status', 'good');
  await expect(figma.locator('.workspace-status-light')).toHaveAttribute('data-status', 'pending');
  await expect(figma).toHaveAttribute('title', 'Figma\nWaiting for updates');
  await expect(figma.locator('svg')).toHaveCount(1);
  expect((await request.post(connection.href, { headers, data: { action: 'acknowledge', revision: snapshot['revision'] } })).ok()).toBe(true);
  await expect(figma.locator('.workspace-status-light')).toHaveAttribute('data-status', 'good');
  await page.screenshot({ path: 'tmp/footer-services/figma-synced.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'tmp/footer-services/mobile-services.png', animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.setOffline(true);
  await expect(figma).toHaveAttribute('data-connection-status', 'pending');
  await expect(figma.locator('.workspace-status-light')).toHaveAttribute('data-status', 'bad');
  await expect(figma).toContainText("Can't check while offline");
  await context.setOffline(false);
  await expect(figma.locator('.workspace-status-light')).toHaveAttribute('data-status', 'good');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Figma', exact: true }).click();
  await page.getByText('Manage connections (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Revoke connection', exact: true }).click();
  await expect(figma).toHaveAttribute('title', 'Figma\nReconnect to sync');
  await expect(figma.locator('.workspace-status-light')).toHaveAttribute('data-status', 'bad');
});
