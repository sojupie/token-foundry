import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export async function openSaveReview(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Review changes', exact: true }).click();
  const changes = page.getByRole('main', { name: 'Changes', exact: true });
  await expect(changes).toBeVisible();
  await changes.getByRole('button', { name: /^Review and (?:export patch|save to folder|create merge request|update merge request)$/u }).click();
  await expect(page.getByRole('dialog', { name: 'Review changes', exact: true })).toBeVisible();
}
