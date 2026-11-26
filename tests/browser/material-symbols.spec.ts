import { mkdir } from 'node:fs/promises';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { test } from './runtime-test.ts';

async function selectedSurface(item: Locator) {
  const expected = await item.evaluate(element => {
    const sample = document.createElement('span');
    sample.style.backgroundColor = 'color-mix(in srgb, var(--_list-item-container) 100%, transparent)';
    element.append(sample); const color = getComputedStyle(sample).backgroundColor; sample.remove(); return color;
  });
  await expect(item).toHaveCSS('background-color', expected);
}

test('Material rail icons fill on selection, use secondary, and return to default on press without undershoot', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: 'Foundry', exact: true });
  const tokens = rail.getByRole('button', { name: 'Tokens', exact: true });
  const glyph = tokens.locator('.md-nav-icon > svg');
  await expect(glyph).toHaveAttribute('data-material-symbol', 'layers');
  await expect(glyph.locator('[data-symbol-variant=filled]')).toHaveCSS('display', 'inline');
  await expect(glyph.locator('[data-symbol-variant=outlined]')).toHaveCSS('display', 'none');
  const secondary = await page.evaluate(() => {
    const sample = document.createElement('span'); sample.style.color = 'var(--md-sys-color-secondary)';
    document.body.append(sample); const color = getComputedStyle(sample).color; sample.remove(); return color;
  });
  await expect(glyph).toHaveCSS('color', secondary);
  await expect(glyph).toHaveCSS('width', '24px');
  await tokens.hover();
  await mkdir('tmp/material-symbols', { recursive: true });
  await page.screenshot({ path: `tmp/material-symbols/${info.project.name}-rail-transition.png`, animations: 'allow' });
  await expect(glyph).toHaveCSS('width', '26px');
  await expect(glyph).toHaveCSS('stroke-width', '16px');
  await expect(glyph).toHaveCSS('scale', 'none');
  await expect(glyph).toHaveCSS('transform', 'none');
  await page.mouse.down();
  const pressedWidths = await glyph.evaluate(async element => {
    const widths: number[] = [];
    const started = performance.now();
    await new Promise<void>(resolve => {
      function frame() {
        widths.push(element.getBoundingClientRect().width);
        if (performance.now() - started >= 500) resolve(); else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    return widths;
  });
  expect(Math.min(...pressedWidths)).toBeGreaterThanOrEqual(24);
  await expect(glyph).toHaveCSS('width', '24px');
  await expect(glyph).toHaveCSS('stroke', 'none');
  await expect(glyph.locator('[data-symbol-variant=filled]')).toHaveCSS('display', 'inline');
  await mkdir('tmp/material-symbols', { recursive: true });
  await page.screenshot({ path: `tmp/material-symbols/${info.project.name}-rail-pressed.png` });
  await page.mouse.up();
  await expect(glyph).toHaveCSS('width', '26px');
  await expect(glyph).toHaveCSS('stroke-width', '16px');
  await page.mouse.move(1200, 500);
  await expect(glyph).toHaveCSS('width', '24px');
  await tokens.focus();
  await page.keyboard.down('Space');
  await expect(glyph).toHaveCSS('width', '24px');
  await expect(glyph).toHaveCSS('stroke', 'none');
  await page.keyboard.up('Space');
  const variants = rail.getByRole('button', { name: 'Variants', exact: true });
  await variants.click();
  await expect(tokens.locator('[data-symbol-variant=outlined]')).toHaveCSS('display', 'inline');
  await expect(tokens.locator('[data-symbol-variant=filled]')).toHaveCSS('display', 'none');
  await expect(variants.locator('[data-symbol-variant=filled]')).toHaveCSS('display', 'inline');
  const figma = rail.getByRole('button', { name: 'Figma', exact: true });
  await expect(figma.locator('.md-nav-icon > svg')).toBeVisible();
  await figma.click();
  await expect(figma.locator('.md-nav-icon > svg')).toBeVisible();
  await expect(page.locator('[data-service=workspace] svg')).toHaveAttribute('data-material-symbol', 'desktop_cloud');
});

test('selected nested folders retain their selected surface beyond the first level', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'material.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ md: { comp: { 'app-bar': { 'on-scroll': { value: { $type: 'number', $value: 1 } }, search: { value: { $type: 'number', $value: 2 } } } } } })),
  });
  async function select(path: string, scope: Page | Locator = page) {
    const item = scope.locator(`[data-group-path="${path}"]`);
    await item.click();
    await expect(item).toHaveAttribute('aria-current', 'page');
    await selectedSurface(item);
    await expect(item.locator('.md-list-label')).toBeVisible();
    const expand = scope.getByRole('button', { name: `Expand ${path}`, exact: true });
    if (await expand.count()) await expand.click();
    return item;
  }
  await select('md');
  await select('md.comp');
  const selected = await select('md.comp.app-bar');
  await expect(page.locator('[data-group-path="md.comp"]')).not.toHaveAttribute('aria-current', 'page');
  await mkdir('tmp/material-symbols', { recursive: true });
  await selected.screenshot({ path: `tmp/material-symbols/${info.project.name}-nested-selection.png` });
  await page.screenshot({ path: `tmp/material-symbols/${info.project.name}-nested-workspace.png` });
  await select('md.comp.app-bar.on-scroll');
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await selectedSurface(page.locator('[data-group-path="md.comp.app-bar.on-scroll"]'));
  await page.getByRole('button', { name: 'Name for md.comp.app-bar.on-scroll.value', exact: true }).click();
  await page.getByRole('button', { name: 'Link reference for md.comp.app-bar.on-scroll.value', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Link a token', exact: true });
  await select('md', picker);
  await select('md.comp', picker);
  await select('md.comp.app-bar', picker);
  await picker.screenshot({ path: `tmp/material-symbols/${info.project.name}-reference-selection-dark.png` });
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
});
