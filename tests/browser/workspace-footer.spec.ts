import { mkdir, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { test } from './runtime-test.ts';

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
  await tableFooter.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select row Name for space.small', exact: true }).check();
  await expect(tableFooter).toContainText('1 selected');
  const footer = await page.locator('.workspace-footer').boundingBox();
  const identity = await page.locator('.workspace-footer-identity').boundingBox();
  expect(footer && identity && identity.x > footer.x + footer.width / 2).toBeTruthy();
  await expect(page.locator('[data-workspace-status=connection] .workspace-status-light')).toHaveAttribute('data-status', 'bad');
  await expect(page.locator('[data-workspace-status=sync] .workspace-status-light')).toHaveAttribute('data-status', 'good');
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
  await expect(page.locator('[data-workspace-status=sync]')).toBeVisible();
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
  const connection = page.locator('[data-workspace-status=connection]');
  const sync = page.locator('[data-workspace-status=sync]');
  await expect(connection.locator('.workspace-status-light')).toHaveAttribute('data-status', 'good');
  await expect(sync).toContainText('Saved to workspace');
  await expect(sync.locator('.workspace-status-light')).toHaveAttribute('data-status', 'good');
  await context.setOffline(true);
  await expect(connection).toContainText('Offline');
  await expect(connection.locator('.workspace-status-light')).toHaveAttribute('data-status', 'bad');
  await expect(sync).toContainText('Workspace sync unavailable');
  await expect(sync.locator('.workspace-status-light')).toHaveAttribute('data-status', 'bad');
  await context.setOffline(false);
  await expect(connection.locator('.workspace-status-light')).toHaveAttribute('data-status', 'good');
  await expect(sync.locator('.workspace-status-light')).toHaveAttribute('data-status', 'good');
});
