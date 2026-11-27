import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { test } from './runtime-test.ts';

test('nested group selection follows the chosen path in the sidebar and reference picker', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'nested.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ md: { comp: { 'app-bar': { 'on-scroll': { value: { $type: 'number', $value: 1 } }, search: { value: { $type: 'number', $value: 2 } } } } } })),
  });
  async function select(path: string, scope: Page | Locator = page) {
    const item = scope.locator('[data-group-path="' + path + '"]');
    await item.click();
    await expect(item).toHaveAttribute('aria-current', 'page');
    const expand = scope.getByRole('button', { name: 'Expand ' + path, exact: true });
    if (await expand.count()) await expand.click();
  }
  await select('md');
  await select('md.comp');
  await select('md.comp.app-bar');
  await expect(page.locator('[data-group-path="md.comp"]')).not.toHaveAttribute('aria-current', 'page');
  await select('md.comp.app-bar.on-scroll');
  await expect(page.getByRole('button', { name: 'Name for md.comp.app-bar.on-scroll.value', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Name for md.comp.app-bar.search.value', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Name for md.comp.app-bar.on-scroll.value', exact: true }).click();
  await page.getByRole('button', { name: 'Link reference for md.comp.app-bar.on-scroll.value', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Link a token', exact: true });
  await select('md', picker);
  await select('md.comp', picker);
  await select('md.comp.app-bar', picker);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
});
