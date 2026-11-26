import { test, expect } from '@playwright/test';
import { beginRepositorySave, createWorkspace, finishRepositorySave, saveWorkspace, startRepositorySave, workspaceView } from '../../integrations/workspace/model.ts';
import { isProposal } from '../../integrations/github/contract.ts';

for (const completed of [false, true]) {
  test((completed ? 'a completed save reopens its server checkpoint' : 'an interrupted reviewed save resumes its existing proposal') + ' and keeps a newer draft', async ({ page }) => {
    const id = '9'.repeat(64); const repository = 'example/tokens'; const path = 'tokens/base.tokens.json';
    const revision = 'a'.repeat(40); const branch = 'token-editor/' + 'A'.repeat(43);
    const result = { url: 'https://github.com/example/tokens/pull/7', revision: 'b'.repeat(40), branch };
    const source = (space: number) => [{ path, text: JSON.stringify({ space: { $type: 'number', $value: space } }) }];
    const pin = { repository, root: 'tokens', revision };
    let state = await createWorkspace(id, { name: 'Spacing exploration', files: source(12), baseline: source(8), repository: pin });
    const proposal = { repository, revision, changes: [{ path, before: source(8)[0]?.text ?? '', after: source(12)[0]?.text ?? '' }] };
    state = await beginRepositorySave(state, proposal, 'tokens');
    const operation = state.repositorySave; if (!operation) throw new Error('Missing save fixture.');
    state = startRepositorySave(state, operation.id);
    state = await saveWorkspace(state, state.draft, { name: state.name, files: source(14), baseline: source(8), repository: pin });
    if (completed) state = finishRepositorySave(state, operation.id, result);
    let submissions = 0;
    await page.route('**/git/workspaces/' + id + '*', route => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET') throw new Error('Reopening saved work must not replace the server draft.');
      return route.fulfill({ json: url.searchParams.get('summary') === '1' ? { version: state.version } : workspaceView(state) });
    });
    await page.route('**/git/propose', route => {
      const input: unknown = route.request().postDataJSON();
      if (!isProposal(input)) throw new Error('Missing reviewed request.');
      expect(input).toMatchObject({ ...proposal, workspace: id });
      state = finishRepositorySave(state, operation.id, result); submissions++;
      return route.fulfill({ json: { ...result, workspace: workspaceView(state) } });
    });
    await page.goto('/?workspace=' + id);
    await expect(page.getByRole('banner')).toContainText('Spacing exploration');
    await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
    const resume = page.getByRole('button', { name: 'Resume reviewed save', exact: true });
    if (!completed) { await expect(resume).toBeVisible(); await resume.click(); }
    await expect(resume).toHaveCount(0);
    await expect(page.getByRole('main', { name: 'Changes', exact: true })).toContainText('1 changed source file');
    await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Value for space', exact: true })).toHaveText('14');
    await page.reload();
    await expect(page.getByRole('banner')).toContainText('Spacing exploration');
    await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Value for space', exact: true })).toHaveText('14');
    expect(submissions).toBe(completed ? 0 : 1);
    expect(state.baseline).not.toBe(state.draft);
  });
}
