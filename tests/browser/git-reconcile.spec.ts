import { openSaveReview } from './save-review.ts';
import { expect, test } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { isProposal } from '../../integrations/github/contract.ts';
import { chooseOption } from './select-field.ts';
import { recoveryCopies } from './recovery-helpers.ts';

for (const choice of ['independent', 'draft', 'repository', 'custom', 'cancel', 'changed-again', 'resume', 'resume-invalid']) {
  test('repository reconciliation handles ' + choice + ' without downloading a patch', async ({ page }, testInfo) => {
    const repository = 'example/tokens';
    const sources = await Promise.all(['reference.tokens.json', 'system.tokens.json'].map(async path => ({ path, text: await readFile(new URL('../../examples/' + path, import.meta.url), 'utf8') })));
    const revision = 'a'.repeat(40); let latest = 'b'.repeat(40); let submissions = 0;
    const remoteSmall = choice === 'independent' ? 8 : 10;
    let remoteFiles = sources.map(source => ({ ...source, text: source.path === 'reference.tokens.json' ? source.text.replace('"value": 8', '"value": ' + remoteSmall).replace('"value": 16', '"value": 24') : source.text }));
    await page.route('**/git/*', async route => {
      const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/git/workspaces')) return route.continue();
      if (path === '/git/session') return route.fulfill({ json: { login: 'designer', repositories: [repository] } });
      if (path === '/git/open') return route.fulfill({ json: { repository, revision: submissions ? latest : revision, root: 'tokens', files: submissions ? remoteFiles : sources } });
      if (path !== '/git/propose') throw new Error('Unexpected Git request.');
      const proposal: unknown = route.request().postDataJSON(); if (!isProposal(proposal)) throw new Error('Invalid proposal.');
      submissions++;
      if (submissions === 1 || choice === 'changed-again' && submissions === 2) {
        if (submissions === 2) {
          latest = 'c'.repeat(40); remoteFiles = remoteFiles.map(source => ({ ...source, text: source.text.replace('"value": 10', '"value": 11').replace('"value": 24', '"value": 28') }));
        }
        return route.fulfill({ status: 409, json: { code: 'base_changed' } });
      }
      expect(proposal.revision).toBe(latest);
      expect(proposal.changes).toHaveLength(1);
      expect(proposal.changes[0]?.before).toBe(remoteFiles[0]?.text);
      const after = proposal.changes[0]?.after;
      expect(after).toContain('"value": ' + (choice === 'custom' || choice === 'resume-invalid' ? 14 : 12));
      expect(after).toContain('"value": ' + (choice === 'changed-again' ? 28 : 24));
      return route.fulfill({ json: { url: 'https://github.com/example/tokens/pull/8', branch: 'token-editor/' + 'A'.repeat(43), revision: 'd'.repeat(40) } });
    });
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Choose repository', exact: true }).click();
    
    await page.getByRole('button', { name: 'Open repository', exact: true }).click();
    await page.getByRole('banner').getByRole('button', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Import token changes…', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('dialog', { name: 'Import token changes' }).getByRole('button', { name: 'Choose file…', exact: true }).click();
    await (await chooser).setFiles({ name: 'change.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, changes: [
      { path: 'reference.space.small', before: { value: 8, unit: 'px' }, after: { value: 12, unit: 'px' } },
    ] })) });
    await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
    await openSaveReview(page);
    await page.getByRole('button', { name: 'Create merge request', exact: true }).click();
    await page.getByRole('button', { name: 'Review latest revision', exact: true }).click();
    if (choice !== 'independent') {
      const dialog = page.getByRole('dialog', { name: 'Reconcile repository changes' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Before'); await expect(dialog).toContainText('Your draft'); await expect(dialog).toContainText('Repository');
      if (process.env['FOUNDRY_CAPTURE_RECONCILE'] && choice === 'draft' && testInfo.project.name === 'chromium') {
        await mkdir('.wrangler/verification', { recursive: true });
        await page.screenshot({ path: '.wrangler/verification/repository-conflict-desktop.png', animations: 'disabled' });
        await page.setViewportSize({ width: 400, height: 850 });
        await expect(dialog.getByRole('combobox')).toBeVisible();
        await page.screenshot({ path: '.wrangler/verification/repository-conflict-mobile.png', animations: 'disabled' });
      }
      if (choice === 'cancel') {
        await dialog.getByRole('button', { name: 'Cancel reconciliation', exact: true }).click();
        await page.getByRole('button', { name: 'Review latest revision', exact: true }).click();
      }
      await chooseOption(dialog.getByRole('combobox'), choice === 'repository' ? 'repository' : choice === 'custom' || choice === 'resume-invalid' ? 'custom' : 'draft');
      if (choice === 'custom') await dialog.getByLabel('Value (px)', { exact: true }).fill('14');
      if (choice === 'resume' || choice === 'resume-invalid') {
        if (choice === 'resume-invalid') await dialog.getByLabel('Value (px)', { exact: true }).fill('unfinished');
        await expect.poll(async () => (await recoveryCopies(page)).find(copy => copy.repositoryReview?.snapshot.revision === latest)?.repositoryReview?.choices[0]?.text).toBe(choice === 'resume' ? '12' : 'unfinished');
        await page.reload();
        await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume', exact: true }).click();
        await expect(dialog).toBeVisible();
        if (choice === 'resume-invalid') {
          await expect(dialog.getByLabel('Value (px)', { exact: true })).toHaveValue('unfinished');
          await expect(dialog.getByRole('button', { name: 'Review merged changes', exact: true })).toBeDisabled();
          await dialog.getByLabel('Value (px)', { exact: true }).fill('14');
        } else await expect(dialog.getByRole('combobox')).toHaveValue('Keep your draft');
      }
      await dialog.getByRole('button', { name: 'Review merged changes', exact: true }).click();
      if (choice === 'repository') {
        await expect(dialog).not.toBeVisible(); expect(submissions).toBe(1);
        await expect(page.getByText('The repository already contains the chosen definitions.', { exact: true })).toBeVisible();
        return;
      }
    }
    await page.getByRole('button', { name: 'Create merge request', exact: true }).click();
    if (choice === 'changed-again') {
      await page.getByRole('button', { name: 'Review latest revision', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Reconcile repository changes' });
      await chooseOption(dialog.getByRole('combobox'), 'draft');
      await dialog.getByRole('button', { name: 'Review merged changes', exact: true }).click();
      await page.getByRole('button', { name: 'Create merge request', exact: true }).click();
    }
    await expect(page.getByRole('link', { name: 'View merge request', exact: true })).toHaveAttribute('href', 'https://github.com/example/tokens/pull/8');
    expect(submissions).toBe(choice === 'changed-again' ? 3 : 2);
  });
}
