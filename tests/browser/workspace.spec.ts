import { openSaveReview } from './save-review.ts';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { baseChanged, isProposal } from '../../integrations/github/contract.ts';
import { parseJson } from '../../lib/json.ts';
import type { JsonValue } from '../../lib/json.ts';
import type { PullRequestProposal } from '../../integrations/github/contract.ts';
import { chooseOption, selectPopup } from './select-field.ts';

const sources = await Promise.all(['reference.tokens.json', 'system.tokens.json'].map(async (path) => ({
  path, text: await readFile(new URL('../../examples/' + path, import.meta.url), 'utf8'),
})));
const referenceChange = { schemaVersion: 1, changes: [
  { path: 'reference.space.small', before: { value: 8, unit: 'px' }, after: { value: 12, unit: 'px' } },
] };

async function command(page: Page, menu: 'File' | 'Edit' | 'View' | 'Variants' | 'Integrations' | 'Help', item: string | RegExp) {
  if (menu === 'Integrations') {
    await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.getByRole('button', { name: /^(Choose repository|Connect account)$/u }).click(); return;
  }
  await page.getByRole('banner').getByRole('button', { name: menu, exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

async function openProposal(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await command(page, 'File', 'Import token changes…');
  const dialog = page.getByRole('dialog', { name: 'Import token changes' });
  await expect(dialog).toContainText('Choose a file with edits to the tokens you have open.');
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  await (await chooser).setFiles({
    name: 'token-proposal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(referenceChange)),
  });
  const review = page.getByRole('dialog', { name: 'Review value changes' });
  await expect(review).toContainText('keeps your other edits');
  await expect(review.getByRole('row', { name: /reference\.space\.small 8 px 12 px/u })).toBeVisible();
  await review.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
}

test('reviews a linked proposal and cross-file move again if the pinned GitHub revision changes', async ({ page }) => {
  const revision = 'a'.repeat(40);
  const latestRevision = 'b'.repeat(40);
  const repository = 'example/tokens';
  const url = 'https://github.com/' + repository + '/pull/7';
  const requests: string[] = [];
  let proposal: PullRequestProposal | undefined;
  let snapshot = { repository, revision, root: 'tokens', files: sources };
  await page.route('**/git/*', async (route) => {
    const action = new URL(route.request().url()).pathname;
    if (action.startsWith('/git/workspaces')) return route.continue();
    if (action === '/git/session') {
      await route.fulfill({ json: { login: 'designer', repositories: [repository] } });
      return;
    }
    requests.push(action);
    if (action === '/git/open') {
      await route.fulfill({ json: snapshot });
    } else if (action === '/git/propose') {
      const body: unknown = route.request().postDataJSON();
      if (!isProposal(body)) throw new Error('Malformed proposal.');
      if (body.revision === revision) {
        await route.fulfill({ status: 409, json: { code: baseChanged, message: 'Base branch changed.' } });
        return;
      }
      proposal = body;
      await route.fulfill({ json: { url } });
    } else throw new Error('Unexpected Git request: ' + action);
  });

  await page.goto('/#proposal=' + encodeURIComponent(JSON.stringify(referenceChange)));
  await expect(page.getByRole('button', { name: 'Review linked changes' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(requests).toEqual([]);
  await command(page, 'Integrations', 'Open GitHub repository…');
  await expect(page.getByRole('dialog', { name: 'Open GitHub repository' }).getByText('Connected as @designer', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Repository', exact: true })).toHaveAttribute('data-select-value', repository);
  await page.getByRole('button', { name: 'Open repository' }).click();
  await expect(page.locator('[data-workspace-name]')).toHaveText(repository);
  await page.getByRole('button', { name: 'Review linked changes' }).click();
  await expect(page.getByText('Resolved value changes (2)')).toBeVisible();
  await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();

  await page.getByRole('navigation', { name: 'Token groups' }).getByRole('button', { name: 'Expand reference', exact: true }).click();
  await page.getByRole('navigation', { name: 'Token groups' }).getByRole('button', { name: 'space', exact: true }).click();
  await page.getByRole('complementary', { name: 'Groups' }).getByRole('button', { name: /^Actions for /u }).click();
  await page.getByRole('menuitem', { name: 'Rename group', exact: true }).click();
  await page.getByLabel('Group name', { exact: true }).fill('reference-space');
  await page.getByRole('button', { name: 'Review rename' }).click();
  await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await page.getByRole('button', { name: /^Actions for /u }).click();
  await page.getByRole('menuitem', { name: 'Move group', exact: true }).click();
  await page.getByRole('navigation', { name: 'Destination group' }).getByRole('button', { name: 'system', exact: true }).click();
  await page.getByRole('button', { name: 'Review move' }).click();
  await page.getByText('Show file changes', { exact: true }).click();
  const diff = page.getByRole('region', { name: 'File changes' });
  await expect(diff).toContainText('{system.reference-space.small}');
  await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await openSaveReview(page);
  await page.getByText('Show file changes', { exact: true }).click();
  await expect(diff).toContainText('{system.reference-space.small}');
  expect(requests).toEqual(['/git/open']);
  await page.getByRole('button', { name: 'Create merge request', exact: true }).click();
  const refresh = page.getByRole('button', { name: 'Review latest revision', exact: true });
  await expect(refresh).toBeVisible();
  const changedFile = sources.find(({ path }) => path === 'reference.tokens.json');
  if (!changedFile) throw new Error('Missing reference fixture.');
  snapshot = { ...snapshot, revision: latestRevision, files: [
    { path: changedFile.path, text: changedFile.text.replace('"value": 8', '"value": 10') },
    ...sources.filter(({ path }) => path !== changedFile.path),
  ] };
  await refresh.click();
  const reconciliation = page.getByRole('dialog', { name: 'Reconcile repository changes' });
  await expect(reconciliation).toBeVisible();
  await expect(reconciliation).toContainText('reference.tokens.json');
  await expect(reconciliation).toContainText('Your draft');
  await reconciliation.getByRole('button', { name: 'Cancel reconciliation', exact: true }).click();
  await expect(refresh).toBeVisible();
  if (!await diff.isVisible()) await page.getByText('Show file changes', { exact: true }).click();
  await expect(diff).toContainText('{system.reference-space.small}');
  expect(requests).toEqual(['/git/open', '/git/propose', '/git/open']);

  snapshot = { ...snapshot, revision: 'c'.repeat(40), files: [
    ...sources,
    { path: 'consumer.tokens.json', text: '{"consumer":{"gap":{"$type":"dimension","$value":"{system.space.control-gap}"}}}' },
  ] };
  await refresh.click();
  await expect(page.getByText('This diff and its resolved values use the latest revision.')).toBeVisible();
  await expect(diff).toContainText('{system.reference-space.small}');
  const impact = page.getByText(/Resolved value changes/u);
  await impact.click();
  await expect(page.getByRole('dialog').getByText('consumer.gap', { exact: true })).toBeVisible();
  expect(requests).toEqual(['/git/open', '/git/propose', '/git/open', '/git/open']);
  await page.getByRole('button', { name: 'Create merge request', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View merge request' })).toHaveAttribute('href', url);
  expect(requests).toEqual(['/git/open', '/git/propose', '/git/open', '/git/open', '/git/propose']);
  expect(proposal).toMatchObject({ revision: snapshot.revision, repository, changes: sources.map(({ path, text }) => ({ path, before: text })) });
  expect(proposal?.changes.find(({ path }) => path === 'system.tokens.json')?.after).toContain('{system.reference-space.small}');
});

test('opens nested DTCG JSON by content and distinguishes Android unit warnings', async ({ page }, info) => {
  const folder = info.outputPath('plain-json');
  await mkdir(folder + '/tailwind', { recursive: true });
  await mkdir(folder + '/node_modules', { recursive: true });
  await Promise.all([
    writeFile(folder + '/tailwind/default.json', JSON.stringify({ gap: { $type: 'dimension', $value: { value: 8, unit: 'dp' } } })),
    writeFile(folder + '/theme.json', JSON.stringify({ applied: { $type: 'dimension', $value: '{gap}' } })),
    writeFile(folder + '/package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } })),
    writeFile(folder + '/node_modules/ignored.tokens.json', JSON.stringify({ ignored: { $type: 'number', $value: 1 } })),
  ]);
  await page.addInitScript(() => { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true }); });
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await command(page, 'File', 'Open folder…');
  await (await chooser).setFiles(folder);
  await expect(page.getByText('2 tokens', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resolved value for applied', exact: true })).toHaveText('8 dp');
  await command(page, 'View', 'Workspace issues');
  const diagnostics = page.getByRole('dialog', { name: 'Workspace issues' });
  await expect(diagnostics.getByText(/Warning.*tailwind\/default.json.*dp is an Android unit.*px or rem/u)).toBeVisible();
  await expect(diagnostics.getByText(/package.json|ignored.tokens.json/u)).toHaveCount(0);
});

test('checks referenced files before writing a reviewed folder edit', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native folder access is exercised in Chromium.');
  await page.addInitScript((files) => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('fixture', { create: true });
      await Promise.all(files.map(async ({ path, text }) => {
        const handle = await directory.getFileHandle(path, { create: true });
        const stream = await handle.createWritable();
        await stream.write(text);
        await stream.close();
      }));
      return Object.assign(directory, { requestPermission: () => Promise.resolve('granted' as const) });
    };
  }, sources.map(file => ({ ...file, path: file.path.replace('.tokens', '') })));
  await page.goto('/');
  await command(page, 'File', 'Open folder…');
  await expect(page.locator('[data-workspace-name]')).toHaveText('fixture');
  await openProposal(page);
  await openSaveReview(page);
  const save = page.getByRole('dialog', { name: 'Review changes', exact: true }).getByRole('button', { name: 'Save to folder', exact: true });
  const writeSystem = (text: string) => page.evaluate(async (value) => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('fixture');
    const stream = await (await directory.getFileHandle('system.json')).createWritable();
    await stream.write(value);
    await stream.close();
  }, text);
  const system = sources.find(({ path }) => path === 'system.tokens.json')?.text;
  if (!system) throw new Error('Missing system fixture.');
  await writeSystem(system + '\n');
  await save.click();
  await expect(page.getByText(/system\.json changed on disk/u)).toBeVisible();
  const readReference = () => page.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('fixture');
    return (await (await directory.getFileHandle('reference.json')).getFile()).text();
  });
  expect(await readReference()).toBe(sources.find(({ path }) => path === 'reference.tokens.json')?.text);
  await writeSystem(system);
  await save.click();
  await expect(page.getByText('Saved to folder.', { exact: true })).toBeVisible();
  expect(await readReference()).toMatch(/"value": 12/u);
});

test('exports an applicable patch from a read-only folder', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'firefox', 'Firefox exercises the standard folder picker.');
  const directory = info.outputPath('checkout');
  await mkdir(directory, { recursive: true });
  await Promise.all(sources.map(({ path, text }) => writeFile(info.outputPath('checkout', path), text)));
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await command(page, 'File', 'Open folder…');
  await (await chooser).setFiles(directory);
  await expect(page.getByRole('button', { name: 'Review and save' })).toHaveCount(0);
  await openProposal(page);
  const download = page.waitForEvent('download');
  await openSaveReview(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Export patch', exact: true }).click();
  execFileSync('git', ['apply', '--check', await (await download).path()], { cwd: directory });
});

test('styled chips and select fields keep keyboard navigation and return focus', async ({ page }) => {
  await page.goto('/');
  await command(page, 'File', 'Open Material 3 sample');
  await expect(page.getByRole('menu', { name: 'File' })).toBeHidden();
  const editingSet = page.getByRole('combobox', { name: 'Editing set' });
  const setPopup = await selectPopup(editingSet);
  await editingSet.press('ArrowDown');
  await expect(setPopup).toBeVisible();
  await expect(editingSet).toBeFocused();
  const first = setPopup.getByRole('option', { name: 'All tokens', exact: true });
  await expect(first).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('End');
  await expect(setPopup.getByRole('option').last()).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Escape');
  await expect(setPopup).toBeHidden();
  await expect(editingSet).toBeFocused();
  await expect(editingSet).toHaveAttribute('data-select-value', '');
  await editingSet.press('Space');
  await expect(setPopup).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(setPopup).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Appearance', exact: true })).toBeFocused();
  await editingSet.press('ArrowDown');
  await page.keyboard.press('l');
  await expect(setPopup.getByRole('option', { name: 'Light', exact: true })).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Enter');
  await expect(setPopup).toBeHidden();
  await expect(page.getByRole('columnheader', { name: 'Resolved in Light' })).toBeVisible();
  await expect(editingSet).toBeFocused();

  await page.getByRole('button', { name: 'New token', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New token', exact: true });
  const type = dialog.getByRole('combobox', { name: 'Token type' });
  const typePopup = await selectPopup(type);
  await type.press('ArrowDown');
  await expect(typePopup).toBeVisible();
  await page.keyboard.press('d');
  await expect(typePopup.getByRole('option', { name: 'dimension', exact: true })).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Enter');
  await expect(typePopup).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(type).toBeFocused();
  await expect(type).toHaveAttribute('data-select-value', 'dimension');
});

test.describe('touch select', () => {
  test.use({ hasTouch: true });

  test('closes a tapped choice without sending a click through to the dialog', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 850 });
    await page.goto('/');
    await page.getByRole('button', { name: 'New token', exact: true }).tap();
    const dialog = page.getByRole('dialog', { name: 'New token', exact: true });
    const type = dialog.getByRole('combobox', { name: 'Token type' });
    const popup = await selectPopup(type);
    await type.tap();
    await popup.getByRole('option', { name: 'dimension', exact: true }).tap();
    await expect(popup).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(type).toHaveAttribute('data-select-value', 'dimension');
    await expect(type).toBeFocused();
  });
});

test('inline Type uses the Forge popup and returns to its grid cell', async ({ page }) => {
  await page.goto('/');
  const cell = page.getByRole('button', { name: 'Type for reference.space.small', exact: true });
  const field = page.getByRole('combobox', { name: 'Token type' });
  await cell.press('F2');
  const popup = await selectPopup(field);
  await expect(field).toBeFocused();
  await field.press('ArrowDown');
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(cell).toBeFocused();

  await cell.press('F2');
  await field.press('ArrowDown');
  await page.keyboard.press('d');
  await expect((await selectPopup(field)).getByRole('option', { name: 'dimension' })).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Enter');
  await expect(cell).toBeFocused();
  await expect(cell).toHaveText('dimension');
});

test('opens the full Material 3 sample and switches Catalog appearances', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await command(page, 'File', 'Open Material 3 sample');
  await expect(page.getByRole('menu', { name: 'File' })).toBeHidden();
  await expect(page.locator('[data-workspace-name]')).toHaveText('Material 3');
  const groups = page.getByRole('complementary', { name: 'Groups', exact: true });
  await Promise.all(['comp', 'ref', 'sys', 'fab', 'outlined-icon-button'].map(branch =>
    expect(groups.getByRole('button', { name: branch, exact: true })).toBeVisible()));

  const appearance = page.getByRole('combobox', { name: 'Appearance', exact: true });
  await appearance.click();
  await expect((await selectPopup(appearance)).getByRole('option')).toHaveText([
    'Choose…', 'Light', 'Light · medium contrast', 'Light · high contrast',
    'Dark', 'Dark · medium contrast', 'Dark · high contrast',
  ]);
  await page.keyboard.press('Escape');
  const search = page.getByRole('searchbox', { name: 'Search tokens in group' });
  await search.fill('md.comp.assist-chip.label-text.weight');
  await expect(page.getByRole('button', { name: 'Value for md.comp.assist-chip.label-text.weight', exact: true }))
    .toHaveText('{md.sys.typescale.label-large.weight.$root}');
  await expect(page.getByRole('button', { name: 'Resolved value for md.comp.assist-chip.label-text.weight', exact: true }))
    .toHaveText('500');
  const issues = page.getByRole('button', { name: /^Issues \(/u });
  const baselineIssues = await issues.allTextContents();
  const editedSet = page.getByRole('combobox', { name: 'Editing set', exact: true });
  await chooseOption(editedSet, { label: 'Light' });
  await expect(page.getByRole('columnheader', { name: 'Resolved in Light' })).toBeVisible();
  const linkedPath = 'md.comp.app-bar.trailing-icon.color';
  await search.fill(linkedPath);
  await page.getByRole('button', { name: 'Name for ' + linkedPath, exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Token details' });
  await expect(inspector).toBeHidden();
  await expect(page.getByRole('button', { name: 'Name for ' + linkedPath, exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Edit token', exact: true }).click();
  await expect(inspector.getByText('Editing Light', { exact: true })).toBeVisible();
  await inspector.getByText('Where this value comes from', { exact: true }).click();
  const origin = inspector.getByRole('button', { name: /^Open source for Current value/u });
  await expect(origin).toBeVisible();
  await expect(inspector.getByRole('region', { name: 'Token references' })).not.toContainText('Reference target is missing');
  await expect(page.getByRole('button', { name: 'Resolved value for ' + linkedPath, exact: true })).toContainText('#49454F');
  expect(await issues.allTextContents()).toEqual(baselineIssues);
  await Promise.all(['Rename', 'Move', 'Duplicate', 'Delete'].map(action =>
    expect(page.getByRole('button', { name: action, exact: true })).toBeEnabled()));
  await inspector.getByRole('button', { name: 'Close inspector' }).click();
  await chooseOption(editedSet, { label: 'All tokens' });
  await search.fill('md.sys.color.primary');
  const value = page.getByRole('button', { name: 'Value for md.sys.color.primary', exact: true });
  await expect(value).toHaveText('{md.ref.palette.primary40}');
  await chooseOption(appearance, 'Dark');
  await expect(value).toHaveText('{md.ref.palette.primary80}');
  await expect(search).toHaveValue('md.sys.color.primary');
  await command(page, 'View', 'Compare variants');
  await page.getByRole('searchbox', { name: 'Search compared tokens' }).fill('md.sys.color.primary');
  const comparison = page.getByRole('table', { name: 'Variant comparison' });
  await expect(comparison.getByRole('button', { name: 'md.sys.color.primary', exact: true })).toBeVisible();
});

test('finds unresolved tokens and shows why the alias fails', async ({ page }) => {
  const benchmark = process.env['MD3_TOKEN_BENCHMARK'];
  const fallback = { name: 'reference.tokens.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    base: { $type: 'number', scale: { $root: { $value: 1 } } },
    role: { $type: 'number', gap: { $value: '{base.scale}' } },
  })) };
  const tokenPath = benchmark ? 'md.comp.assist-chip.label-text.weight' : 'role.gap';
  const rootPath = benchmark ? 'md.sys.typescale.label-large.weight.$root' : 'base.scale.$root';
  const unresolvedCount = benchmark ? 38 : 1;
  await page.setViewportSize({ width: 1075, height: 880 });
  await page.goto('/');
  if (benchmark) await command(page, 'File', 'Open Material 3 benchmark');
  else {
    const chooser = page.waitForEvent('filechooser');
    await command(page, 'File', 'Open files…');
    await (await chooser).setFiles(fallback);
  }
  await expect(page.getByText(benchmark ? '6,818 tokens' : '2 tokens', { exact: true })).toBeVisible();
  const toolbar = page.getByRole('main').getByRole('region', { name: 'Token commands' });
  const search = toolbar.getByRole('searchbox', { name: 'Search tokens in group' });
  await expect(search).toBeVisible();
  await expect(page.getByRole('banner').getByRole('searchbox')).toHaveCount(0);
  const unresolved = page.getByRole('button', { name: 'Unresolved (' + unresolvedCount + ')', exact: true });
  await unresolved.click();
  await expect(unresolved).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(benchmark ? '38 tokens' : '1 token', { exact: true })).toBeVisible();
  const token = page.getByRole('row').filter({ hasText: tokenPath });
  await token.getByText('Unresolved', { exact: true }).click();
  await token.getByRole('button', { name: 'Token actions for ' + tokenPath, exact: true }).press('Enter');
  await page.getByRole('menuitem', { name: 'References', exact: true }).click();
  await expect(page.getByText('Reference points to a group. Use {' + rootPath + '} to reference its root token.')).toBeVisible();
  await page.keyboard.press('Escape');
  const value = page.getByRole('button', { name: 'Value for ' + tokenPath, exact: true });
  await value.click();
  await expect(page.getByRole('dialog', { name: 'Link a token' })).toHaveCount(0);
  await value.press('F2');
  const picker = page.getByRole('dialog', { name: 'Link a token' });
  const referenceSearch = picker.getByRole('searchbox', { name: 'Search tokens' });
  await expect(referenceSearch).toBeFocused();
  await referenceSearch.fill(benchmark ? 'label large weight' : 'scale');
  await expect(picker.getByRole('button', { name: rootPath.replace(/\$root$/u, 'Group value'), exact: true })).toBeVisible();
  await referenceSearch.clear();
  const hierarchy = picker.getByRole('navigation', { name: 'Reference groups' });
  const branch = benchmark ? ['md', 'sys', 'typescale', 'label-large', 'weight'] : ['base', 'scale'];
  await branch.reduce(async (previous, group) => {
    await previous;
    await hierarchy.getByRole('button', { name: group, exact: true }).click();
  }, Promise.resolve());
  await picker.getByRole('button', { name: rootPath.replace(/\$root$/u, 'Group value'), exact: true }).click();
  expect(await picker.evaluate(node => node.matches(':modal'))).toBe(true);
  await picker.getByRole('button', { name: 'Link token', exact: true }).click();
  await expect(unresolved).toHaveCount(0);
  if (benchmark) await expect(page.getByRole('button', { name: 'Unresolved (37)', exact: true })).toHaveAttribute('aria-pressed', 'true');
  else await expect(page.getByText('2 tokens', { exact: true })).toBeVisible();
});

test('reflects sign-in in the editor and shows only the returned repositories', async ({ page }) => {
  let session: 'signed-out' | 'connected' | 'forbidden' = 'signed-out';
  let repositories = ['example/tokens', 'other/design-system'];
  await page.route('**/git/session', async (route) => {
    if (session === 'connected') await route.fulfill({ json: { login: 'designer', repositories } });
    else if (session === 'forbidden') await route.fulfill({ status: 403, json: { message: 'Access denied' } });
    else await route.fulfill({ status: 401, json: { message: 'Sign in' } });
  });
  await page.goto('/');
  await command(page, 'Integrations', 'Open GitHub repository…');
  await expect(page.getByRole('link', { name: 'Sign in to GitHub', exact: true })).toBeVisible();
  session = 'connected';
  await page.evaluate(() => {
    const channel = new BroadcastChannel('token-foundry-github');
    const notify = channel.postMessage.bind(channel);
    notify('ready');
    channel.close();
  });
  await expect(page.getByRole('dialog', { name: 'Open GitHub repository' }).getByText('Connected as @designer', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to GitHub', exact: true })).toHaveCount(0);
  await chooseOption(page.getByRole('combobox', { name: 'Repository', exact: true }), 'other/design-system');
  await expect(page.getByRole('combobox', { name: 'Repository', exact: true })).toHaveAttribute('data-select-value', 'other/design-system');
  repositories = ['example/tokens'];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('combobox', { name: 'Repository', exact: true })).toHaveAttribute('data-select-value', 'example/tokens');
  await expect(page.getByRole('option', { name: 'other/design-system', exact: true })).toHaveCount(0);
  session = 'forbidden';
  await page.reload();
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connect account', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Export token JSON', exact: true })).toBeDisabled();
});

test('edits cells, rewrites references, and reviews bulk move and group delete', async ({ page }) => {
  await page.route('**/git/session', (route) => route.fulfill({ status: 401, json: {} }));
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await command(page, 'File', 'Open files…');
  const dimension = { value: 8, unit: 'px' };
  await (await chooser).setFiles([
    { name: 'reference.tokens.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      reference: { $type: 'dimension', gap: { $value: dimension }, spare: { $value: dimension }, extra: { $value: dimension } },
    })) },
    { name: 'system.tokens.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      system: { $type: 'dimension', gap: { $value: '{reference.gap}' } },
      archive: {},
    })) },
  ]);
  const tokenName = page.getByRole('button', { name: 'Name for reference.gap', exact: true });
  const linkActions = page.getByRole('button', { name: /^Link reference for /u });
  await tokenName.click();
  const name = page.getByRole('textbox', { name: 'Token name', exact: true });
  await expect(name).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rename reference.gap', exact: true })).toHaveCount(0);
  await tokenName.press('F2');
  await expect(name).toBeFocused();
  await expect(linkActions).toHaveCount(0);
  await name.fill('compact');
  await expect(page.getByRole('rowheader').filter({ has: name })).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await name.press('Tab');
  const renameReview = page.getByRole('dialog', { name: 'Rename token' });
  await expect(renameReview.getByText('1 token · 2 files changed · 1 reference updated')).toBeVisible();
  await renameReview.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  const valueCell = page.getByRole('button', { name: 'Value for reference.compact', exact: true });
  await expect(valueCell).toBeFocused();
  await expect(linkActions).toHaveCount(1);
  await valueCell.press('F2');
  const value = page.getByRole('textbox', { name: 'Token value', exact: true });
  await expect(value).toBeFocused();
  await expect(linkActions).toHaveCount(0);
  await value.fill('bad dimension');
  await value.press('Enter');
  await expect(value).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert')).toContainText('Enter a value');
  await value.fill('12 px');
  await page.getByRole('button', { name: 'Name for reference.spare', exact: true }).click();
  await expect(value).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'system.gap' })).toContainText('{reference.compact}');
  await expect(page.getByRole('row').filter({ hasText: 'system.gap' })).toContainText('12 px');

  const typeCell = page.getByRole('button', { name: 'Type for reference.extra', exact: true });
  await typeCell.dblclick();
  await chooseOption(page.getByRole('combobox', { name: 'Token type', exact: true }), 'dimension');
  await expect(typeCell).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const linkValue = page.getByRole('button', { name: 'Value for reference.extra', exact: true });
  await linkValue.dblclick();
  await value.fill('{compact');
  const suggestions = page.getByRole('searchbox', { name: 'Search tokens', exact: true });
  await expect(suggestions).toHaveValue('compact');
  await expect(suggestions).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(linkValue).toHaveText('8 px');
  await expect(linkValue).toBeFocused();

  await page.getByRole('button', { name: 'Type for reference.spare', exact: true }).dblclick();
  await chooseOption(page.getByRole('combobox', { name: 'Token type', exact: true }), 'number');
  await value.fill('4');
  await value.press('Enter');
  await expect(page.getByRole('button', { name: 'Type for reference.spare', exact: true })).toHaveText('number');
  await page.getByRole('button', { name: 'Description for reference.spare', exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Scratch token');
  await page.getByRole('textbox', { name: 'Description', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Description for reference.spare', exact: true })).toHaveText('Scratch token');

  const descriptionCell = page.getByRole('button', { name: 'Description for reference.spare', exact: true });
  await descriptionCell.dblclick();
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Cancelled edit');
  await page.keyboard.press('Escape');
  await expect(descriptionCell).toHaveText('Scratch token');
  const toolbar = page.getByRole('region', { name: 'Token commands' });
  const spare = page.locator('[data-token-row="reference.spare"]').getByRole('checkbox');
  const extra = page.locator('[data-token-row="reference.extra"]').getByRole('checkbox');
  await expect(spare).toBeChecked();
  await extra.locator('xpath=ancestor::label').click();
  await expect(page.locator('.workspace-table-footer').getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Name for reference.compact', exact: true }).press('Shift+F10');
  await page.getByRole('menuitem', { name: 'References', exact: true }).click();
  const references = page.getByRole('complementary', { name: 'Token details' });
  await expect(references.getByText('reference.compact', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(references).toBeHidden();
  const search = toolbar.getByRole('searchbox');
  await search.fill('compact');
  await expect(page.locator('.workspace-table-footer').getByText('2 selected · 2 not shown', { exact: true })).toBeVisible();
  await search.clear();
  await expect(toolbar.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await page.getByRole('navigation', { name: 'Destination group' }).getByRole('button', { name: 'archive', exact: true }).click();
  await page.getByRole('button', { name: 'Review move' }).click();
  await page.getByText('Show file changes', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'File changes' })).toContainText('system.tokens.json');
  await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await page.getByRole('navigation', { name: 'Token groups' }).getByRole('button', { name: 'archive', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Name for archive.spare', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Actions for /u }).click();
  await page.getByRole('menuitem', { name: 'Delete group', exact: true }).click();
  await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Token groups' }).getByRole('button', { name: 'archive', exact: true })).toHaveCount(0);
  const rowCount = await page.getByRole('grid', { name: 'Tokens' }).getByRole('row').count();
  await page.getByRole('complementary', { name: 'Groups' }).getByRole('button', { name: 'Group actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New group', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New group' })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Tokens', includeHidden: true }).getByRole('row', { includeHidden: true })).toHaveCount(rowCount);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('replaces a reference with a raw value of a different type', async ({ page }) => {
  await page.goto('/');
  const value = page.getByRole('button', { name: 'Value for system.color.canvas', exact: true });
  await value.click();
  await value.press('F2');
  const finder = page.getByRole('dialog', { name: 'Link a token' });
  await finder.getByRole('button', { name: 'Enter a value' }).click();
  const raw = page.getByRole('dialog', { name: 'Enter a value' });
  const type = raw.getByRole('combobox', { name: 'Token type' });
  await expect(type).toBeFocused();
  await expect(type).toHaveAttribute('data-select-value', 'color');
  const fields = raw.getByRole('region', { name: 'Value', exact: true });
  const hex = fields.getByRole('textbox', { name: 'Token value', exact: true });
  const swatch = fields.getByLabel('Color preview', { exact: true });
  const blue = fields.getByRole('checkbox', { name: 'Include blue channel' });
  await hex.fill('#125E94');
  await blue.uncheck();
  await expect(hex).toBeDisabled();
  await expect(swatch).toBeVisible();
  await blue.check();
  await expect(hex).toHaveValue('#125E94');
  const opacity = fields.getByRole('checkbox', { name: 'Include opacity' });
  await expect(opacity).not.toBeChecked();
  await opacity.check();
  await expect(fields.getByRole('textbox', { name: 'Opacity', exact: true })).toBeEnabled();
  await expect(fields.getByRole('button', { name: 'Add sRGB fallback' })).toHaveCount(0);
  await expect(fields.getByText('Uncheck a channel', { exact: false })).toHaveCount(0);
  await chooseOption(type, 'fontFamily');
  await raw.getByRole('textbox', { name: 'Token value' }).fill('Noto Sans');
  await raw.getByRole('button', { name: 'Use value' }).click();
  await expect(raw).toBeHidden();
  await expect(value).toHaveText('Noto Sans');
  await expect(value).toBeFocused();
  const typeCell = page.getByRole('button', { name: 'Type for system.color.canvas', exact: true });
  await expect(typeCell).toHaveText('fontFamily');
  await command(page, 'Edit', 'Undo');
  await expect(value).toHaveText('{reference.color.paper}');
  await expect(typeCell).toHaveText('color');
  await command(page, 'Edit', 'Redo');
  await expect(value).toHaveText('Noto Sans');
  await expect(typeCell).toHaveText('fontFamily');
});

test('opens a diagnosed token from workspace diagnostics', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'invalid.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ motion: { delay: { $type: 'duration', $value: { value: 3, unit: 'px' } } } })),
  });
  await expect(page.getByRole('row').filter({ hasText: 'motion.delay' })).toContainText('Invalid');
  await command(page, 'View', 'Workspace issues');
  const dialog = page.getByRole('dialog', { name: 'Workspace issues' });
  const entry = dialog.getByRole('button', { name: /^motion\.delay/u });
  await expect(entry).toContainText('invalid.tokens.json');
  await expect(entry).toContainText('$value/unit');
  await entry.click();
  await expect(page.getByRole('button', { name: 'Name for motion.delay', exact: true })).toBeFocused();
});

test('keeps valid tokens available when a group has invalid metadata and children', async ({ page }) => {
  await page.goto('/');
  const filler = Object.fromEntries(Array.from({ length: 80 }, (_, index) =>
    ['token' + index, { $type: 'number', $value: index }]));
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'mixed.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      ...filler, spacing: { $type: 'dimension', $deprecated: [], gap: { $value: { value: 8, unit: 'px' } }, malformed: false },
    }, null, 2)),
  });
  await expect(page.getByRole('button', { name: 'Value for spacing.gap', exact: true })).toHaveText('8 px');
  await command(page, 'View', 'Workspace issues');
  const dialog = page.getByRole('dialog', { name: 'Workspace issues' });
  const deprecated = dialog.getByRole('button', { name: /^spacing.*\$deprecated/u });
  await expect(deprecated).toContainText('Error · mixed.tokens.json');
  await expect(dialog.getByRole('button', { name: /^spacing\.malformed/u })).toBeVisible();
  await deprecated.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'spacing', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Value for spacing.gap', exact: true })).toHaveText('8 px');

  await page.getByRole('button', { name: 'Issues (2)', exact: true }).click();
  await dialog.getByRole('button', { name: 'Open source for spacing · $deprecated', exact: true }).click();
  const sourceDialog = page.getByRole('dialog', { name: 'Edit token source' });
  const source = sourceDialog.getByRole('textbox', { name: 'Token source JSON' });
  await expect(source).toBeFocused();
  expect(await source.evaluate(input => input instanceof HTMLTextAreaElement ? input.value.slice(input.selectionStart, input.selectionEnd) : undefined)).toBe('[]');
  expect(await source.evaluate(input => input.scrollTop)).toBeGreaterThan(0);
  const fixed = JSON.stringify({ ...filler, spacing: { $type: 'dimension', $deprecated: false, gap: { $value: { value: 8, unit: 'px' } } } }, null, 2);
  await source.fill(fixed);
  await sourceDialog.getByRole('button', { name: 'Review source changes' }).click();
  const review = page.getByRole('dialog', { name: 'Review changes' });
  await review.getByRole('button', { name: 'Back to edit' }).click();
  await expect(source).toHaveValue(fixed);
  await sourceDialog.getByRole('button', { name: 'Review source changes' }).click();
  await review.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Issues (2)', exact: true })).toHaveCount(0);
});

