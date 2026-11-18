import { expect } from '@playwright/test';
import type { Locator } from '@playwright/test';

export async function selectPopup(trigger: Locator) {
  const id = await trigger.getAttribute('aria-controls');
  if (!id) throw new Error('Select trigger has no popup');
  return trigger.page().locator('[id=' + JSON.stringify(id) + ']');
}

export async function chooseOption(trigger: Locator, option: string | { label: string }) {
  const popup = await selectPopup(trigger);
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const item = typeof option === 'string'
    ? popup.locator('[role="option"][data-field-value=' + JSON.stringify(option) + ']')
    : popup.getByRole('option', { name: option.label, exact: true });
  await item.click();
}
