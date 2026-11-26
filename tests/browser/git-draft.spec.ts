import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { isProposal } from '../../integrations/github/contract.ts';
import { recoveryCopies } from './recovery-helpers.ts';

test('a second edit updates the existing pull request from its saved revision', async ({ page }) => {
  const repository = 'example/tokens';
  const revision = 'a'.repeat(40);
  const firstHead = 'b'.repeat(40);
  const secondHead = 'c'.repeat(40);
  const branch = 'token-editor/' + 'A'.repeat(43);
  const url = 'https://github.com/example/tokens/pull/7';
  const sources = await Promise.all(['reference.tokens.json', 'system.tokens.json'].map(async path => ({ path, text: await readFile(new URL('../../examples/' + path, import.meta.url), 'utf8') })));
  let submissions = 0;
  await page.route('**/git/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/git/workspaces')) return route.continue();
    if (path === '/git/session') return route.fulfill({ json: { login: 'designer', repositories: [repository] } });
    if (path === '/git/open') return route.fulfill({ json: { repository, revision, root: 'tokens', files: sources } });
    if (path !== '/git/propose') throw new Error('Unexpected Git request.');
    const proposal: unknown = route.request().postDataJSON();
    if (!isProposal(proposal)) throw new Error('Invalid proposal.');
    submissions++;
    expect(proposal.revision).toBe(submissions === 1 ? revision : firstHead);
    expect(proposal.branch).toBe(submissions === 1 ? undefined : branch);
    expect(proposal.changes).toHaveLength(1);
    expect(proposal.changes[0]?.before).toContain('"value": ' + (submissions === 1 ? 8 : 12));
    expect(proposal.changes[0]?.after).toContain('"value": ' + (submissions === 1 ? 12 : 16));
    return route.fulfill({ json: { url, branch, revision: submissions === 1 ? firstHead : secondHead } });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Choose repository', exact: true }).click();
  
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  const edit = async (before: number, after: number) => {
    await page.getByRole('banner').getByRole('button', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Import token changes…', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('dialog', { name: 'Import token changes' }).getByRole('button', { name: 'Choose file…', exact: true }).click();
    await (await chooser).setFiles({ name: 'change.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, changes: [
      { path: 'reference.space.small', before: { value: before, unit: 'px' }, after: { value: after, unit: 'px' } },
    ] })) });
    await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Review merge request', exact: true }).click();
    await page.getByRole('button', { name: before === 8 ? 'Create merge request' : 'Update merge request', exact: true }).click();
    await expect(page.getByRole('link', { name: 'View merge request', exact: true })).toHaveAttribute('href', url);
  };
  await edit(8, 12);
  await expect.poll(async () => (await recoveryCopies(page)).find(copy => copy.github?.revision === firstHead)?.github?.branch).toBe(branch);
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Recover local work', exact: true })).toHaveCount(0);
  await edit(12, 16);
  expect(submissions).toBe(2);
});