test('repairs a malformed source without blocking edits in the healthy file', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'good.tokens.json', mimeType: 'application/json', buffer: Buffer.from('{"size":{"$type":"number","$value":1}}') },
    { name: 'broken.tokens.json', mimeType: 'application/json', buffer: Buffer.from('{"broken": }') },
  ]);
  const size = page.getByRole('button', { name: 'Value for size', exact: true });
  await expect(size).toHaveText('1');
  await size.dblclick();
  const value = page.getByRole('textbox', { name: 'Token value', exact: true });
  await value.fill('2');
  await value.press('Enter');
  await expect(size).toHaveText('2');
  await openSaveReview(page);
  const review = page.getByRole('dialog', { name: 'Review changes', exact: true });
  await expect(review.getByRole('status')).toContainText('Foundry needs valid JSON to check references');
  await expect(review.getByRole('status')).toContainText('broken.tokens.json');
  await review.getByRole('button', { name: 'Back to edit' }).click();
  await page.getByRole('navigation', { name: 'Foundry', exact: true }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: 'Issues (1)', exact: true }).click();
  const diagnostics = page.getByRole('dialog', { name: 'Workspace issues' });
  await diagnostics.getByRole('button', { name: /^broken\.tokens\.json Error/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit token source' });
  const source = dialog.getByRole('textbox', { name: 'Token source JSON' });
  await expect(source).toBeFocused();
  expect(await source.evaluate(input => input instanceof HTMLTextAreaElement ? input.selectionStart : null)).toBe(11);
  await source.fill('{"fixed":{"$type":"number","$value":9}}');
  await dialog.getByRole('button', { name: 'Review source changes' }).click();
  await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for fixed', exact: true })).toHaveText('9');
  await expect(size).toHaveText('2');
});

test('keeps a Forge edit draft when dismissing review and applies it only on confirmation', async ({ page }) => {
  await page.route('**/git/session', (route) => route.fulfill({ status: 401, json: {} }));
  await page.goto('/');
  await page.getByRole('complementary', { name: 'Groups' }).getByRole('button', { name: 'Group actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New group', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'New group' });
  const groupName = editor.getByRole('textbox', { name: 'Group name' });
  await expect(editor.locator('.md-outlined-text-field').getByRole('textbox', { name: 'Group name' })).toHaveCount(1);
  await expect(groupName).toBeFocused();
  await groupName.fill('pilot-group');
  await chooseOption(editor.getByRole('combobox', { name: 'Source file', exact: true }), 'reference.tokens.json');
  const review = page.getByRole('dialog', { name: 'Review changes' });
  const nativeReview = page.locator('dialog.review-dialog[open]');
  const created = page.getByRole('navigation', { name: 'Token groups' }).getByRole('button', { name: 'pilot-group', exact: true });
  const reviewAction = editor.getByRole('button', { name: 'Review changes', exact: true });
  await reviewAction.click();
  await expect(review).toBeVisible();
  await expect(nativeReview).toHaveCount(1);
  await review.getByText('Show file changes', { exact: true }).click();
  await expect(review.getByRole('region', { name: 'File changes' })).toContainText('pilot-group');
  await page.keyboard.press('Escape');
  await expect(nativeReview).toHaveCount(0);
  await expect(groupName).toHaveValue('pilot-group');
  await expect(created).toHaveCount(0);
  await reviewAction.click();
  await review.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(nativeReview).toHaveCount(0);
  await expect(groupName).toHaveValue('pilot-group');
  await reviewAction.click();
  await review.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(nativeReview).toHaveCount(0);
  await expect(created).toBeVisible();
  await command(page, 'Edit', 'Undo');
  await expect(created).toHaveCount(0);
  await command(page, 'Edit', 'Redo');
  await expect(created).toBeVisible();
});

