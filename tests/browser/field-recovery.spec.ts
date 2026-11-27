import { expect, test } from '@playwright/test';
import { recoveryCopies } from './recovery-helpers.ts';

for (const full of [false, true]) test('a failed value module retains its parent form and ' + (full ? 'blocks reload when recovery storage is full' : 'saves its exact draft before reloading'), async ({ page }) => {
  if (full) await page.addInitScript(() => {
    Object.defineProperty(IDBObjectStore.prototype, 'put', { value: () => { throw new DOMException('Storage full', 'QuotaExceededError'); } });
  });
  await page.route('**/editor/typed-value.tsx', route => route.fulfill({ contentType: 'text/javascript', body: 'throw new Error("Value editor failed"); export default function Panel() {}' }));
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'recovery.tokens.json', mimeType: 'application/json', buffer: Buffer.from('{"gap":{"$type":"number","$value":8}}') });
  await page.getByRole('button', { name: 'Value for gap', exact: true }).click();
  await page.getByRole('button', { name: 'Change value', exact: true }).click();
  const form = page.getByRole('dialog', { name: /^Change value/u });
  await expect(form.getByRole('button', { name: 'Reload editor', exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Raw JSON', exact: true }).click();
  await form.getByRole('textbox', { name: 'Replacement value JSON', exact: true }).fill('17');
  await form.getByRole('button', { name: 'Use typed editor', exact: true }).click();
  const reload = form.getByRole('button', { name: 'Reload editor', exact: true }); await expect(reload).toBeVisible();
  await page.unroute('**/editor/typed-value.tsx');
  if (full) {
    let navigated = false; page.on('framenavigated', () => { navigated = true; });
    await reload.click();
    await expect(form.getByText('Recovery could not be saved. Download a recovery copy before reloading.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download recovery copy', exact: true })).toBeVisible();
    expect(navigated).toBe(false);
  } else {
    await reload.click();
    await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(form.getByRole('textbox', { name: 'Replacement value', exact: true })).toHaveValue('17');
    expect((await recoveryCopies(page))[0]?.files[0]?.text).toContain('"$value":8');
  }
});
