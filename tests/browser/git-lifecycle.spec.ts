import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { isProposal, proposalUnavailable } from '../../integrations/github/contract.ts';
import { isRecord } from '../../lib/json.ts';
import { chooseOption } from './select-field.ts';

for (const lifecycle of ['merged', 'closed', 'deleted']) {
  test('a ' + lifecycle + ' proposal rebases the retained draft before creating another pull request', async ({ page }) => {
    const repository = 'example/tokens'; const base = 'a'.repeat(40); const saved = 'b'.repeat(40); const latest = 'c'.repeat(40);
    const branch = 'token-editor/' + 'A'.repeat(43); let submissions = 0; const opens: unknown[] = [];
    const sources = await Promise.all(['reference.tokens.json', 'system.tokens.json'].map(async path => ({ path, text: await readFile(new URL('../../examples/' + path, import.meta.url), 'utf8') })));
    const main = sources.map(file => ({ ...file, text: lifecycle === 'merged' ? file.text.replace('"value": 8', '"value": 12') : file.text }));
    await page.route('**/git/*', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/git/workspaces')) return route.continue();
      if (path === '/git/session') return route.fulfill({ json: { login: 'designer', repositories: [repository] } });
      const input: unknown = route.request().postDataJSON();
      if (path === '/git/open') {
        opens.push(input); expect(isRecord(input)).toBe(true);
        if (submissions < 2) return route.fulfill({ json: { repository, revision: base, root: 'tokens', files: sources } });
        if (isRecord(input) && input['branch']) return route.fulfill({ status: 409, json: { code: proposalUnavailable, message: 'This proposal is unavailable.' } });
        return route.fulfill({ json: { repository, revision: latest, root: 'tokens', files: main } });
      }
      if (path !== '/git/propose' || !isProposal(input)) throw new Error('Unexpected Git request.');
      submissions++;
      if (submissions === 2) {
        expect(input.branch).toBe(branch); expect(input.revision).toBe(saved);
        return route.fulfill({ status: 409, json: { code: proposalUnavailable, message: 'Review the latest repository version to continue your draft.' } });
      }
      expect(input.branch).toBeUndefined(); expect(input.revision).toBe(submissions === 1 ? base : latest);
      expect(input.changes).toHaveLength(1);
      expect(input.changes[0]?.before).toContain('"value": ' + (submissions === 3 && lifecycle === 'merged' ? 12 : 8));
      expect(input.changes[0]?.after).toContain('"value": ' + (submissions === 1 ? 12 : 16));
      return route.fulfill({ json: { url: 'https://github.com/example/tokens/pull/' + (submissions === 1 ? 7 : 8), branch, revision: submissions === 1 ? saved : 'd'.repeat(40) } });
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
    };
    await edit(8, 12); await page.getByRole('button', { name: 'Create merge request', exact: true }).click();
    await expect(page.getByRole('link', { name: 'View merge request', exact: true })).toHaveAttribute('href', 'https://github.com/example/tokens/pull/7');
    await edit(12, 16); await page.getByRole('button', { name: 'Update merge request', exact: true }).click();
    await page.getByRole('button', { name: 'Review latest revision', exact: true }).click();
    if (lifecycle !== 'merged') {
      const conflicts = page.getByRole('dialog', { name: 'Reconcile repository changes' });
      await expect(conflicts).toContainText('Your draft'); await expect(conflicts).toContainText('Repository');
      await chooseOption(conflicts.getByRole('combobox'), 'draft');
      await conflicts.getByRole('button', { name: 'Review merged changes', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Create merge request', exact: true }).click();
    await expect(page.getByRole('link', { name: 'View merge request', exact: true })).toHaveAttribute('href', 'https://github.com/example/tokens/pull/8');
    expect(submissions).toBe(3); expect(opens.slice(-2)).toEqual([{ repository, branch }, { repository }]);
  });
}