test('keeps group navigation and selection usable in a narrow dark workspace', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route('**/git/session', (route) => route.fulfill({ status: 401, json: {} }));
  await page.goto('/');
  const light = await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(light);

  await page.getByRole('button', { name: 'Show groups sidebar' }).click();
  const tree = page.getByRole('navigation', { name: 'Token groups' });
  await tree.getByRole('button', { name: 'Expand reference', exact: true }).click();
  await expect(tree.getByRole('button', { name: 'color', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All tokens', exact: true })).toBeVisible();
  await tree.getByRole('button', { name: 'reference', exact: true }).click();
  await expect(tree).toBeHidden();
  await expect(page.getByRole('heading', { name: 'reference', exact: true })).toBeVisible();

  const table = page.getByRole('grid', { name: 'Tokens' });
  const all = table.getByRole('checkbox', { name: 'Select all visible tokens' });
  await table.locator('[data-token-row="reference.color.ink"]').getByRole('checkbox').click();
  await expect(all).toHaveJSProperty('indeterminate', true);
  const actions = page.getByRole('region', { name: 'Token commands' });
  const move = actions.getByRole('button', { name: 'Move', exact: true });
  const clear = page.locator('.workspace-table-footer').getByRole('button', { name: 'Clear selection' });
  await expect(move).toBeEnabled();
  await expect(clear).toBeInViewport();
  await clear.click();
  await expect(all).toHaveJSProperty('indeterminate', false);
  expect(await table.evaluate(node => {
    const container = node.parentElement;
    return !!container && container.scrollWidth <= container.clientWidth + 1 &&
      document.documentElement.scrollWidth === innerWidth;
  })).toBe(true);
});

test('keeps workspace branch expansion independent of folder selection', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByRole('navigation', { name: 'Token groups' });
  const reference = tree.getByRole('button', { name: 'reference', exact: true });
  const system = tree.getByRole('button', { name: 'system', exact: true });
  const context = page.getByRole('region', { name: 'Token controls' });
  const groupActions = page.getByRole('complementary', { name: 'Groups' });
  const referenceToggle = tree.getByRole('button', { name: /^(Expand|Collapse) reference$/u });
  const systemToggle = tree.getByRole('button', { name: /^(Expand|Collapse) system$/u });

  await reference.click();
  await expect(context.getByRole('heading')).toHaveText('reference');
  await expect(referenceToggle).toHaveAttribute('aria-expanded', 'false');
  await referenceToggle.press('Space');
  await expect(referenceToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(tree.getByRole('button', { name: 'All reference', exact: true })).toHaveCount(0);
  await systemToggle.click();
  await expect(reference).toHaveAttribute('aria-current', 'page');
  await expect(context.getByRole('heading')).toHaveText('reference');
  await system.click();
  await expect(referenceToggle).toHaveAttribute('aria-expanded', 'true');
  await referenceToggle.click();
  await expect(context.getByRole('heading')).toHaveText('system');
  await reference.click();
  await expect(context.getByRole('heading')).toHaveText('reference');
  await expect(referenceToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(systemToggle).toHaveAttribute('aria-expanded', 'true');
  const menu = groupActions.getByRole('button', { name: 'Actions for reference', exact: true });
  await expect(menu).toBeVisible();
  await reference.dblclick();
  await expect(referenceToggle).toHaveAttribute('aria-expanded', 'true');
  await tree.getByRole('button', { name: 'space', description: 'reference.space', exact: true }).click();
  const childMenu = groupActions.getByRole('button', { name: 'Actions for reference / space', exact: true });
  await expect(childMenu).toBeVisible();
});

test('resizes both panes and keeps the empty inspector open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await command(page, 'View', 'Show token details');
  const inspector = page.getByRole('complementary', { name: 'Token details' });
  await expect(inspector.getByText('Select a token to see its details.')).toBeVisible();
  const right = page.getByRole('slider', { name: 'Resize token details' });
  const initialInspectorWidth = (await inspector.boundingBox())?.width ?? 0;
  await right.press('ArrowLeft');
  await expect.poll(async () => (await inspector.boundingBox())?.width ?? 0).toBeGreaterThan(initialInspectorWidth);
  const groups = page.getByRole('complementary', { name: 'Groups' });
  const initialGroupWidth = (await groups.boundingBox())?.width ?? 0;
  const left = page.getByRole('slider', { name: 'Resize groups sidebar' });
  const handle = await left.boundingBox();
  if (!handle) throw new Error('Group resize handle is missing.');
  await page.mouse.move(handle.x + 4, handle.y + 40);
  await page.mouse.down();
  await page.mouse.move(handle.x + 52, handle.y + 40);
  await expect.poll(async () => (await groups.boundingBox())?.width ?? 0).toBeGreaterThan(initialGroupWidth);
  await page.mouse.up();
  await expect.poll(async () => (await groups.boundingBox())?.width ?? 0).toBeGreaterThan(initialGroupWidth);
  await groups.getByRole('button', { name: 'reference', exact: true }).click();
  await expect(inspector.getByText('Select a token to see its details.')).toBeVisible();

  const theme = page.locator('html');
  const startingTheme = await theme.getAttribute('data-theme');
  await page.getByRole('button', { name: startingTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode' }).click();
  await page.reload();
  await expect(theme).toHaveAttribute('data-theme', startingTheme === 'dark' ? 'light' : 'dark');
  await page.getByRole('region', { name: 'Token commands' }).getByRole('button', { name: 'New token', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New token' })).toBeVisible();
});

test('keeps workspace navigation and the token inspector usable at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.goto('/');
  const header = page.getByRole('banner');
  await expect(header.getByRole('button', { name: 'Review changes', exact: true })).toHaveText('Review changes');
  expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const navigation = page.getByRole('navigation', { name: 'Foundry' });
  await navigation.getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Workspace management' })).toBeVisible();
  await navigation.getByRole('button', { name: 'Tokens', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search tokens in group' });
  await expect(page.getByRole('button', { name: 'Clear token search' })).toHaveCount(0);
  await search.fill('ink');
  const clear = page.getByRole('button', { name: 'Clear token search' });
  await clear.hover();
  await expect(search).toBeFocused();
  await clear.click();
  await expect(search).toHaveValue('');
  await page.getByRole('button', { name: 'Token actions for reference.color.ink', exact: true }).press('Enter');
  await page.getByRole('menuitem', { name: 'References', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Token details' });
  await expect(inspector.getByText('system.color.text', { exact: true })).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Apply to workspace', exact: true })).toBeDisabled();
  const link = inspector.getByRole('button', { name: 'Link token' });
  await link.click();
  const finder = page.getByRole('dialog', { name: 'Link a token' });
  const referenceSearch = finder.getByRole('searchbox');
  await expect(referenceSearch).toBeFocused();
  expect(await finder.evaluate(node => node.matches(':modal') && node.getBoundingClientRect().width <= innerWidth)).toBe(true);
  await referenceSearch.fill('paper');
  await finder.getByRole('button', { name: 'reference.color.paper', exact: true }).click();
  await finder.getByRole('button', { name: 'Link token', exact: true }).click();
  await expect(finder).toBeHidden();
  await expect(link).toBeFocused();
  await expect(inspector.getByRole('textbox', { name: 'Token value' })).toHaveValue('{reference.color.paper}');
  await inspector.getByRole('textbox', { name: 'Token name' }).fill('dark-ink');
  await chooseOption(inspector.getByRole('combobox', { name: 'Token type' }), 'color');
  await inspector.getByRole('textbox', { name: 'Token value' }).fill('#123456');
  await inspector.getByRole('textbox', { name: 'Token description' }).fill('Ink for text');
  await inspector.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Rename token' });
  await expect(review).toContainText('1 reference updated');
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(inspector.getByRole('textbox', { name: 'Token name' })).toHaveValue('dark-ink');
  await expect(inspector.getByRole('textbox', { name: 'Token value' })).toHaveValue('#123456');
  await expect(inspector.getByRole('combobox', { name: 'Token type' })).toHaveAttribute('data-select-value', 'color');
  await expect(inspector.getByRole('textbox', { name: 'Token description' })).toHaveValue('Ink for text');
  await inspector.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await expect(inspector).toBeHidden();
  await expect(page.getByRole('button', { name: 'Value for reference.color.dark-ink', exact: true })).toHaveText('#123456');
  await expect(page.getByRole('button', { name: 'Value for system.color.text', exact: true })).toContainText('{reference.color.dark-ink}');
});

test('skip links enter the token grid and reach the open sheets', async ({ page }) => {
  await page.goto('/');
  const skip = page.getByRole('navigation', { name: 'Skip links' });
  const grid = page.getByRole('grid', { name: 'Tokens' });
  await page.keyboard.press('Tab');
  const gridLink = skip.getByRole('link', { name: 'Skip to token grid' });
  await expect(gridLink).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(skip.getByRole('link', { name: 'Skip to groups' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(gridLink).toBeFocused();
  await page.keyboard.press('Enter');
  const name = grid.getByRole('button', { name: 'Name for reference.color.ink' });
  await expect(name).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const value = grid.getByRole('button', { name: 'Value for reference.color.ink', exact: true });
  await expect(value).toBeFocused();

  await skip.getByRole('link', { name: 'Skip to groups' }).press('Enter');
  await expect(page.getByRole('complementary', { name: 'Groups', exact: true })).toBeFocused();
  await gridLink.press('Enter');
  await expect(value).toBeFocused();

  await value.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Edit token', exact: true }).click();
  const sheet = page.getByRole('complementary', { name: 'Token details' });
  await expect(sheet.getByRole('button', { name: 'Close inspector' })).toBeFocused();
  await skip.getByRole('link', { name: 'Skip to token details' }).press('Enter');
  await expect(sheet).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(value).toBeFocused();
});

test('a single tap on a narrow grid selects the row and keeps arrow navigation', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 850 });
  await page.goto('/');
  const grid = page.getByRole('grid', { name: 'Tokens' });
  const name = grid.getByRole('button', { name: 'Name for reference.color.ink' });
  const sheet = page.getByRole('complementary', { name: 'Token details' });
  await name.click();
  await expect(name).toBeFocused();
  await expect(grid.getByRole('row', { selected: true })).toHaveCount(1);
  await expect(sheet).toBeHidden();
  await page.keyboard.press('ArrowDown');
  const paper = grid.getByRole('button', { name: 'Name for reference.color.paper' });
  await expect(paper).toBeFocused();
  const toolbarEdit = page.getByRole('button', { name: 'Edit token', exact: true });
  await toolbarEdit.click();
  await expect(sheet.getByRole('textbox', { name: 'Token name' })).toHaveValue('paper');
  await sheet.getByRole('button', { name: 'Close inspector' }).click();
  await expect(toolbarEdit).toBeFocused();
  await paper.click();
  await expect(paper).toBeFocused();
  await expect(sheet).toBeHidden();
});

test('Alt key tips jump between panes and activate existing commands', async ({ page }) => {
  await page.goto('/');
  const grid = page.getByRole('grid', { name: 'Tokens' });
  const cell = grid.getByRole('button', { name: 'Value for reference.color.paper', exact: true });
  const tips = page.locator('.workspace-key-tips');
  const status = page.getByRole('status').filter({ hasText: /^Key tips/u });
  await cell.focus();

  await page.keyboard.press('Alt');
  await expect(tips.getByText('G', { exact: true })).toBeVisible();
  await expect(status).toContainText('T for Tokens');
  await page.keyboard.press('g');
  await expect(page.getByRole('complementary', { name: 'Groups' }).getByRole('button', { name: 'All tokens' })).toBeFocused();
  await page.keyboard.press('Alt');
  await page.keyboard.press('t');
  await expect(cell).toBeFocused();

  await page.keyboard.press('Alt');
  await page.keyboard.press('f');
  await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
  await expect(status).toContainText('O for Open files');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'File' })).toBeHidden();
  await expect(status).toContainText('F for File');
  await page.keyboard.press('Escape');
  await expect(cell).toBeFocused();

  await page.keyboard.press('Alt');
  await expect(status).toContainText('N for New token');
  await expect(status).not.toContainText('Move, duplicate or delete');
  await page.keyboard.press('n');
  await expect(page.getByRole('dialog', { name: 'New token' })).toBeVisible();
  await page.keyboard.press('Alt');
  await expect(tips).toBeHidden();
  await page.keyboard.press('Escape');

  await command(page, 'Help', 'Show key tips');
  await expect(tips.getByText('I', { exact: true })).toBeVisible();
  await page.keyboard.press('k');
  const help = page.getByRole('menu', { name: 'Help' });
  await expect(help).toBeVisible();
  await expect(status).toContainText('for Keyboard shortcuts');
  const shortcut = (await status.textContent())?.match(/([A-Z0-9]) for Keyboard shortcuts/u)?.[1];
  if (!shortcut) throw new Error('Keyboard shortcuts has no key tip');
  await page.keyboard.press(shortcut.toLowerCase());
  const gridHelp = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(gridHelp).toBeVisible();
  await expect(tips).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(gridHelp).toBeHidden();

  await page.keyboard.press('Alt');
  await expect(tips.getByText('D', { exact: true })).toBeVisible();
  await page.keyboard.press('d');
  const details = page.getByRole('complementary', { name: 'Token details' });
  await expect(details.getByRole('button', { name: 'Close inspector' })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt');
  await page.keyboard.press('w');
  await expect(page.getByRole('main', { name: 'Workspace management' })).toBeFocused();
  await page.getByRole('button', { name: 'New source file', exact: true }).scrollIntoViewIfNeeded();
  await page.keyboard.press('Alt');
  await expect(status).toContainText('N for New source file');
  await page.keyboard.press('n');
  const source = page.getByRole('dialog', { name: 'New source file' });
  await expect(source).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(source).toBeHidden();
  await page.keyboard.press('Alt');
  await page.keyboard.press('v');
  await expect(page.getByRole('main', { name: 'Variants' }).getByRole('heading', { name: 'Variants', exact: true })).toBeFocused();
  await page.keyboard.press('Alt');
  await page.keyboard.press('t');
  await expect(cell).toBeFocused();
});

test('separates toolbar key tips and cancels tips on ordinary navigation', async ({ page }) => {
  await page.goto('/');
  const grid = page.getByRole('grid', { name: 'Tokens' });
  const cell = grid.getByRole('button', { name: 'Name for reference.color.ink', exact: true });
  const next = grid.getByRole('button', { name: 'Name for reference.color.paper', exact: true });
  const tips = page.locator('.workspace-key-tips');
  const status = page.getByRole('status').filter({ hasText: /^Key tips/u });
  await cell.click();
  await page.keyboard.press('Alt');
  await expect(status).toContainText('D for Edit token');
  await expect(status).toContainText('N for New token');
  await expect(status).toContainText('B for Bulk edit');
  await expect(tips.getByText('G', { exact: true })).toBeVisible();
  await page.keyboard.press('b');
  await expect(status).toContainText('R for Rename');
  await expect(status).not.toContainText(/Edit token|New token|Move/u);
  await page.keyboard.press('Escape');
  await page.keyboard.press('m');
  await expect(status).toContainText('M for Move');
  await expect(status).not.toContainText(/Rename|Edit token|New token/u);
  await page.keyboard.press('ArrowDown');
  await expect(tips).toBeHidden();
  await expect(next).toBeFocused();

  await page.keyboard.press('Alt');
  await page.keyboard.press('h');
  await expect(page.getByRole('menu', { name: 'Group actions' })).toBeVisible();
  await expect(status).toContainText('N for New group');
  await page.keyboard.press('ArrowDown');
  await expect(tips).toBeHidden();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt');
  await page.keyboard.press('t');
  await expect(next).toBeFocused();

  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByRole('menu', { name: 'Token actions for reference.color.paper' })).toBeVisible();
  await expect(status).toContainText('E for Edit token');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Token actions for reference.color.paper' })).toBeHidden();
  await expect(next).toBeFocused();
});

test('Tokens starts in the grid and menus only show their own key tips', async ({ page }) => {
  await page.goto('/');
  const controls = page.getByRole('region', { name: 'Token controls' });
  const grid = page.getByRole('grid', { name: 'Tokens' });
  const lastCell = grid.getByRole('button', { name: 'Value for reference.color.paper', exact: true });
  const skip = page.getByRole('navigation', { name: 'Skip links' });
  const toolbar = page.getByRole('toolbar', { name: 'Workspace commands' });
  const rail = page.getByRole('navigation', { name: 'Foundry' });

  await expect(grid).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(grid.getByRole('button', { name: 'Name for reference.color.ink', exact: true })).toBeFocused();
  await lastCell.focus();
  await page.keyboard.press('Alt');
  await page.keyboard.press('c');
  await expect(controls).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(controls.getByRole('button', { name: 'Hide groups sidebar', exact: true })).toBeFocused();

  await rail.getByRole('button', { name: 'Variants', exact: true }).click();
  await page.keyboard.press('Alt');
  await page.keyboard.press('t');
  await expect(lastCell).toBeFocused();
  await rail.getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(lastCell).toBeFocused();
  await rail.getByRole('button', { name: 'Workspace', exact: true }).click();
  await skip.getByRole('link', { name: 'Skip to token grid' }).press('Enter');
  await expect(lastCell).toBeFocused();

  await toolbar.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'View' }).getByRole('menuitem', { name: /go to token/u })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await toolbar.getByRole('button', { name: 'File', exact: true }).click();
  const fileMenu = page.getByRole('menu', { name: 'File' });
  const status = page.getByRole('status').filter({ hasText: /^Key tips/u });
  await expect(fileMenu).toBeVisible();
  await expect(status).toContainText('O for Open files');
  await expect(status).not.toContainText(/for (Tokens|Token grid|Focus grid)/u);
  await expect(page.locator('.workspace-key-tips kbd')).toHaveCount(0);
  await page.keyboard.press('Alt');
  await page.keyboard.press('j');
  await expect(fileMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(fileMenu).toBeHidden();
});

test('row and group menus show shortcut letters and can be skipped', async ({ page }) => {
  await page.goto('/');
  const cell = page.getByRole('button', { name: 'Name for reference.color.paper', exact: true });
  const menu = page.getByRole('menu', { name: 'Token actions for reference.color.paper' });
  await cell.click();
  await cell.press('Alt+ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Edit token', exact: true })).toBeFocused();
  await expect(menu.getByRole('menuitem', { name: 'Edit token', exact: true })).toHaveAttribute('aria-keyshortcuts', 'E');
  expect(await menu.getByRole('menuitem', { name: 'Edit token', exact: true }).evaluate(item =>
    getComputedStyle(item, '::after').content)).toContain('"E"');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'References', exact: true })).toBeFocused();
  await expect(menu.getByRole('menuitem', { name: 'References', exact: true })).toHaveAttribute('aria-keyshortcuts', 'R');
  await page.keyboard.press('Shift+Tab');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'Token actions', exact: true }).getByRole('button', { name: 'Edit token', exact: true })).toBeFocused();

  await cell.press('Alt+ArrowDown');
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(page.locator('.workspace-table-footer').getByRole('button', { name: 'Clear selection', exact: true })).toBeFocused();

  await cell.click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Edit token', exact: true })).toBeFocused();
  await page.keyboard.press('e');
  await expect(page.getByRole('button', { name: 'Close inspector' })).toBeFocused();

  const groups = page.getByRole('complementary', { name: 'Groups' });
  await groups.getByRole('button', { name: 'Group actions' }).press('ArrowDown');
  await expect(page.getByRole('menu', { name: 'Group actions' }).getByRole('menuitem', { name: 'New group', exact: true })).toHaveAttribute('aria-keyshortcuts', 'N');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menu', { name: 'Group actions' })).toBeHidden();
  await expect(groups.getByRole('button', { name: 'All tokens' })).toBeFocused();
});

