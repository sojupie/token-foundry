import type { Page } from '@playwright/test';
import { isRecoveryRecord } from '../../editor/lib/recovery.ts';
import { isUnknownArray } from '../../lib/json.ts';

export async function recoveryCopies(page: Page) {
  const values: unknown = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open('foundry-recovery', 1);
    request.addEventListener('success', () => {
      const db = request.result;
      const read = db.transaction('work', 'readonly').objectStore('work').getAll();
      read.addEventListener('success', () => { const result: unknown = read.result; db.close(); resolve(result); });
      read.addEventListener('error', () => { db.close(); reject(new Error('Could not read recovery copies.')); });
    });
    request.addEventListener('error', () => reject(new Error('Could not open recovery storage.')));
  }));
  if (!isUnknownArray(values) || !values.every(isRecoveryRecord)) throw new Error('Invalid recovery data.');
  return values;
}

export async function editSource(page: Page, before: number, after: number) {
  await page.getByRole('banner').getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import token changes…', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('dialog', { name: 'Import token changes' }).getByRole('button', { name: 'Choose file…', exact: true }).click();
  await (await chooser).setFiles({ name: 'change.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    schemaVersion: 1, changes: [{ path: 'reference.space.small', before: { value: before, unit: 'px' }, after: { value: after, unit: 'px' } }],
  })) });
  await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
}
