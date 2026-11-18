import { expect, test } from '@playwright/test';
import { isProposal } from '../../integrations/github/contract.ts';
import { chooseOption } from './select-field.ts';

const tokens = { reference: { space: { small: { $type: 'dimension', $value: '12px' } } } };

test('reviews and applies a Penpot token export', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import Penpot tokens…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import Penpot tokens' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  await (await chooser).setFiles({ name: 'tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ Old: { reference: { space: { small: { $type: 'dimension', $value: '8px' } } } }, Sevan: tokens })) });
  await expect(dialog.getByRole('combobox', { name: 'Token set', exact: true })).toHaveAttribute('data-select-value', '');
  await chooseOption(dialog.getByRole('combobox', { name: 'Token set', exact: true }), 'Sevan');
  await dialog.getByRole('button', { name: 'Review changes' }).click();
  const review = page.getByRole('dialog', { name: 'Review value changes' });
  await expect(review).toContainText('reference.space.small');
  await expect(review).toContainText('12');
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(page.locator('.workspace-review').getByRole('button', { name: 'Review changes' })).toBeEnabled();
});

test('submits the reviewed import through the GitHub workspace', async ({ page }) => {
  const { readFile } = await import('node:fs/promises');
  const paths = ['reference.tokens.json', 'system.tokens.json'];
  const files = await Promise.all(paths.map(async path => ({ path, text: await readFile(new URL('../../examples/' + path, import.meta.url), 'utf8') })));
  const repository = 'example/tokens', revision = 'a'.repeat(40);
  let submitted: unknown;
  await page.route('**/git/*', async route => {
    const action = new URL(route.request().url()).pathname;
    if (action === '/git/session') await route.fulfill({ json: { login: 'designer', repositories: [repository] } });
    else if (action === '/git/open') await route.fulfill({ json: { repository, revision, root: 'tokens', files } });
    else if (action === '/git/propose') {
      submitted = route.request().postDataJSON();
      await route.fulfill({ json: { url: 'https://github.com/example/tokens/pull/7' } });
    } else throw new Error('Unexpected Git request: ' + action);
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Manage integrations', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open GitHub repository…' }).click();
  await page.getByRole('button', { name: 'Open repository' }).click();
  await expect(page.locator('[data-workspace-name]')).toHaveText(repository);
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import Penpot tokens…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import Penpot tokens' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  await (await chooser).setFiles({ name: 'tokens.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ Sevan: tokens })) });
  await dialog.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('dialog', { name: 'Review value changes' }).getByRole('button', { name: 'Apply to workspace' }).click();
  await page.getByRole('button', { name: 'Review pull request' }).click();
  await page.getByRole('button', { name: 'Create pull request', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View pull request' })).toHaveAttribute('href', 'https://github.com/example/tokens/pull/7');
  expect(submitted).toMatchObject({ repository, revision, changes: [{ path: 'reference.tokens.json' }] });
  if (!isProposal(submitted)) throw new Error('Invalid pull request payload.');
  expect(submitted.changes[0]?.after).toContain('"value": 12');
});