test('tabs between rail and toolbar groups and skips the grid column handles', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: 'Foundry' });
  const tokens = rail.getByRole('button', { name: 'Tokens', exact: true });
  const workspace = rail.getByRole('button', { name: 'Workspace', exact: true });
  await tokens.focus();
  await page.keyboard.press('ArrowDown');
  await expect(rail.getByRole('button', { name: 'Variants', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(workspace).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(rail.getByRole('button', { name: /Switch to .* mode/u })).toBeFocused();

  const grid = page.getByRole('grid', { name: 'Tokens' });
  const cell = grid.getByRole('button', { name: 'Name for reference.color.ink', exact: true });
  await cell.click();
  const fieldActions = page.getByRole('toolbar', { name: 'Edit selected token fields' });
  const structureActions = page.getByRole('toolbar', { name: 'Move, duplicate or delete selected tokens' });
  const tokenActions = page.getByRole('toolbar', { name: 'Token actions', exact: true });
  const rename = fieldActions.getByRole('button', { name: 'Rename', exact: true });
  const move = structureActions.getByRole('button', { name: 'Move', exact: true });
  const edit = tokenActions.getByRole('button', { name: 'Edit token', exact: true });
  await rename.focus();
  await page.keyboard.press('ArrowRight');
  await expect(fieldActions.getByRole('button', { name: 'Change value', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(move).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(edit).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tokenActions.getByRole('button', { name: 'New token', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cell).toBeFocused();

  const nameColumn = grid.getByRole('columnheader', { name: 'Name', exact: true });
  const initial = await nameColumn.boundingBox();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect(cell).toBeFocused();
  expect((await nameColumn.boundingBox())?.width ?? 0).toBeGreaterThan(initial?.width ?? 0);
});

test('the grid has one Tab stop and blank clicks preserve the active cell and checked rows', async ({ page }) => {
  await page.goto('/');
  const grid = page.getByRole('grid', { name: 'Tokens' });
  const container = page.locator('[data-slot="table-container"]').filter({ has: grid });
  const first = grid.getByRole('button', { name: 'Name for reference.color.ink', exact: true });
  const remembered = grid.getByRole('button', { name: 'Value for reference.color.paper', exact: true });
  const checked = grid.getByRole('row', { selected: true });
  const names = () => checked.evaluateAll(rows => rows.map(row => row.getAttribute('data-token-row')));
  const tokenActions = page.getByRole('toolbar', { name: 'Token actions', exact: true });
  const edit = tokenActions.getByRole('button', { name: 'Edit token', exact: true });
  const clear = page.getByRole('button', { name: 'Clear selection' });

  await first.press('Space');
  await remembered.press('Space');
  const expected = ['reference.color.ink', 'reference.color.paper'];
  expect(await names()).toEqual(expected);

  const tableBox = await grid.boundingBox();
  const containerBox = await container.boundingBox();
  if (!tableBox || !containerBox || tableBox.y + tableBox.height + 12 >= containerBox.y + containerBox.height) {
    throw new Error('The grid needs visible blank space under its rows');
  }
  await page.mouse.click(containerBox.x + 24, tableBox.y + tableBox.height + 12);
  await expect(remembered).toBeFocused();
  await page.locator('.workspace-table-footer').getByText(/^10 tokens$/u).click();
  await expect(remembered).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(clear).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-workspace-name]')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(clear).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(remembered).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(edit).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(remembered).toBeFocused();
  const group = page.getByRole('complementary', { name: 'Groups' });
  const groupActions = group.getByRole('button', { name: 'Group actions' });
  await groupActions.press('ArrowDown');
  const groupMenu = page.getByRole('menu', { name: 'Group actions' });
  await expect(groupMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(groupMenu).toBeHidden();
  await expect(groupActions).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(remembered).toBeFocused();
  await edit.press('Escape');
  await expect(remembered).toBeFocused();
  await expect(grid.locator('[tabindex="0"]')).toHaveCount(1);
  expect(await names()).toEqual(expected);

  await first.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  const selectAll = grid.getByRole('checkbox', { name: 'Select all visible tokens' });
  await expect(selectAll).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(edit).toBeFocused();
  expect(await names()).toEqual(expected);
});

test('key tip menus support native keyboard navigation and dismissal', async ({ page }) => {
  await page.goto('/');
  const cell = page.getByRole('button', { name: 'Name for reference.color.ink', exact: true });
  const menu = page.getByRole('menu', { name: 'View', exact: true });
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  const toolbar = page.getByRole('toolbar', { name: 'Workspace commands' });
  const file = toolbar.getByRole('button', { name: 'File', exact: true });
  const helpTrigger = toolbar.getByRole('button', { name: 'Help', exact: true });
  await file.focus();
  await page.keyboard.press('ArrowRight');
  await expect(toolbar.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(helpTrigger).toBeFocused();
  await page.keyboard.press('Tab');
  const tokens = page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens' });
  await expect(tokens).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(helpTrigger).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const helpMenu = page.getByRole('menu', { name: 'Help' });
  await expect(helpMenu.getByRole('menuitem', { name: 'Keyboard shortcuts' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(helpMenu.getByRole('menuitem', { name: 'Show key tips' })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(help).toBeVisible();
  await expect(help.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
  await expect(help.getByRole('heading', { name: 'Menus and toolbars' })).toBeVisible();
  await expect(help.getByRole('heading', { name: 'Token grid', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  const items = menu.locator('[role="menuitem"]:not([aria-disabled="true"])');

  await cell.focus();
  await page.keyboard.press('Alt');
  await page.keyboard.press('i');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(page.locator('.workspace-key-tips')).toBeHidden();
  const banner = page.getByRole('banner');
  await expect(tokens).toBeFocused();

  await banner.getByRole('button', { name: 'View', exact: true }).press('ArrowDown');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Skip links' }).getByRole('link', { name: 'Skip to groups' })).toBeFocused();

  await cell.focus();
  await page.keyboard.press('Alt');
  await page.keyboard.press('i');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('.workspace-key-tips')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cell).toBeFocused();
});

test('key tips preserve typing and modifier chords in token search', async ({ page }) => {
  await page.goto('/');
  const search = page.getByRole('searchbox', { name: 'Search tokens in group' });
  const tips = page.locator('.workspace-key-tips');
  await search.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(tips).toBeHidden();
  await page.keyboard.press('Alt');
  await expect(tips.getByText('S', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
  await page.keyboard.type('ink');
  await expect(search).toHaveValue('ink');
});

test('grid shortcuts jump to edges, select rows and open token actions', async ({ page }) => {
  await page.goto('/');
  const grid = page.getByRole('grid', { name: 'Tokens' });
  const firstCell = grid.getByRole('button', { name: 'Name for reference.color.ink', exact: true });
  const firstValue = grid.getByRole('button', { name: 'Value for reference.color.ink', exact: true });
  const lastValue = grid.getByRole('button', { name: 'Value for system.space.panel-padding', exact: true });
  const lastCheckbox = grid.locator('[data-token-row="system.space.panel-padding"]').getByRole('checkbox');
  const menu = page.getByRole('menu', { name: 'Token actions for system.space.panel-padding' });

  await firstValue.focus();
  await page.keyboard.press('Control+ArrowLeft');
  await expect(firstCell).toBeFocused();
  await page.keyboard.press('Control+ArrowRight');
  await expect(grid.getByRole('button', { name: 'Description for reference.color.ink', exact: true })).toBeFocused();
  await firstValue.press('Control+Shift+ArrowDown');
  await expect(lastValue).toBeFocused();
  await expect(grid.getByRole('row', { selected: true })).toHaveCount(10);
  await lastCheckbox.press('Shift+Space');
  await expect(lastCheckbox).toBeChecked();
  await expect(grid.getByRole('row', { selected: true })).toHaveCount(1);

  await lastCheckbox.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lastCheckbox).toBeFocused();

  await grid.getByRole('checkbox', { name: 'Select all visible tokens' }).press('Alt+ArrowDown');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lastCheckbox).toBeFocused();

  await lastValue.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lastValue).toBeFocused();

  await command(page, 'Help', 'Keyboard shortcuts');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toContainText('Alt + Down or Shift + F10');
});

test('extends and shrinks keyboard row ranges while preserving checked rows', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'five.tokens.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(
      Object.fromEntries([1, 2, 3, 4, 5].map(n => ['row-' + n, { $type: 'number', $value: n }]))
    )),
  });
  const grid = page.getByRole('grid', { name: 'Tokens' });
  const cell = (n: number) => grid.getByRole('button', { name: 'Name for row-' + n, exact: true });
  const checkbox = (n: number) => grid.getByRole('checkbox', { name: 'Select row Name for row-' + n, exact: true });
  const checked = async (...expected: number[]) => {
    await expect(grid.getByRole('row', { selected: true })).toHaveCount(expected.length);
    await Promise.all([1, 2, 3, 4, 5].map(n => expect(checkbox(n)).toBeChecked({ checked: expected.includes(n) })));
  };
  async function markFirstAndFocusThird() {
    await checkbox(1).check();
    await cell(1).press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(cell(3)).toBeFocused();
    await checked(1);
  }

  await markFirstAndFocusThird();
  await page.keyboard.press('Control+Shift+ArrowDown');
  await expect(cell(5)).toBeFocused();
  await checked(1, 3, 4, 5);
  await page.keyboard.press('Escape');

  await markFirstAndFocusThird();
  await page.keyboard.press('Control+Space');
  await checked(1, 3);
  await page.keyboard.press('Control+Shift+ArrowDown');
  await checked(1, 3, 4, 5);
  await page.keyboard.press('Shift+ArrowUp');
  await checked(1, 3, 4);
  await page.keyboard.press('Shift+ArrowUp');
  await checked(1, 3);
  await page.keyboard.press('Shift+ArrowUp');
  await checked(1, 2, 3);
  await page.keyboard.press('Escape');

  await markFirstAndFocusThird();
  await page.keyboard.press('Control+Space');
  await page.keyboard.press('Shift+ArrowDown');
  await checked(1, 3, 4);
  await page.keyboard.press('Shift+ArrowDown');
  await checked(1, 3, 4, 5);
  await page.keyboard.press('Shift+ArrowUp');
  await checked(1, 3, 4);
  await page.keyboard.press('Escape');

  await markFirstAndFocusThird();
  await page.keyboard.press('Shift+ArrowDown');
  await checked(1, 3, 4);
  await page.keyboard.press('Shift+ArrowDown');
  await checked(1, 3, 4, 5);
  await page.keyboard.press('Shift+ArrowUp');
  await checked(1, 3, 4);
  // A plain move ends the range. The next Shift gesture has a new baseline.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+ArrowUp');
  await checked(1, 3, 4, 5);
  await page.keyboard.press('Escape');

  await checkbox(1).check();
  await checkbox(2).check();
  await cell(1).focus();
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.down('Space');
  await checked(1, 2);
  await page.keyboard.press('ArrowDown');
  await checked(1, 2, 3, 4, 5);
  await page.keyboard.up('Space');
  await page.keyboard.down('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.up('Space');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await expect(cell(1)).toBeFocused();
  await checked(1, 2);
});

test('keeps the same range anchor after selecting disjoint rows by mouse or Space', async ({ page }) => {
  await page.goto('/');
  const rows = page.getByRole('grid', { name: 'Tokens' }).locator('[data-token-row]');
  const cell = (row: number) => rows.nth(row - 1).locator('[data-edit-column="name"]');
  const checked = () => rows.evaluateAll(items => items.flatMap((item, index) =>
    item.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ? [index + 1] : []));
  await expect(rows).toHaveCount(10);

  async function reverseRange(mark: (row: number) => Promise<void>) {
    await mark(1);
    await mark(3);
    await mark(4);
    await mark(5);
    await mark(6);
    await mark(8);
    await expect.poll(checked).toEqual([1, 3, 4, 5, 6, 8]);
    await page.keyboard.press('Control+Shift+ArrowDown');
    await expect.poll(checked).toEqual([1, 3, 4, 5, 6, 8, 9, 10]);
    await page.keyboard.press('Control+Shift+ArrowUp');
    await expect.poll(checked).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await page.keyboard.press('Escape');
    await expect.poll(checked).toEqual([]);
  }

  await reverseRange(row => cell(row).press('Space'));
  await reverseRange(row => rows.nth(row - 1).getByRole('checkbox').check());
  await reverseRange(row => cell(row).click({ modifiers: ['Control'] }));

  // Replay the mixed selection shown in the recording.
  await cell(1).click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(checked).toEqual([1, 3, 4, 5, 6]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(cell(10)).toBeFocused();
  await expect.poll(checked).toEqual([1, 3, 4, 5, 6, 8, 9, 10]);
  // Pressing Down at the bottom leaves focus where it is.
  await page.keyboard.press('ArrowDown');
  await expect(cell(10)).toBeFocused();
  await page.keyboard.press('Control+Shift+ArrowUp');
  await expect(cell(1)).toBeFocused();
  await expect.poll(checked).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  await page.keyboard.press('Escape');

  await cell(5).press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(cell(7)).toBeFocused();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(checked).toEqual([5, 7, 8, 9, 10]);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(cell(3)).toBeFocused();
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(checked).toEqual([2, 3, 5, 7, 8, 9, 10]);
  await page.keyboard.press('Control+Shift+ArrowDown');
  await expect(cell(10)).toBeFocused();
  await expect.poll(checked).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
});

test('keeps keyboard focus in the grid independently of checked rows', async ({ page }) => {
  await page.route('**/git/session', route => route.fulfill({ status: 401, json: {} }));
  await page.goto('/');
  const grid = page.getByRole('grid', { name: 'Tokens' });
  const name = (path: string) => grid.getByRole('button', { name: 'Name for reference.color.' + path, exact: true });
  const check = (path: string) => grid.locator('[data-token-row="reference.color.' + path + '"]').getByRole('checkbox');
  await expect(grid.getByRole('gridcell').filter({ hasText: /^0$/u })).toHaveCount(0);
  await name('ink').click();
  await expect(check('ink')).toBeChecked();
  await name('ocean').click({ modifiers: ['Shift'] });
  await expect(check('paper')).toBeChecked();
  await expect(check('ocean')).toBeChecked();
  await page.keyboard.press('Shift+ArrowUp');
  await expect(name('paper')).toBeFocused();
  await expect(check('ocean')).not.toBeChecked();
  await page.keyboard.press('Shift+ArrowRight');
  const paperValue = grid.getByRole('button', { name: 'Value for reference.color.paper', exact: true });
  await expect(paperValue).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Edit token', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Token actions for reference.color.paper' })).toBeHidden();
  await expect(paperValue).toBeFocused();
  await expect(check('ink')).toBeChecked();
  await expect(check('paper')).toBeChecked();
  await page.keyboard.press('Space');
  await expect(check('paper')).not.toBeChecked();
  await name('paper').click({ modifiers: ['Control'] });
  await expect(check('paper')).toBeChecked();
  await name('paper').click({ modifiers: ['Control'] });
  await expect(check('paper')).not.toBeChecked();
  await name('ink').click();
  await page.keyboard.press('ArrowLeft');
  await expect(check('ink')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(check('paper')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(check('paper')).toBeChecked();
  await page.keyboard.press('ArrowDown');
  await expect(check('ocean')).toBeFocused();
  await expect(check('ocean')).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(check('paper')).not.toBeChecked();
  await expect(check('ocean')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(check('ocean')).not.toBeFocused();
  await page.keyboard.press('Tab');
  await expect(check('ocean')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(name('ocean')).toBeFocused();
  await page.keyboard.press('F2');
  await expect(page.getByRole('textbox', { name: 'Token name' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(name('ocean')).toBeFocused();
});

test('opens and dismisses command menus with the keyboard', async ({ page }) => {
  await page.route('**/git/session', route => route.fulfill({ status: 401, json: {} }));
  await page.goto('/');
  const file = page.getByRole('button', { name: 'File', exact: true });
  await file.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'File', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'Open files…' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Open folder…' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(file).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'View', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const help = page.getByRole('banner').getByRole('button', { name: 'Help', exact: true });
  await expect(help).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Keyboard shortcuts', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Tokens', exact: true })).toBeFocused();
});

test('reviews group inheritance and restores an overridden token', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'inheritance.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      base: {
        $type: 'number', $description: 'Shared spacing', $deprecated: 'Use new spacing',
        $extensions: { 'vendor.spacing': { scale: 2 } }, $root: { $value: 2 }, nested: { gap: { $value: 8 } },
      },
      derived: {},
    })),
  });
  await page.getByRole('button', { name: 'derived', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for derived', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit group metadata', exact: true }).click();
  await chooseOption(page.getByRole('combobox', { name: 'Inherit from group', exact: true }), { label: 'base · inheritance.tokens.json' });
  await page.getByRole('button', { name: 'Review metadata changes', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review changes', exact: true })
    .getByRole('button', { name: 'Apply to workspace', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Value for derived.$root', exact: true })).toHaveText('2');
  await page.getByRole('button', { name: 'Actions for derived', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit group metadata', exact: true }).click();
  const metadata = page.getByRole('dialog', { name: 'Group metadata', exact: true });
  await expect(metadata.getByText('Inherited description · Shared spacing', { exact: true })).toBeVisible();
  await metadata.getByText('Advanced metadata', { exact: true }).click();
  await metadata.getByText('Effective vendor extensions', { exact: true }).click();
  await expect(metadata.locator('pre')).toContainText('vendor.spacing');
  await chooseOption(metadata.getByRole('combobox', { name: 'Default type', exact: true }), 'color');
  await metadata.getByRole('button', { name: 'Review metadata changes' }).click();
  const invalidReview = page.getByRole('dialog', { name: 'Review changes', exact: true });
  await expect(invalidReview.getByRole('button', { name: 'Apply to workspace', exact: true })).toBeDisabled();
  await invalidReview.getByText('Effective type changes (2)', { exact: true }).click();
  await expect(invalidReview.getByText('derived.$root · number → color', { exact: true })).toBeVisible();
  await invalidReview.getByRole('button', { name: 'Back to edit' }).click();
  await metadata.getByRole('button', { name: 'Cancel', exact: true }).click();

  const value = page.getByRole('button', { name: 'Value for derived.nested.gap', exact: true });
  await expect(value).toHaveText('8');
  await value.dblclick();
  const input = page.getByRole('textbox', { name: 'Token value', exact: true });
  await input.fill('12');
  await input.press('Enter');
  await page.getByRole('dialog', { name: 'Review changes', exact: true })
    .getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(value).toHaveText('12');
  await expect(value).toBeFocused();

  await value.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Use inherited value', exact: true }).click();
  await page.getByRole('dialog', { name: 'Use inherited value', exact: true })
    .getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(value).toHaveText('8');
});

test('creates a root token and links to it by its explicit path', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'roots.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ spacing: { $type: 'number', small: { $value: 4 } } })),
  });
  await page.getByRole('button', { name: 'spacing', exact: true }).click();
  await command(page, 'Edit', 'Add group value');
  const create = page.getByRole('dialog', { name: 'Add group value', exact: true });
  await create.getByRole('textbox', { name: 'Token value', exact: true }).fill('8');
  await create.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review changes', exact: true })
    .getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'spacing', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Value for spacing.$root', exact: true })).toHaveText('8');
  await page.getByRole('button', { name: 'Name for spacing.small', exact: true }).click();
  await page.getByRole('button', { name: 'Link reference for spacing.small', exact: true }).click();
  const finder = page.getByRole('dialog');
  await finder.getByRole('searchbox', { name: 'Search tokens' }).fill('group value');
  await finder.getByRole('button', { name: 'spacing.Group value', exact: true }).click();
  await finder.getByRole('button', { name: 'Link token', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for spacing.small', exact: true })).toHaveText('{spacing.$root}');
  await expect(page.getByRole('button', { name: 'Resolved value for spacing.small', exact: true })).toHaveText('8');
});

test('links to a compatible field in another source and inspects the authored pointer', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'palette.tokens.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      palette: { iris: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.25, 0.5, 0.75] } } },
    })) },
    { name: 'theme.tokens.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      theme: { channel: { $type: 'number', $value: 1 }, alias: { $value: '{theme.channel}' } },
    })) },
  ]);
  await page.getByRole('button', { name: 'Name for theme.channel', exact: true }).click();
  await page.getByRole('button', { name: 'Link reference for theme.channel', exact: true }).click();
  const finder = page.getByRole('dialog', { name: 'Link a token' });
  await finder.getByRole('searchbox', { name: 'Search tokens' }).fill('palette');
  await finder.getByRole('button', { name: 'Browse fields in palette.iris', exact: true }).click();
  await finder.getByRole('button', { name: /Components › Red/u }).click();
  await finder.getByRole('button', { name: 'Link token', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resolved value for theme.channel', exact: true })).toHaveText('0.25');
  await expect(page.getByRole('button', { name: 'Resolved value for theme.alias', exact: true })).toHaveText('0.25');
  await command(page, 'View', 'Show token details');
  const inspector = page.getByRole('complementary', { name: 'Token details' });
  await inspector.getByText('Link details', { exact: true }).click();
  await expect(inspector.getByText('palette.tokens.json#/palette/iris/%24value/components/0', { exact: true })).toBeVisible();
  await expect(inspector.getByText('palette.tokens.json · palette / iris / $value / components / 0', { exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: 'palette.iris', exact: true }).click();
  await expect(inspector.getByRole('list', { name: 'Used by', exact: true })).toContainText('theme.channel');
  await expect(inspector.getByRole('list', { name: 'Indirectly used by', exact: true })).toContainText('theme.alias');
});

test('reviews the references a deletion would break before applying', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'links.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      first: { $type: 'number', $value: 2 },
      second: { $value: '{first}' },
      third: { $ref: '#/second/$value' },
    })),
  });
  await page.getByRole('button', { name: 'Name for first', exact: true }).click();
  await page.getByRole('button', { name: 'Token actions for first', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete token', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Delete token', exact: true });
  await expect(review.getByText('second · Reference target is missing: first', { exact: true })).toBeVisible();
  await expect(review.getByText('third · Reference target is missing: first', { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Apply to workspace', exact: true })).toBeDisabled();
  await review.getByRole('button', { name: 'Back to edit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resolved value for third', exact: true })).toHaveText('2');
});

test('offers safe fields of a partially unresolved token', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'partial.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      source: { $type: 'number', $value: 0.4 },
      partial: { $type: 'color', $value: { colorSpace: 'srgb', components: [
        0.25, { $ref: '#/source/$value' }, { $ref: '#/missing/$value' },
      ] } },
    })),
  });
  await page.getByRole('button', { name: 'Name for source', exact: true }).click();
  await page.getByRole('button', { name: 'Link reference for source', exact: true }).click();
  const finder = page.getByRole('dialog', { name: 'Link a token' });
  await finder.getByRole('button', { name: 'Browse fields in partial', exact: true }).click();
  const available = finder.getByRole('button', { name: /Components › Red/u });
  await expect(available).toBeFocused();
  await expect(finder.getByRole('button', { name: /Components › (Green|Blue)/u })).toHaveCount(0);
  await expect(finder.getByRole('button', { name: 'Link token', exact: true })).toBeDisabled();
  await available.press('Enter');
  await finder.getByRole('button', { name: 'Link token', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resolved value for source', exact: true })).toHaveText('0.25');
});

test('duplicates a group with a new path while preserving its incoming references', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'duplicate.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      base: { value: { $type: 'number', $value: 2 }, alias: { $value: '{base.value}' } },
      original: { $value: '{base.alias}' },
    })),
  });
  await page.getByRole('button', { name: 'base', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for base', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Duplicate group', exact: true }).click();
  const copy = page.getByRole('dialog', { name: 'Duplicate group', exact: true });
  await expect(copy.getByRole('textbox', { name: 'Group name', exact: true })).toHaveValue('base-copy');
  await copy.getByRole('button', { name: 'Review duplicate', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review duplicate group', exact: true });
  await expect(review.getByText('2 tokens · 1 file changed · 1 reference updated', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for base-copy.alias', exact: true })).toHaveText('{base-copy.value}');
  await page.getByRole('button', { name: 'All tokens', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for original', exact: true })).toHaveText('{base.alias}');
});

test('edits wide gamut color fields, opacity, missing components and fallback independently', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'color.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      lime: { $type: 'color', $value: { colorSpace: 'display-p3', components: [0, 1, 0], alpha: 0.6, hex: '#00EE00' } },
    })),
  });
  await page.getByRole('button', { name: 'Name for lime', exact: true }).click();
  await command(page, 'View', 'Show token details');
  const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
  await expect(inspector.getByLabel('Color preview')).toBeVisible();
  await chooseOption(inspector.getByRole('combobox', { name: 'Color space', exact: true }), 'oklch');
  await inspector.getByRole('textbox', { name: 'Lightness', exact: true }).fill('0.72');
  const hue = inspector.getByRole('textbox', { name: 'Hue', exact: true });
  const includeHue = inspector.getByRole('checkbox', { name: 'Include hue channel' });
  const previousHue = await hue.inputValue();
  await includeHue.uncheck();
  await expect(hue).toBeDisabled();
  await includeHue.check();
  await expect(hue).toHaveValue(previousHue);
  await includeHue.uncheck();
  await inspector.getByRole('textbox', { name: 'Opacity', exact: true }).fill('0.4');
  await inspector.getByRole('textbox', { name: 'sRGB fallback', exact: true }).fill('#22AA33');
  await inspector.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(includeHue).not.toBeChecked();
  await expect(hue).toBeDisabled();
  await inspector.getByRole('button', { name: 'Raw JSON', exact: true }).click();
  const raw = inspector.getByRole('textbox', { name: 'Token value JSON', exact: true });
  const authored = parseJson(await raw.inputValue());
  expect(authored).toMatchObject({ colorSpace: 'oklch', components: [0.72, expect.any(Number), 'none'], alpha: 0.4, hex: '#22AA33' });
  await raw.fill('{"colorSpace":"oklch","components":[2,0,450],"alpha":4}');
  await expect(inspector.getByRole('list', { name: 'Value diagnostics' })).toContainText('$value/components/0');
  await expect(inspector.getByRole('list', { name: 'Value diagnostics' })).toContainText('$value/alpha');
});

test('creates a typed duration and reopens its authored unit and value', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'motion.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from('{"existing":{"$type":"number","$value":2}}'),
  });
  await expect(page.getByRole('button', { name: 'Name for existing', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New token', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'New token', exact: true });
  await create.getByRole('textbox', { name: 'Token name', exact: true }).fill('animation-time');
  await chooseOption(create.getByRole('combobox', { name: 'Token type', exact: true }), 'duration');
  const value = create.getByRole('textbox', { name: 'Token value', exact: true });
  await value.fill('');
  await value.pressSequentially('1.25');
  await chooseOption(create.getByRole('combobox', { name: 'Unit', exact: true }), 's');
  await create.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review changes', exact: true }).getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for animation-time', exact: true })).toHaveText('1.25 s');
  await command(page, 'View', 'Show token details');
  const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
  await expect(inspector.getByRole('textbox', { name: 'Token value', exact: true })).toHaveValue('1.25');
  const unit = inspector.getByRole('combobox', { name: 'Unit', exact: true });
  const fieldSize = (selector: typeof unit) => selector.locator('..').evaluate(element =>
    ({ width: element.clientWidth, height: element.clientHeight }));
  const name = inspector.getByRole('textbox', { name: 'Token name', exact: true });
  const nameSize = await fieldSize(name);
  await name.focus();
  expect(await fieldSize(name)).toEqual(nameSize);
  await expect(unit).toHaveAttribute('data-select-value', 's');
  const unfocusedSize = await fieldSize(unit);
  await unit.focus();
  await expect(unit).toBeFocused();
  expect(await fieldSize(unit)).toEqual(unfocusedSize);
  await page.keyboard.press('Tab');
  await expect(inspector.getByLabel('Token description', { exact: true })).toBeFocused();

  await inspector.getByRole('button', { name: 'Raw JSON', exact: true }).click();
  const json = inspector.getByRole('textbox', { name: 'Token value JSON', exact: true });
  const jsonSize = await fieldSize(json);
  await json.focus();
  expect(await fieldSize(json)).toEqual(jsonSize);
});

test('links a composite field, returns it to a literal, and preserves sibling fields', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'border.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      lineWidth: { $type: 'dimension', $value: { value: 4, unit: 'px' } },
      edge: { $type: 'border', $value: { width: { value: 1, unit: 'px' }, style: 'solid',
        color: { colorSpace: 'srgb', components: [0.125, 0.25, 0.5] } } },
    })),
  });
  await page.getByRole('button', { name: 'Name for edge', exact: true }).click();
  await command(page, 'View', 'Show token details');
  const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
  const width = inspector.getByRole('textbox', { name: 'Width value', exact: true });
  const link = inspector.getByRole('button', { name: 'Link Width value', exact: true });
  await width.focus();
  await link.hover();
  await expect(width).toBeFocused();
  await inspector.getByRole('button', { name: 'Link Width', exact: true }).click();
  const finder = page.getByRole('dialog', { name: 'Link a token', exact: true });
  await finder.getByRole('button', { name: 'lineWidth', exact: true }).click();
  await finder.getByRole('button', { name: 'Link token', exact: true }).click();
  await inspector.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(inspector.getByText('{lineWidth}', { exact: true }).first()).toBeVisible();
  await inspector.getByRole('button', { name: 'Use literal', exact: true }).click();
  await inspector.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await inspector.getByRole('button', { name: 'Raw JSON', exact: true }).click();
  const raw = inspector.getByRole('textbox', { name: 'Token value JSON', exact: true });
  const authored = await raw.inputValue();
  expect(parseJson(authored)).toEqual({
    width: { value: 4, unit: 'px' }, style: 'solid', color: { colorSpace: 'srgb', components: [0.125, 0.25, 0.5] },
  });

});

const px = (value: number) => ({ value, unit: 'px' });
const ms = (value: number) => ({ value, unit: 'ms' });

test('edits ordered composites and uses their live previews', async ({ page }) => {
  const black = { colorSpace: 'srgb', components: [0, 0, 0] };
  const white = { colorSpace: 'srgb', components: [1, 1, 1] };
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'composites.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      fade: { $type: 'gradient', $value: [{ color: black, position: 0 }, { color: white, position: 1 }] },
      depth: { $type: 'shadow', $value: [{ color: black, offsetX: px(0), offsetY: px(2), blur: px(4), spread: px(0) }] },
      motion: { $type: 'transition', $value: { duration: ms(150), delay: ms(0), timingFunction: [0.2, 0, 0, 1] } },
      reading: { $type: 'typography', $value: { fontFamily: 'serif', fontSize: px(18), fontWeight: 400, letterSpacing: px(0), lineHeight: 1.5 } },
      stroke: { $type: 'strokeStyle', $value: 'solid' },
    })),
  });
  await page.getByRole('button', { name: 'Name for fade', exact: true }).click();
  await command(page, 'View', 'Show token details');
  const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
  const apply = () => inspector.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  const raw = async () => {
    await inspector.getByRole('button', { name: 'Raw JSON', exact: true }).click();
    return inspector.getByRole('textbox', { name: 'Token value JSON', exact: true }).inputValue();
  };
  await expect(inspector.getByLabel('Gradient preview', { exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: 'Add gradient stop', exact: true }).click();
  await inspector.getByRole('textbox', { name: 'Position', exact: true }).fill('0.4');
  await inspector.getByRole('button', { name: 'Move Gradient stop 3 up', exact: true }).press('Enter');
  await apply();
  expect(parseJson(await raw())).toMatchObject([{ position: 0 }, { position: 0.4 }, { position: 1 }]);

  await page.getByRole('button', { name: 'Name for depth', exact: true }).click();
  await expect(inspector.getByLabel('Shadow preview', { exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: 'Add shadow layer', exact: true }).click();
  await inspector.getByRole('textbox', { name: 'Blur value', exact: true }).fill('6');
  await inspector.getByRole('button', { name: 'Move Shadow layer 2 up', exact: true }).press('Enter');
  await inspector.getByRole('button', { name: 'Remove Shadow layer 2', exact: true }).click();
  await apply();
  expect(parseJson(await raw())).toMatchObject([{ blur: px(6) }]);

  await page.getByRole('button', { name: 'Name for motion', exact: true }).click();
  await inspector.getByRole('button', { name: 'Play timing preview', exact: true }).press('Enter');
  await inspector.getByRole('textbox', { name: 'Duration value', exact: true }).fill('220');
  await inspector.getByRole('textbox', { name: 'X1', exact: true }).fill('0.4');
  await apply();
  expect(parseJson(await raw())).toMatchObject({ duration: ms(220), timingFunction: [0.4, 0, 0, 1] });

  await page.getByRole('button', { name: 'Name for reading', exact: true }).click();
  await inspector.getByRole('button', { name: 'Add fallback font', exact: true }).click();
  await inspector.getByRole('textbox', { name: 'Font 2', exact: true }).fill('monospace');
  await inspector.getByRole('button', { name: 'Move Font 2 up', exact: true }).press('Enter');
  await inspector.getByRole('textbox', { name: 'Font weight', exact: true }).fill('600');
  await expect(inspector.getByLabel('Typography preview', { exact: true }).locator('p')).toHaveCSS('font-weight', '600');
  await apply();
  expect(parseJson(await raw())).toMatchObject({ fontFamily: ['monospace', 'serif'], fontWeight: 600 });

  await page.getByRole('button', { name: 'Name for stroke', exact: true }).click();
  await chooseOption(inspector.getByRole('combobox', { name: 'Stroke format', exact: true }), 'pattern');
  await chooseOption(inspector.getByRole('combobox', { name: 'Line cap', exact: true }), 'round');
  await inspector.getByRole('button', { name: 'Add dash length', exact: true }).click();
  await inspector.getByRole('textbox', { name: 'Dash length 2 value', exact: true }).fill('3');
  await apply();
  expect(parseJson(await raw())).toMatchObject({ lineCap: 'round', dashArray: [px(2), px(3)] });
});

test('restores a draft when switching back from an incompatible type', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'switch.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ chip: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.1, 0.2, 0.3], alpha: 0.5 } } })),
  });
  await page.getByRole('button', { name: 'Name for chip', exact: true }).click();
  await command(page, 'View', 'Show token details');
  const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
  await inspector.getByRole('textbox', { name: 'Red', exact: true }).fill('0.35');
  const type = inspector.getByRole('combobox', { name: 'Token type', exact: true });
  await chooseOption(type, 'dimension');
  await inspector.getByRole('textbox', { name: 'Token value', exact: true }).fill('8');
  await chooseOption(type, 'color');
  await expect(inspector.getByRole('textbox', { name: 'Red', exact: true })).toHaveValue('0.35');
  await expect(inspector.getByRole('textbox', { name: 'Opacity', exact: true })).toHaveValue('0.5');
  await chooseOption(type, 'dimension');
  await expect(inspector.getByRole('textbox', { name: 'Token value', exact: true })).toHaveValue('8');
  await inspector.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await inspector.getByRole('button', { name: 'Raw JSON', exact: true }).click();
  expect(parseJson(await inspector.getByRole('textbox', { name: 'Token value JSON', exact: true }).inputValue())).toEqual({ value: 8, unit: 'px' });
});

test('creates, reopens, and links every typed value through the editor', async ({ page }) => {
  test.setTimeout(180_000);
  const color = { colorSpace: 'srgb', components: [0, 0, 0] };
  const shadow = { color, offsetX: px(0), offsetY: px(3), blur: px(6), spread: px(0) };
  const typography = { fontFamily: 'serif', fontSize: px(18), fontWeight: 400, letterSpacing: px(0), lineHeight: 1.5 };
  const values = {
    color, dimension: px(8), duration: ms(100), number: 5, fontFamily: 'serif', fontWeight: 500,
    cubicBezier: [0, 0, 1, 1], strokeStyle: 'dashed', border: { color, style: 'solid', width: px(1) },
    transition: { duration: ms(120), delay: ms(0), timingFunction: [0, 0, 1, 1] },
    shadow, gradient: [{ color, position: 0 }, { color, position: 1 }], typography,
  };
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'typed.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ target: Object.fromEntries(Object.entries(values).map(([type, value]) =>
      [type, { $type: type, $value: value }])) })),
  });
  await expect(page.getByRole('button', { name: 'Name for target.color', exact: true })).toBeVisible();
  async function verify(type: string, value: JsonValue) {
    const path = 'new-' + type;
    await page.getByRole('button', { name: 'New token', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'New token', exact: true });
    await create.getByRole('textbox', { name: 'Token name', exact: true }).fill(path);
    await chooseOption(create.getByRole('combobox', { name: 'Token type', exact: true }), type);
    await create.getByRole('button', { name: 'Review changes', exact: true }).press('Enter');
    const review = page.getByRole('dialog', { name: 'Review changes', exact: true });
    await review.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
    const cell = page.getByRole('button', { name: 'Value for ' + path, exact: true });
    await expect(cell).toBeVisible();

    const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
    if (!await inspector.isVisible()) await command(page, 'View', 'Show token details');
    await inspector.getByRole('button', { name: 'Raw JSON', exact: true }).click();
    const raw = inspector.getByRole('textbox', { name: 'Token value JSON', exact: true });
    const initial = await raw.inputValue();
    expect(parseJson(initial)).toBeDefined();
    const changed = JSON.stringify(value, null, 2);
    if (JSON.stringify(parseJson(initial)) !== JSON.stringify(value)) {
      await raw.fill(changed);
      await inspector.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
      expect(parseJson(await raw.inputValue())).toEqual(value);
    }
    await inspector.getByRole('button', { name: 'Link token', exact: true }).click();
    const finder = page.getByRole('dialog', { name: 'Link a token', exact: true });
    await finder.getByRole('searchbox', { name: 'Search tokens', exact: true }).fill('target.' + type);
    await finder.getByRole('button', { name: 'target.' + type, exact: true }).click();
    await finder.getByRole('button', { name: 'Link token', exact: true }).press('Enter');
    await inspector.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
    await expect(cell).toHaveText('{target.' + type + '}');
  }
  await Object.entries(values).reduce<Promise<void>>((previous, [type, value]) =>
    previous.then(() => verify(type, value)), Promise.resolve());

  const downloading = page.waitForEvent('download');
  await command(page, 'File', 'Export token JSON');
  const download = await downloading;
  const text = await readFile(await download.path(), 'utf8');
  expect(parseJson(text)).toMatchObject({
    target: Object.fromEntries(Object.entries(values).map(([type, value]) => [type, { $type: type, $value: value }])),
    ...Object.fromEntries(Object.keys(values).map(type => ['new-' + type, { $type: type, $value: '{target.' + type + '}' }])),
  });
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'reopened.tokens.json', mimeType: 'application/json', buffer: Buffer.from(text),
  });
  await expect(page.locator('[data-workspace-name]')).toHaveText('reopened.tokens.json');
  await expect(page.getByRole('button', { name: 'Type for new-typography', exact: true })).toHaveText('typography');
  await expect(page.getByRole('button', { name: 'Resolved value for new-border', exact: true })).not.toHaveText('Invalid');
});

test('links independent fields in the same value and previews the current draft', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'same-token.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      shade: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.1, 0.3, 0.6] } },
    })),
  });
  await page.getByRole('button', { name: 'Name for shade', exact: true }).click();
  await command(page, 'View', 'Show token details');
  const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
  const red = inspector.getByRole('textbox', { name: 'Red', exact: true });
  const green = inspector.getByRole('textbox', { name: 'Green', exact: true });
  const includeBlue = inspector.getByRole('checkbox', { name: 'Include blue channel' });
  const hex = inspector.getByRole('textbox', { name: 'Token value', exact: true });
  const swatch = inspector.getByLabel('Color preview', { exact: true });
  const previewStyle = swatch.locator('[style]');
  await includeBlue.uncheck();
  await expect(hex).toBeDisabled();
  await expect(swatch).toBeVisible();
  await expect(previewStyle).toHaveAttribute('style', /0\.1 0\.3 0(?: |[)])/u);
  await expect(inspector.getByRole('button', { name: 'Add sRGB fallback' })).toHaveCount(0);
  await includeBlue.check();
  await expect(hex).toBeEnabled();

  const includeOpacity = inspector.getByRole('checkbox', { name: 'Include opacity' });
  const opacity = inspector.getByRole('textbox', { name: 'Opacity', exact: true });
  await expect(opacity).toBeDisabled();
  await includeOpacity.check();
  await opacity.fill('0.5');
  await includeOpacity.uncheck();
  await expect(opacity).toBeDisabled();
  await includeOpacity.check();
  await expect(opacity).toHaveValue('0.5');
  await includeOpacity.uncheck();
  await red.fill('0.8');
  await green.locator('..').locator('[data-slot="trailing-icon"]').getByRole('button', { name: 'Link Green', exact: true }).click();
  const finder = page.getByRole('dialog', { name: 'Link a token', exact: true });
  await finder.getByRole('button', { name: 'Browse fields in shade', exact: true }).click();
  await expect(finder.getByRole('button', { name: /Components › Green/u })).toHaveCount(0);
  await finder.getByRole('button', { name: /Components › Red/u }).click();
  await finder.getByRole('button', { name: 'Link token', exact: true }).click();
  await expect(inspector.getByLabel('Color preview', { exact: true }).locator('[style]')).toHaveAttribute('style', /0\.8 0\.8 0\.6/u);
  await inspector.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resolved value for shade', exact: true })).toHaveText('#CCCC99');
});

test('opens a Resolver, compares contexts, edits the intended context, and exports authored sources', async ({ page }) => {
  await page.goto('/');
  const manifest = {
    name: 'Theme workspace', version: '2025.10',
    sets: { foundation: { sources: [{ $ref: 'base.tokens.json' }] } },
    modifiers: { theme: { default: 'light', contexts: { light: [], dark: [{ $ref: 'dark.tokens.json' }] } } },
    resolutionOrder: [{ $ref: '#/sets/foundation' }, { $ref: '#/modifiers/theme' }],
  };
  const baseSource = JSON.stringify({ gap: { $type: 'number', $value: 4 }, padding: { $value: '{gap}' } });
  const darkSource = JSON.stringify({ gap: { $type: 'number', $value: 12 } });
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'theme.resolver.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) },
    { name: 'base.tokens.json', mimeType: 'application/json', buffer: Buffer.from(baseSource) },
    { name: 'dark.tokens.json', mimeType: 'application/json', buffer: Buffer.from(darkSource) },
  ]);
  const pane = page.getByRole('main', { name: 'Token library', exact: true });
  await expect(page.getByRole('combobox', { name: 'Editing set' })).toBeVisible();
  await chooseOption(pane.getByRole('group', { name: 'Preview', exact: true }).getByRole('combobox', { name: 'theme', exact: true }), 'dark');
  await pane.getByRole('button', { name: 'Name for gap', exact: true }).click();
  await pane.getByRole('button', { name: 'Edit token', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Token details' });
  await expect(inspector.getByText('dark override', { exact: true })).toBeVisible();
  await inspector.getByText('Where this value comes from', { exact: true }).click();
  await expect(inspector.getByRole('button', { name: /Current value.*dark.tokens.json/u })).toBeVisible();
  await inspector.getByRole('button', { name: 'Edit shared value', exact: true }).click();
  await expect(inspector.getByRole('textbox', { name: 'Token value', exact: true })).toHaveValue('4');
  await inspector.getByRole('button', { name: 'Edit dark override', exact: true }).click();
  await inspector.getByRole('textbox', { name: 'Token value', exact: true }).fill('20');
  await inspector.getByRole('button', { name: 'Review changes', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review changes' });
  await expect(review.getByText('dark · 2 tokens affected', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await command(page, 'View', 'Compare variants');
  const variants = page.getByRole('main', { name: 'Variants', exact: true });
  const table = variants.getByRole('table', { name: 'Variant comparison' });
  await expect(table.getByRole('row', { name: /padding Changed 20 4/u })).toBeVisible();
  const snapshotWait = page.waitForEvent('download');
  await command(page, 'File', 'Export resolved JSON · dark');
  const snapshot = await snapshotWait;
  expect(parseJson(await readFile(await snapshot.path(), 'utf8'))).toMatchObject({ gap: { $value: 20 }, padding: { $value: 20 } });
  const bundleWait = page.waitForEvent('download');
  await command(page, 'File', 'Export sources (.zip)');
  const bundle = await bundleWait;
  const { unzipSync, strFromU8 } = await import('fflate');
  const unpacked = unzipSync(new Uint8Array(await readFile(await bundle.path())));
  expect(strFromU8(unpacked['base.tokens.json'] ?? new Uint8Array())).toBe(baseSource);
  expect(parseJson(strFromU8(unpacked['dark.tokens.json'] ?? new Uint8Array()))).toMatchObject({ gap: { $value: 20 } });
  expect(parseJson(strFromU8(unpacked['theme.resolver.json'] ?? new Uint8Array()))).toMatchObject({
    modifiers: { theme: { contexts: { dark: [{ $ref: 'dark.tokens.json' }] } } },
  });

  await variants.getByRole('button', { name: 'Back to tokens' }).click();
  await chooseOption(pane.getByRole('group', { name: 'Preview', exact: true }).getByRole('combobox', { name: 'theme', exact: true }), 'light');
  await pane.getByRole('button', { name: 'Name for gap', exact: true }).click();
  await inspector.getByRole('button', { name: 'Override for light', exact: true }).click();
  await inspector.getByRole('textbox', { name: 'Token value', exact: true }).fill('6');
  await inspector.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(review.getByText('light · 2 tokens affected', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(inspector.getByText('light override', { exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Value for gap', exact: true })).toHaveText('6');
});

test('creates a Resolver and authors named sets, modifier contexts and ordered inline entries', async ({ page }, info) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'base.tokens.json', mimeType: 'application/json',
    buffer: Buffer.from('{"gap":{"$type":"number","$value":4}}'),
  });
  await expect(page.getByRole('button', { name: 'Name for gap', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Set up variants', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Set up variants', exact: true });
  await create.getByRole('textbox', { name: 'Configuration name' }).fill('Density example');
  await create.getByRole('button', { name: 'Set up variants' }).click();
  const apply = async () => {
    const review = page.getByRole('dialog', { name: 'Review changes', exact: true });
    await review.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
    await expect(review).toBeHidden();
  };
  await apply();
  const pane = page.getByRole('main', { name: 'Token library', exact: true });
  const manager = page.getByRole('main', { name: 'Variants' });
  const manage = () => page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Variants', exact: true }).click();
  const back = () => manager.getByRole('button', { name: 'Back to tokens' }).click();
  await pane.getByRole('button', { name: 'Add variant options' }).click();
  await expect(manager.getByRole('heading', { name: 'Variants', exact: true })).toBeFocused();
  await expect(manager.getByText('Density example', { exact: true })).toBeVisible();
  await expect(pane.getByRole('grid', { name: 'Tokens' })).toBeHidden();
  const table = pane.getByRole('grid', { name: 'Tokens' });

  await manager.getByRole('button', { name: 'New token set', exact: true }).click();
  const set = page.getByRole('dialog', { name: 'New token set', exact: true });
  await set.getByRole('textbox', { name: 'Set name' }).fill('Extras');
  await chooseOption(set.getByRole('combobox', { name: 'Open file or set' }), { label: 'base.tokens.json' });
  await set.getByRole('button', { name: 'Add source' }).click();
  await set.getByRole('button', { name: 'Add inline tokens' }).click();
  await set.getByRole('button', { name: 'Add inline token', exact: true }).click();
  const inline = page.getByRole('dialog', { name: 'Add inline token', exact: true });
  await inline.getByRole('textbox', { name: 'Token name' }).fill('accent');
  await chooseOption(inline.getByRole('combobox', { name: 'Token type' }), 'number');
  await inline.getByRole('textbox', { name: 'Token value' }).fill('7');
  await inline.getByRole('button', { name: 'Review changes' }).click();
  await expect(inline).toBeHidden();
  await set.getByRole('button', { name: 'Move source 2 up' }).click();
  await set.getByRole('button', { name: 'Add reference' }).click();
  await set.getByRole('button', { name: 'Remove source 3' }).click();
  await expect(set.getByRole('button', { name: 'Add reference' })).toBeFocused();
  await set.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('dialog', { name: 'Review changes', exact: true }).getByRole('button', { name: 'Back to edit' }).click();
  await expect(set.getByRole('textbox', { name: 'Set name' })).toHaveValue('Extras');
  await set.getByRole('button', { name: 'Review changes' }).click();
  await apply();

  await manager.getByRole('button', { name: 'New variant dimension', exact: true }).click();
  const modifier = page.getByRole('dialog', { name: 'New variant dimension', exact: true });
  await modifier.getByRole('textbox', { name: 'Variant name' }).fill('density');
  await modifier.getByRole('button', { name: 'Add option' }).click();
  await modifier.getByRole('textbox', { name: 'Option 1 name' }).fill('compact');
  await modifier.getByRole('button', { name: 'Add option' }).click();
  await modifier.getByRole('textbox', { name: 'Option 2 name' }).fill('spacious');
  await modifier.getByRole('button', { name: 'Add option' }).click();
  await modifier.getByRole('button', { name: 'Remove option 3' }).click();
  await expect(modifier.getByRole('button', { name: 'Add option' })).toBeFocused();
  const spacious = modifier.getByRole('region', { name: 'Option 2' });
  await spacious.getByText('0 sources', { exact: true }).click();
  await spacious.getByRole('button', { name: 'Add inline tokens' }).click();
  await spacious.getByText('Inline source JSON', { exact: true }).click();
  await spacious.getByRole('textbox', { name: 'Source 1 · Inline tokens' }).fill('{"gap":{"$type":"number","$value":16}}');
  await chooseOption(modifier.getByRole('combobox', { name: 'Default option' }), { label: 'spacious' });
  await modifier.getByRole('button', { name: 'Review changes' }).click();
  await apply();

  await manager.getByRole('button', { name: 'Add to override order' }).click();
  const entry = page.getByRole('dialog', { name: 'Add to override order' });
  await chooseOption(entry.getByRole('combobox', { name: 'Entry', exact: true }), { label: 'Set · Extras' });
  await entry.getByRole('button', { name: 'Review changes' }).click();
  await apply();
  await back();
  await expect(table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for accent', exact: true }) }).getByText('7', { exact: true })).toBeVisible();

  await manage();
  await manager.getByRole('button', { name: 'Add to override order' }).click();
  await chooseOption(entry.getByRole('combobox', { name: 'Entry', exact: true }), { label: 'Dimension · density' });
  await entry.getByRole('button', { name: 'Review changes' }).click();
  await apply();
  await back();
  await expect(table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('16', { exact: true })).toBeVisible();

  await manage();
  await manager.getByRole('button', { name: 'Add to override order' }).click();
  await entry.getByRole('textbox', { name: 'Inline entry JSON' }).fill(
    '{"name":"Late","type":"set","sources":[{"gap":{"$type":"number","$value":30}}]}',
  );
  await entry.getByRole('button', { name: 'Review changes' }).click();
  await apply();
  await back();
  await expect(table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('30', { exact: true })).toBeVisible();
  await manage();
  await manager.getByRole('button', { name: 'Move Late up', exact: true }).press('Enter');
  await apply();
  await back();
  await expect(table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('16', { exact: true })).toBeVisible();
  await chooseOption(pane.getByRole('group', { name: 'Preview' }).getByRole('combobox', { name: 'density', exact: true }), 'compact');
  await expect(table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('30', { exact: true })).toBeVisible();

  await openSaveReview(page);
  const patch = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export patch', exact: true }).click();
  const directory = info.outputPath('patch-checkout');
  await mkdir(directory, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  execFileSync('git', ['apply', await (await patch).path()], { cwd: directory });
  const manifest = parseJson(await readFile(info.outputPath('patch-checkout', 'density-example.resolver.json'), 'utf8'));
  expect(manifest).toMatchObject({
    version: '2025.10',
    sets: { Extras: { sources: [{ accent: { $type: 'number', $value: 7 } }, { $ref: 'base.tokens.json' }] } },
  });
});

test('saves a newly authored Resolver in its original folder', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native folder access is exercised in Chromium.');
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('resolver-fixture', { create: true });
      const handle = await directory.getFileHandle('base.tokens.json', { create: true });
      const stream = await handle.createWritable();
      await stream.write('{"gap":{"$type":"number","$value":4}}');
      await stream.close();
      return Object.assign(directory, { requestPermission: () => Promise.resolve('granted' as const) });
    };
  });
  await page.goto('/');
  await command(page, 'File', 'Open folder…');
  await expect(page.locator('[data-workspace-name]')).toHaveText('resolver-fixture');
  await page.getByRole('button', { name: 'Set up variants', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Set up variants', exact: true });
  await create.getByRole('textbox', { name: 'Configuration name' }).fill('Folder theme');
  await create.getByRole('button', { name: 'Set up variants' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await openSaveReview(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Save to folder' }).click();
  await expect(page.getByText('Saved to folder.', { exact: true })).toBeVisible();
  const content = await page.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('resolver-fixture');
    return (await (await directory.getFileHandle('folder-theme.resolver.json')).getFile()).text();
  });
  expect(parseJson(content)).toMatchObject({
    version: '2025.10', sets: { foundation: { sources: [{ $ref: 'base.tokens.json' }] } },
  });
});

test('reviews source file moves, blocks broken links, and keeps file history undoable', async ({ page }, info) => {
  const directory = info.outputPath('source-checkout');
  const base = '\uFEFF{"gap":{"$type":"number","$value":4}}\n';
  const consumer = '{"size":{"$type":"number","$value":{"$ref":"base.tokens.json#/gap/$value"}}}\n';
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(info.outputPath('source-checkout', 'base.tokens.json'), base),
    writeFile(info.outputPath('source-checkout', 'consumer.tokens.json'), consumer),
  ]);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: directory });
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'base.tokens.json', mimeType: 'application/json', buffer: Buffer.from(base) },
    { name: 'consumer.tokens.json', mimeType: 'application/json', buffer: Buffer.from(consumer) },
  ]);
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  const management = page.getByRole('main', { name: 'Workspace management' });
  const newFile = management.getByRole('button', { name: 'New source file' });
  await newFile.click();
  await page.getByRole('textbox', { name: 'File name' }).fill('unused');
  await chooseOption(page.getByRole('combobox', { name: 'Folder' }), { label: 'New folder…' });
  await page.getByRole('textbox', { name: 'New folder path' }).fill('nested');
  await page.getByRole('button', { name: 'Review file change' }).click();
  await page.getByRole('dialog', { name: 'Review changes' }).getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(management.getByRole('button', { name: 'nested/unused.tokens.json', exact: true })).toBeVisible();
  await management.getByRole('button', { name: 'Actions for nested/unused.tokens.json', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove file…' }).click();
  await page.getByRole('button', { name: 'Review removal' }).click();
  await page.getByRole('dialog', { name: 'Remove source file', exact: true }).getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(management.getByRole('button', { name: 'nested/unused.tokens.json', exact: true })).toHaveCount(0);

  await management.getByRole('button', { name: 'Actions for base.tokens.json', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename or move…' }).click();
  const move = page.getByRole('dialog', { name: 'Rename or move source file' });
  await move.getByRole('textbox', { name: 'File path' }).fill('nested/brand färger.tokens.json');
  await move.getByRole('button', { name: 'Review file change' }).click();
  const review = page.getByRole('dialog', { name: 'Move source file', exact: true });
  await expect(review).toContainText('1 reference updated');
  await review.getByRole('button', { name: 'Back to edit' }).click();
  await expect(move.getByRole('textbox', { name: 'File path' })).toHaveValue('nested/brand färger.tokens.json');
  await move.getByRole('button', { name: 'Review file change' }).click();
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(review).toBeHidden();
  const relocated = management.getByRole('button', { name: 'nested/brand färger.tokens.json', exact: true });
  await expect(relocated).toBeVisible();
  await expect(relocated).toBeFocused();
  await command(page, 'Edit', 'Undo');
  await expect(relocated).toHaveCount(0);
  await command(page, 'Edit', 'Redo');
  await expect(relocated).toBeVisible();

  await management.getByRole('button', { name: 'Actions for nested/brand färger.tokens.json', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove file…' }).click();
  const removal = page.getByRole('dialog', { name: 'Remove source file', exact: true });
  await removal.getByRole('button', { name: 'Review removal' }).click();
  await expect(removal.getByRole('button', { name: 'Apply to workspace' })).toBeDisabled();
  await expect(removal.getByRole('alert')).toContainText('size');
  await removal.getByRole('button', { name: 'Back to edit' }).click();
  await removal.getByRole('button', { name: 'Cancel' }).click();

  await openSaveReview(page);
  const patch = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export patch', exact: true }).click();
  execFileSync('git', ['apply', await (await patch).path()], { cwd: directory });
  expect(await readFile(info.outputPath('source-checkout', 'nested', 'brand färger.tokens.json'), 'utf8')).toBe(base);
  expect(await readFile(info.outputPath('source-checkout', 'consumer.tokens.json'), 'utf8')).toContain('nested/brand%20f%C3%A4rger.tokens.json#/gap/$value');
  await expect(readFile(info.outputPath('source-checkout', 'base.tokens.json'), 'utf8')).rejects.toThrow(/ENOENT/u);
});

test('preserves a UTF-8 BOM when saving a moved source to its folder', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native folder access is exercised in Chromium.');
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('source-move-fixture', { create: true });
      const handle = await directory.getFileHandle('base.tokens.json', { create: true });
      const stream = await handle.createWritable();
      await stream.write('\uFEFF{"gap":{"$type":"number","$value":4}}');
      await stream.close();
      return Object.assign(directory, { requestPermission: () => Promise.resolve('granted' as const) });
    };
  });
  await page.goto('/');
  await command(page, 'File', 'Open folder…');
  await expect(page.locator('[data-workspace-name]')).toHaveText('source-move-fixture');
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for base.tokens.json' }).click();
  await page.getByRole('menuitem', { name: 'Rename or move…' }).click();
  await page.getByRole('textbox', { name: 'File path' }).fill('theme/brand colors.tokens.json');
  await page.getByRole('button', { name: 'Review file change' }).click();
  await page.getByRole('dialog', { name: 'Move source file' }).getByRole('button', { name: 'Apply to workspace' }).click();
  await openSaveReview(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Save to folder' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('source-move-fixture');
    const theme = await directory.getDirectoryHandle('theme');
    const moved = await (await theme.getFileHandle('brand colors.tokens.json')).getFile();
    const remaining: string[] = [];
    for await (const name of directory.keys()) remaining.push(name);
    return { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await moved.arrayBuffer()), remaining: remaining.toSorted() };
  });
  expect(result).toEqual({ text: '\uFEFF{"gap":{"$type":"number","$value":4}}', remaining: ['theme'] });
});

test('renames a Resolver set and previews references before removal', async ({ page }) => {
  const tree = {
    version: '2025.10',
    sets: { brand: { sources: [{ gap: { $type: 'number', $value: 4 } }] } },
    resolutionOrder: [{ $ref: '#/sets/brand' }],
  };
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'brand.resolver.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tree, null, 2)),
  });
  const pane = page.getByRole('main', { name: 'Token library' });
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Variants', exact: true }).click();
  const manager = page.getByRole('main', { name: 'Variants' });
  await manager.getByRole('button', { name: 'Actions for set brand' }).click();
  await page.getByRole('menuitem', { name: 'Rename set…' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename set', exact: true });
  await rename.getByRole('textbox', { name: 'Set name' }).fill('foundation');
  await rename.getByRole('button', { name: 'Review rename' }).click();
  const review = page.getByRole('dialog', { name: 'Review set rename', exact: true });
  await expect(review).toContainText('1 reference updated');
  await review.getByText('Show file changes', { exact: true }).click();
  await expect(review.getByRole('region', { name: 'File changes' })).toContainText('#/sets/foundation');
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await manager.getByRole('button', { name: 'Back to tokens' }).click();
  await expect(pane.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('4', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Variants', exact: true }).click();
  await manager.getByRole('button', { name: 'Actions for set foundation' }).click();
  await page.getByRole('menuitem', { name: 'Remove set…' }).click();
  const remove = page.getByRole('dialog', { name: 'Remove set', exact: true });
  await remove.getByRole('button', { name: 'Review removal' }).click();
  const removal = page.getByRole('dialog', { name: 'Review set removal', exact: true });
  await expect(removal.getByRole('button', { name: 'Apply to workspace' })).toBeDisabled();
  await expect(removal.getByRole('alert')).toContainText('target is missing');
});

test('reviews and undoes a bulk field edit while keeping the selection and draft', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'spacing.tokens.json', mimeType: 'application/json',
      buffer: Buffer.from('{"small":{"$type":"dimension","$value":{"value":4,"unit":"px"}},"large":{"$type":"dimension","$value":{"value":12,"unit":"rem"}}}') },
    { name: 'alias.tokens.json', mimeType: 'application/json',
      buffer: Buffer.from('{"consumer":{"$type":"dimension","$value":"{small}"},"other":{"$type":"number","$value":5}}') },
  ]);
  const grid = page.getByRole('grid', { name: 'Tokens' });
  const checkbox = (path: string) => grid.locator('[data-token-row="' + path + '"]').getByRole('checkbox');
  await checkbox('small').click();
  await checkbox('large').click();
  const trigger = page.getByRole('button', { name: 'Change value', exact: true });
  await trigger.click();
  const form = page.getByRole('dialog', { name: 'Change value · 2 tokens', exact: true });
  await chooseOption(form.getByRole('combobox', { name: 'Part to change', exact: true }), { label: 'Value' });
  await form.getByText('Mixed values', { exact: true }).click();
  await expect(form.getByRole('region', { name: 'Current values' })).toContainText('12');
  await expect(form.getByRole('textbox', { name: 'Replacement value' })).toHaveValue('0');
  await form.getByRole('textbox', { name: 'Replacement value' }).fill('8');
  await form.getByRole('button', { name: 'Review edits' }).click();
  const review = page.getByRole('dialog', { name: 'Review selected token edits', exact: true });
  await review.getByRole('button', { name: 'Back to edit' }).click();
  await expect(form.getByRole('textbox', { name: 'Replacement value' })).toHaveValue('8');
  await form.getByRole('button', { name: 'Review edits' }).click();
  const records = review.getByRole('table', { name: 'Selected token changes' });
  await expect(records.getByRole('row', { name: /small 4 8/u })).toBeVisible();
  await expect(records.getByRole('row', { name: /large 12 8/u })).toBeVisible();
  await review.getByText('Show file changes', { exact: true }).click();
  await expect(review.getByRole('region', { name: 'File changes' })).toContainText('spacing.tokens.json');
  await review.getByText('Resolved value changes (3)', { exact: true }).click();
  await expect(review.getByText('consumer', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(trigger).toBeFocused();
  await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
  await expect(grid.locator('[data-token-row="small"]')).toContainText('8 px');
  await expect(grid.locator('[data-token-row="large"]')).toContainText('8 rem');
  await command(page, 'Edit', 'Undo');
  await expect(grid.locator('[data-token-row="small"]')).toContainText('4 px');
  await expect(grid.locator('[data-token-row="large"]')).toContainText('12 rem');
  await command(page, 'Edit', 'Redo');
  await expect(grid.locator('[data-token-row="small"]')).toContainText('8 px');
  await expect(grid.locator('[data-token-row="large"]')).toContainText('8 rem');
});

test('renames, links, changes type, and duplicates a row selection', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'a.tokens.json', mimeType: 'application/json', buffer: Buffer.from('{"size-a":{"$type":"number","$value":1},"alias":{"$value":"{size-a}"}}') },
    { name: 'b.tokens.json', mimeType: 'application/json', buffer: Buffer.from('{"size-b":{"$type":"number","$value":2},"size-c":{"$type":"number","$value":3}}') },
  ]);
  await page.getByRole('button', { name: 'Value for size-a', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Change value', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Value for size-b', exact: true }).click({ modifiers: ['Control'] });
  const apply = () => page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename · 2 tokens' });
  await rename.getByLabel('Find in token name').fill('^size-');
  await rename.getByLabel('Use regular expression').check();
  await rename.getByLabel('Replace with').fill('space-');
  await expect(rename.getByRole('region', { name: 'Rename preview' })).toContainText('size-a → space-a');
  await rename.getByRole('button', { name: 'Review edits' }).click();
  await expect(page.getByRole('dialog').getByText(/1 reference updated/u)).toBeVisible();
  await apply();
  await expect(page.getByRole('button', { name: 'Value for alias', exact: true })).toHaveText('{space-a}');
  await page.getByRole('button', { name: 'Change value', exact: true }).click();
  await page.getByRole('dialog', { name: 'Change value · 2 tokens' }).getByRole('button', { name: 'Link a token' }).click();
  const linker = page.getByRole('dialog', { name: 'Link a token', exact: true });
  await linker.getByRole('button', { name: 'size-c', exact: true }).click();
  await linker.getByRole('button', { name: 'Link token', exact: true }).click();
  await page.getByRole('button', { name: 'Review edits', exact: true }).click();
  await apply();
  await expect(page.getByRole('button', { name: 'Resolved value for space-b', exact: true })).toHaveText('3');
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page.getByRole('button', { name: 'Review duplicate', exact: true }).click();
  await apply();
  await expect(page.getByRole('button', { name: 'Value for space-a-copy', exact: true })).toHaveText('{size-c}');
  await expect(page.getByRole('button', { name: 'Value for space-b-copy', exact: true })).toHaveText('{size-c}');
  await page.getByRole('button', { name: 'Type for space-a-copy', exact: true }).click();
  await page.getByRole('button', { name: 'Type for space-b-copy', exact: true }).click({ modifiers: ['Control'] });
  await page.getByRole('button', { name: 'Change type', exact: true }).click();
  const change = page.getByRole('dialog', { name: 'Change type · 2 tokens' });
  await chooseOption(change.getByRole('combobox', { name: 'New token type', exact: true }), 'dimension');
  await expect(change.getByText('2 need a replacement value')).toBeVisible();
  await change.getByRole('textbox', { name: 'Token value', exact: true }).fill('6');
  await change.getByRole('button', { name: 'Review edits' }).click();
  await apply();
  await expect(page.getByRole('button', { name: 'Value for space-a-copy', exact: true })).toHaveText('6 px');
  await expect(page.getByRole('button', { name: 'Value for space-b-copy', exact: true })).toHaveText('6 px');
});

test('copies a native token selection and pastes through destination and collision review', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'tokens.json', mimeType: 'application/json',
    buffer: Buffer.from('{"brand":{"base":{"$type":"number","$value":4},"ref":{"$type":"number","$value":"{brand.base}"}}}'),
  });
  const grid = page.getByRole('grid', { name: 'Tokens' });
  await grid.locator('[data-token-row="brand.base"]').getByRole('checkbox').click();
  await grid.locator('[data-token-row="brand.ref"]').getByRole('checkbox').click();
  const nativeCopy = await grid.evaluate(node => {
    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data });
    node.dispatchEvent(event);
    return event.clipboardData?.getData('text/plain') ?? '';
  });
  expect(parseJson(nativeCopy)).toMatchObject({ format: 'foundry.tokens', version: 1, entries: [{ path: 'brand.base' }, { path: 'brand.ref' }] });
  await grid.evaluate((node, contents) => {
    const data = new DataTransfer();
    data.setData('text/plain', contents);
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    // Firefox's synthetic paste constructor does not expose the supplied DataTransfer.
    Object.defineProperty(event, 'clipboardData', { value: data });
    node.dispatchEvent(event);
  }, nativeCopy);
  const form = page.getByRole('dialog', { name: 'Paste tokens or groups' });
  await form.getByRole('navigation', { name: 'Paste destination group' }).getByRole('button', { name: 'brand', exact: true }).click();
  const rename = form.getByRole('textbox', { name: 'Name for brand.base' });
  await expect(rename).toHaveValue('base-copy');
  await rename.fill('ref');
  await form.getByRole('button', { name: 'Review paste' }).click();
  await expect(form.getByRole('alert')).toContainText('already exists');
  await rename.fill('primary');
  await form.getByRole('button', { name: 'Review paste' }).click();
  const review = page.getByRole('dialog', { name: 'Review paste', exact: true });
  await expect(review).toContainText('1 reference updated');
  await review.getByRole('button', { name: 'Back to edit' }).click();
  await expect(review).toBeHidden();
  await expect(rename).toHaveValue('primary');
  await form.getByRole('button', { name: 'Review paste' }).click();
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'brand', exact: true })).toBeFocused();
  await expect(grid.locator('[data-token-row="brand.ref-copy"]')).toContainText('{brand.primary}');
  await expect(grid.locator('[data-token-row="brand.ref"]')).toContainText('{brand.base}');
});

test('copies a group from its menu and reveals a collapsed destination after paste', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'tokens.json', mimeType: 'application/json',
    buffer: Buffer.from('{"reference":{"gap":{"$type":"number","$value":4}},"system":{"old":{"flag":{"$type":"number","$value":7}}}}'),
  });
  const groups = page.getByRole('navigation', { name: 'Token groups' });
  await groups.getByRole('button', { name: 'reference', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for reference', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy group', exact: true }).click();
  await groups.getByRole('button', { name: 'system', exact: true }).click();
  await expect(groups.getByRole('button', { name: 'Expand system' })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for system', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Paste into group…', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Paste tokens or groups' });
  await expect(form.getByRole('textbox', { name: 'Group name' })).toHaveValue('reference');
  await form.getByRole('button', { name: 'Review paste' }).click();
  await page.getByRole('dialog', { name: 'Review paste', exact: true }).getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(groups.getByRole('button', { name: 'reference', exact: true }).filter({ visible: true }).last()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: /system.*reference/u })).toBeFocused();
});

test('moves a named set between Resolver manifests without changing their resolution order', async ({ page }, info) => {
  const from = { version: '2025.10', sets: { brand: { sources: [{ $ref: 'base.tokens.json' }] } },
    resolutionOrder: [{ $ref: '#/sets/brand' }] };
  const to = { version: '2025.10', sets: { brand: { sources: [] } }, resolutionOrder: [] };
  const files = [
    { name: 'app.resolver.json', text: JSON.stringify(from, null, 2) },
    { name: 'shared.resolver.json', text: JSON.stringify(to, null, 2) },
    { name: 'base.tokens.json', text: '{"gap":{"$type":"number","$value":4}}' },
  ];
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles(files.map(file => ({
    name: file.name, mimeType: 'application/json', buffer: Buffer.from(file.text),
  })));
  const pane = page.getByRole('main', { name: 'Token library', exact: true });
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Variants', exact: true }).click();
  const manager = page.getByRole('main', { name: 'Variants' });
  await manager.getByRole('button', { name: 'Actions for set brand', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move set…', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Move set', exact: true });
  await expect(form.getByRole('combobox', { name: 'Destination Resolver' })).toHaveValue('shared.resolver.json');
  await form.getByRole('button', { name: 'Review move' }).click();
  await expect(form.getByRole('alert')).toContainText('unique set name');
  await form.getByRole('textbox', { name: 'Set name' }).fill('foundation');
  await form.getByRole('button', { name: 'Review move' }).click();
  const review = page.getByRole('dialog', { name: 'Review set move', exact: true });
  await expect(review).toContainText('2 files changed · 1 reference updated');
  await review.getByRole('button', { name: 'Back to edit' }).click();
  await expect(review).toBeHidden();
  await expect(form.getByRole('textbox', { name: 'Set name' })).toHaveValue('foundation');
  await form.getByRole('button', { name: 'Review move' }).click();
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(manager.getByRole('heading', { name: 'Token sets', exact: true })).toBeFocused();
  await manager.getByRole('button', { name: 'Back to tokens' }).click();
  await expect(pane.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('4', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Variants', exact: true }).click();
  await expect(manager.getByRole('region', { name: 'Order of overrides' })).toContainText('Set · foundation · shared.resolver.json');
  await expect(manager.getByRole('button', { name: 'Actions for set brand', exact: true })).toHaveCount(0);

  await chooseOption(page.getByRole('combobox', { name: 'Variant configuration' }), 'shared.resolver.json');
  await expect(manager.getByRole('button', { name: 'Actions for set foundation', exact: true })).toBeVisible();
  await expect(manager.getByRole('region', { name: 'Order of overrides' }).locator('li')).toHaveCount(0);

  await openSaveReview(page);
  const download = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export patch', exact: true }).click();
  const folder = info.outputPath('checkout');
  await mkdir(folder, { recursive: true });
  await Promise.all(files.map(file => writeFile(info.outputPath('checkout', file.name), file.text)));
  execFileSync('git', ['init', '--quiet'], { cwd: folder });
  execFileSync('git', ['apply', await (await download).path()], { cwd: folder });
  expect(parseJson(await readFile(info.outputPath('checkout', 'app.resolver.json'), 'utf8'))).toMatchObject({
    sets: {}, resolutionOrder: [{ $ref: 'shared.resolver.json#/sets/foundation' }],
  });
  expect(parseJson(await readFile(info.outputPath('checkout', 'shared.resolver.json'), 'utf8'))).toMatchObject({
    sets: { foundation: { sources: [{ $ref: 'base.tokens.json' }] } }, resolutionOrder: [],
  });
});

test('validates raw shared source in Resolver contexts and repeats the impact at save review', async ({ page }) => {
  const resolver = {
    version: '2025.10', sets: { foundation: { sources: [{ $ref: 'base.tokens.json' }] } },
    modifiers: { density: { default: 'regular', contexts: { regular: [], compact: [] } } },
    resolutionOrder: [{ $ref: '#/sets/foundation' }, { $ref: '#/modifiers/density' }],
  };
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'app.resolver.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(resolver)) },
    { name: 'base.tokens.json', mimeType: 'application/json', buffer: Buffer.from('{"gap":{"$type":"number","$value":4}}') },
  ]);
  await expect(page.getByRole('main', { name: 'Token library' })).toBeVisible();
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  const source = page.getByRole('main', { name: 'Workspace management' });
  await source.getByRole('button', { name: 'base.tokens.json', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Edit token source' });
  const field = form.getByRole('textbox', { name: 'Token source JSON' });
  await field.fill('{"gap":{"$type":"number","$value":"{missing}"}}');
  await form.getByRole('button', { name: 'Review source changes' }).click();
  const review = page.getByRole('dialog', { name: 'Review changes', exact: true });
  await expect(review.getByRole('button', { name: 'Apply to workspace' })).toBeDisabled();
  await expect(review.getByRole('alert')).toContainText('gap · Reference target is missing: missing');
  await review.getByRole('button', { name: 'Back to edit' }).click();
  await expect(review).toBeHidden();
  await field.fill('{"gap":{"$type":"number","$value":9}}');
  await form.getByRole('button', { name: 'Review source changes' }).click();
  await expect(review.getByText(/app\.resolver\.json.*1 token affected/u).first()).toBeVisible();
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(review).toBeHidden();
  await openSaveReview(page);
  await expect(review.getByText(/app\.resolver\.json.*1 token affected/u).first()).toBeVisible();
  const saved = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Export patch', exact: true }).click();
  expect(await readFile(await (await saved).path(), 'utf8')).toContain('"$value":9');
});

test('downloads a token document without changing its authored bytes', async ({ page }) => {
  const input = '\uFEFF{\r\n\t"scale / stor": {\r\n\t\t"$type": "number", "$root": {"$value": 1e2},\r\n' +
    '\t\t"$extensions": {"se.example": {"nested": ["färg", {"$ref": "#/opaque"}]}}\r\n\t},\r\n' +
    '\t"alias": {"$ref": "#/scale%20~1%20stor/$root/$value", "$deprecated": false}\r\n}\r\n';
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'roundtrip.tokens.json', mimeType: 'application/design-tokens+json', buffer: Buffer.from(input),
  });
  const row = page.getByRole('grid', { name: 'Tokens' }).locator('[data-token-row="alias"]');
  await expect(row).toContainText('100');
  const requested = page.waitForEvent('download');
  await command(page, 'File', 'Export token JSON');
  const downloaded = await requested;
  expect(downloaded.suggestedFilename()).toBe('roundtrip.tokens.json');
  const bytes = await readFile(await downloaded.path());
  expect(bytes).toEqual(Buffer.from(input));
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: downloaded.suggestedFilename(), mimeType: 'application/json', buffer: bytes,
  });
  await expect(row).toContainText('100');
});

test('opens a Resolver diagnostic at its authored field', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'theme.resolver.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      version: '2025.10', resolutionOrder: [{ name: 'Base', type: 'set', sources: [{ $ref: 'base.tokens.json' }] }],
    })) },
    { name: 'base.tokens.json', mimeType: 'application/json', buffer: Buffer.from('{"gap":{"$type":"number","$value":4,"$description":12}}') },
  ]);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Variants', exact: true }).click();
  const pane = page.getByRole('main', { name: 'Variants' });
  await pane.getByText('Context source diagnostics (1)', { exact: true }).click();
  await pane.getByRole('button', { name: /gap.*\$description.*Invalid value/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit token source' });
  await expect(dialog).toContainText('base.tokens.json');
  const source = dialog.getByRole('textbox', { name: 'Token source JSON' });
  await expect(source).toBeFocused();
  await expect.poll(() => source.evaluate(node => node instanceof HTMLTextAreaElement ? node.value.slice(node.selectionStart, node.selectionEnd) : '')).toBe('12');
});

const fixtureFile = (name: string, value: object) => ({
    name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)),
  });
test('keeps the authored library available when a variant needs a choice', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    fixtureFile('appearance.resolver.json', { version: '2025.10', resolutionOrder: [
      { name: 'base', type: 'set', sources: [{ $ref: 'base.tokens.json' }, { $ref: 'shared.tokens.json' }] },
      { name: 'appearance', type: 'modifier', contexts: { light: [], dark: [{ $ref: 'dark.tokens.json' }] } },
    ] }),
    fixtureFile('base.tokens.json', { alias: { $type: 'number', $value: '{shared}' } }),
    fixtureFile('shared.tokens.json', { shared: { $type: 'number', $value: 4 } }),
    fixtureFile('dark.tokens.json', { shared: { $type: 'number', $value: 8 }, darkOnly: { $type: 'number', $value: 10 } }),
  ]);
  const pane = page.getByRole('main', { name: 'Token library', exact: true });
  const set = page.getByRole('combobox', { name: 'Editing set', exact: true });
  const appearance = pane.getByRole('group', { name: 'Preview' }).getByRole('combobox', { name: 'appearance' });
  const edit = pane.getByRole('button', { name: 'Edit token', exact: true });
  await expect(set).toHaveAttribute('data-select-value', 'base');
  await expect(edit).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Resolved value for alias', exact: true })).toHaveText('4');
  await expect(pane.getByRole('button', { name: 'New token', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Variant issues', exact: true })).toBeVisible();

  await pane.getByRole('button', { name: 'Value for shared', exact: true }).click();
  await edit.click();
  const inspector = page.getByRole('complementary', { name: 'Token details' });
  const definition = inspector.locator('[aria-label="Editing definition"]');
  const value = inspector.getByRole('textbox', { name: 'Token value', exact: true });
  await expect(definition).toContainText('shared.tokens.json');
  await expect(definition).toContainText('#/shared');
  await expect(value).toHaveValue('4');

  await chooseOption(appearance, 'dark');
  await expect(set).toHaveAttribute('data-select-value', 'base');
  await expect(pane.getByRole('button', { name: 'Resolved value for alias', exact: true })).toHaveText('8');
  await expect(pane.getByRole('button', { name: 'Name for darkOnly', exact: true })).toHaveCount(0);
  await expect(definition).toContainText('shared.tokens.json');
  await expect(value).toHaveValue('4');
  await value.fill('6');
  await inspector.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review changes' }).getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(value).toHaveValue('6');
  await expect(pane.getByRole('button', { name: 'Resolved value for alias', exact: true })).toHaveText('8');

  await chooseOption(appearance, 'light');
  await expect(pane.getByRole('button', { name: 'Resolved value for alias', exact: true })).toHaveText('6');
  await expect(definition).toContainText('shared.tokens.json');

  await chooseOption(appearance, 'dark');
  await chooseOption(set, '');
  await expect(pane.getByRole('button', { name: 'Name for darkOnly', exact: true })).toBeVisible();
  await chooseOption(set, 'base');
  await expect(appearance).toHaveAttribute('data-select-value', 'dark');
  await expect(pane.getByRole('button', { name: 'Value for shared', exact: true })).toHaveText('6');

  const nav = page.getByRole('navigation', { name: 'Foundry' });
  await nav.getByRole('button', { name: 'Workspace', exact: true }).click();
  const workspace = page.getByRole('main', { name: 'Workspace management' });
  await expect(workspace.getByRole('heading', { name: 'Workspace sync' })).toBeVisible();
  await expect(workspace.getByRole('heading', { name: 'Changes' })).toHaveCount(0);
  await expect(workspace.getByRole('heading', { name: 'GitHub', exact: true })).toBeVisible();
  await expect(workspace.getByRole('heading', { name: 'Variants' })).toHaveCount(0);
  const variants = nav.getByRole('button', { name: 'Variants', exact: true });
  await variants.click();
  await expect(variants).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main', { name: 'Variants', exact: true })).toBeVisible();
  await expect(workspace).toBeHidden();
});

const numberToken = ($value: number) => ({ $type: 'number', $value });

test('previews Light while inspecting, editing, and bulk updating Dark definitions', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    fixtureFile('appearance.resolver.json', {
      version: '2025.10', sets: { Shared: { sources: [{ $ref: 'shared.tokens.json' }] } },
      modifiers: { Appearance: { default: 'Light', contexts: {
        Light: [{ $ref: 'light.tokens.json' }], Dark: [{ $ref: 'dark.tokens.json' }],
      } } },
      resolutionOrder: [{ $ref: '#/sets/Shared' }, { $ref: '#/modifiers/Appearance' }],
    }),
    fixtureFile('shared.tokens.json', { shared: numberToken(1) }),
    fixtureFile('light.tokens.json', { gap: numberToken(4) }),
    fixtureFile('dark.tokens.json', { gap: numberToken(8), accent: numberToken(10) }),
  ]);
  const set = page.getByRole('combobox', { name: 'Editing set', exact: true });
  const preview = page.getByRole('group', { name: 'Preview' }).getByRole('combobox', { name: 'Appearance', exact: true });
  const grid = page.getByRole('grid', { name: 'Tokens', exact: true });
  const resolved = (path: string) => page.getByRole('button', { name: 'Resolved value for ' + path, exact: true });
  await expect(page.getByRole('columnheader', { name: 'Resolved in Light' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Name for gap' })).toContainText('Light');
  await chooseOption(set, { label: 'Dark' });
  await expect(preview).toHaveAttribute('data-select-value', 'Light');
  await expect(resolved('gap')).toContainText('From Light');
  await expect(resolved('gap')).toContainText('4');
  await expect(resolved('accent')).toHaveText('Not included in Light');

  await page.getByRole('button', { name: 'Name for gap' }).click();
  await page.getByRole('button', { name: 'Edit token', exact: true }).click();
  const sheet = page.getByRole('complementary', { name: 'Token details' });
  await expect(sheet.getByText('Editing Dark', { exact: true })).toBeVisible();
  const field = sheet.getByRole('textbox', { name: 'Token value', exact: true });
  await field.fill('9');
  await chooseOption(preview, 'Dark');
  await expect(field).toHaveValue('9');
  await chooseOption(preview, 'Light');
  const apply = () => page.getByRole('dialog', { name: 'Review changes' }).getByRole('button', { name: 'Apply to workspace' }).click();
  await sheet.getByRole('button', { name: 'Review changes', exact: true }).click();
  await apply();
  await sheet.getByRole('button', { name: 'Close inspector' }).click();
  const gap = page.getByRole('button', { name: 'Value for gap', exact: true });
  await expect(gap).toHaveText('9');
  await gap.dblclick();
  const inline = grid.getByRole('textbox', { name: 'Token value', exact: true });
  await inline.fill('11');
  await inline.press('Enter');
  await apply();
  await expect(gap).toHaveText('11');
  await expect(resolved('gap')).toContainText('4');

  await page.getByRole('button', { name: 'Name for accent' }).click();
  await page.getByRole('button', { name: 'Name for gap' }).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Change description', exact: true }).click();
  const bulk = page.getByRole('dialog', { name: /Change description/ });
  await expect(bulk.getByText('Editing definitions in Dark.')).toBeVisible();
  await bulk.getByRole('textbox', { name: 'New description' }).fill('Dark tokens');
  await bulk.getByRole('button', { name: 'Review edits', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review selected token edits' }).getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(page.getByRole('button', { name: 'Description for gap' })).toHaveText('Dark tokens');
  await expect(page.getByRole('button', { name: 'Description for accent' })).toHaveText('Dark tokens');
  await chooseOption(set, { label: 'All tokens' });
  await expect(page.getByRole('button', { name: 'Description for gap' })).toHaveText('');
  await expect(page.getByRole('button', { name: 'Value for gap', exact: true })).toHaveText('4');
  await command(page, 'View', 'Compare variants');
  const variants = page.getByRole('main', { name: 'Variants', exact: true });
  await expect(variants.getByText('Shared sets: Shared')).toBeVisible();
  await expect(variants.getByText('dark.tokens.json', { exact: true })).toBeVisible();
  await chooseOption(variants.getByRole('group', { name: 'Compare with' }).getByRole('combobox', { name: 'Appearance', exact: true }), 'Dark');
  const comparison = variants.getByRole('table', { name: 'Variant comparison' });
  await expect(comparison.getByRole('row', { name: /gap Changed 4 11/ })).toBeVisible();
  await expect(comparison.getByRole('row', { name: /accent Added/ })).toBeVisible();
});

test('renames, moves, duplicates and deletes an edited definition while previewing another variant', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    fixtureFile('appearance.resolver.json', {
      version: '2025.10',
      modifiers: { Appearance: { default: 'Light', contexts: {
        Light: [{ gap: numberToken(4) }],
        Dark: [{ gap: numberToken(8), group: { marker: numberToken(1) } }],
      } } },
      resolutionOrder: [{ $ref: '#/modifiers/Appearance' }],
    }),
  ]);
  const scope = page.getByRole('combobox', { name: 'Editing set', exact: true });
  await chooseOption(scope, { label: 'Dark' });
  const tokenName = (path: string) => page.getByRole('button', { name: 'Name for ' + path, exact: true });
  const menu = (path: string) => page.getByRole('button', { name: 'Token actions for ' + path, exact: true });
  const apply = (action: string) => page.getByRole('dialog', { name: 'Review ' + action + ' token', exact: true })
    .getByRole('button', { name: 'Apply to workspace' }).click();
  await tokenName('gap').press('F2');
  const rename = page.getByRole('dialog', { name: 'Rename token', exact: true });
  await rename.getByRole('textbox', { name: 'Token name', exact: true }).fill('spacing');
  await rename.getByRole('button', { name: 'Review rename' }).click();
  await apply('rename');
  await expect(tokenName('spacing')).toBeVisible();
  await menu('spacing').click();
  await page.getByRole('menuitem', { name: 'Move token' }).click();
  const move = page.getByRole('dialog', { name: 'Move token', exact: true });
  await move.getByRole('button', { name: 'group', exact: true }).click();
  await move.getByRole('button', { name: 'Review move' }).click();
  await apply('move');
  await expect(tokenName('group.spacing')).toBeVisible();
  await menu('group.spacing').click();
  await page.getByRole('menuitem', { name: 'Duplicate token' }).click();
  await page.getByRole('dialog', { name: 'Duplicate token', exact: true }).getByRole('button', { name: 'Review duplicate' }).click();
  await apply('duplicate');
  await expect(tokenName('group.spacing-copy')).toBeVisible();
  await menu('group.spacing-copy').click();
  await page.getByRole('menuitem', { name: 'Delete token' }).click();
  await page.getByRole('dialog', { name: 'Delete token', exact: true })
    .getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(tokenName('group.spacing-copy')).toHaveCount(0);
  await expect(tokenName('group.spacing')).toBeVisible();
  await chooseOption(scope, { label: 'All tokens' });
  await expect(page.getByRole('button', { name: 'Value for gap', exact: true })).toHaveText('4');
});

test('moves a token to another set and reviews the reference rewrite before applying', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    fixtureFile('structure.resolver.json', {
      version: '2025.10', sets: {
        Base: { sources: [{ $ref: 'base.tokens.json' }] },
        Components: { sources: [{ $ref: 'components.tokens.json' }] },
      }, resolutionOrder: [{ $ref: '#/sets/Base' }, { $ref: '#/sets/Components' }],
    }),
    fixtureFile('base.tokens.json', { system: { gap: numberToken(4), alias: { $type: 'number', $value: { $ref: '#/system/gap/%24value' } } } }),
    fixtureFile('components.tokens.json', { system: {} }),
  ]);
  const editingSet = page.getByRole('combobox', { name: 'Editing set', exact: true });
  await chooseOption(editingSet, { label: 'Base' });
  await page.getByRole('button', { name: 'Token actions for system.gap', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move token', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Move token', exact: true });
  await chooseOption(dialog.getByRole('combobox', { name: 'Destination set', exact: true }), { label: 'Components' });
  await dialog.getByRole('button', { name: 'system', exact: true }).click();
  await dialog.getByRole('button', { name: 'Review move', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review move token', exact: true });
  await expect(review.getByText(/Destination: Components \/ system/)).toBeVisible();
  await review.getByText('References rewritten (1)', { exact: true }).click();
  await expect(review.getByText('components.tokens.json#/system/gap/%24value', { exact: true })).toBeVisible();
  await review.getByText('Shared values · 1 token affected', { exact: true }).click();
  await expect(review.getByText('Source Base → Components', { exact: false })).toBeVisible();
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(editingSet).toHaveAttribute('data-select-value', 'Components');
  await expect(page.getByRole('button', { name: 'Value for system.gap', exact: true })).toHaveText('4');
  await chooseOption(editingSet, { label: 'Base' });
  await expect(page.getByRole('button', { name: 'Name for system.gap', exact: true })).toHaveCount(0);
});

test('paginates high-fan-out references without mounting every consumer', async ({ page }) => {
  await page.goto('/');
  const consumers = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [
    'alias-' + String(index).padStart(3, '0'), { $type: 'number', $value: '{base}' },
  ]));
  await page.locator('input[type=file][multiple]').setInputFiles([
    fixtureFile('references.tokens.json', { base: numberToken(4), ...consumers }),
  ]);
  await page.getByRole('searchbox', { name: 'Search tokens in group' }).fill('base');
  await page.getByRole('button', { name: 'Name for base', exact: true }).click();
  await page.getByRole('button', { name: 'Edit token', exact: true }).click();
  const sheet = page.getByRole('complementary', { name: 'Token details' });
  const usedBy = sheet.getByRole('list', { name: 'Used by', exact: true });
  await expect(usedBy.getByRole('listitem')).toHaveCount(24);
  await expect(sheet.getByText('1–24 of 400', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Next direct uses', exact: true }).click();
  await expect(usedBy.getByRole('listitem')).toHaveCount(24);
  await expect(sheet.getByText('25–48 of 400', { exact: true })).toBeVisible();
  await expect(usedBy.getByRole('button', { name: /^alias-024\b/u })).toBeVisible();
});

test('column resizing responds to pointer and keyboard without changing an unrelated column', async ({ page }) => {
  await page.goto('/');
  const nameColumn = page.getByRole('columnheader', { name: /^Name(?: |$)/u });
  const typeColumn = page.getByRole('columnheader', { name: /^Type(?: |$)/u });
  const descriptionColumn = page.getByRole('columnheader', { name: /^Description(?: |$)/u });
  const descriptionWidth = async () => (await descriptionColumn.boundingBox())?.width ?? 0;
  const width = async () => (await nameColumn.boundingBox())?.width ?? 0;
  const initialWidth = await width();
  const initialTypeWidth = (await typeColumn.boundingBox())?.width;
  const resize = page.getByRole('slider', { name: /Resize Name column/u });
  const handle = await nameColumn.locator('.column-resizer').boundingBox();
  if (!handle) throw new Error('The resize handle is missing.');
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 48, y, { steps: 4 });
  await page.mouse.up();
  expect(await width()).toBeGreaterThan(initialWidth);
  expect((await typeColumn.boundingBox())?.width).toBe(initialTypeWidth);
  const pointerWidth = await width();
  await resize.press('Enter');
  await resize.press('ArrowRight');
  await resize.press('Enter');
  expect(await width()).toBeGreaterThan(pointerWidth);
  const resizeDescription = page.getByRole('slider', { name: /Resize Description column/u });
  const descriptionBefore = await descriptionWidth();
  await resizeDescription.press('Enter');
  await resizeDescription.press('ArrowLeft');
  await resizeDescription.press('Enter');
  expect(await descriptionWidth()).toBeLessThan(descriptionBefore);
});
