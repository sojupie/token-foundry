import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { baseChanged, isProposal } from '../../integrations/github/contract.ts';
import { parseJson } from '../../lib/json.ts';
import type { JsonValue } from '../../lib/json.ts';
import type { PullRequestProposal } from '../../integrations/github/contract.ts';

const sources = await Promise.all(['reference.tokens.json', 'system.tokens.json'].map(async (path) => ({
  path, text: await readFile(new URL('../../examples/' + path, import.meta.url), 'utf8'),
})));
const referenceChange = { schemaVersion: 1, changes: [
  { path: 'reference.space.small', before: { value: 8, unit: 'px' }, after: { value: 12, unit: 'px' } },
] };

async function command(page: Page, menu: 'File' | 'Edit' | 'View' | 'Variants' | 'Integrations', item: string | RegExp) {
  if (menu === 'Integrations') await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: menu, exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

async function openProposal(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await command(page, 'File', 'Import proposal…');
  const dialog = page.getByRole('dialog', { name: 'Import proposal' });
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
  await expect(page.getByText('Connected as @designer', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Repository', { exact: true })).toHaveValue(repository);
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
  await page.getByRole('button', { name: 'Review pull request' }).click();
  await page.getByText('Show file changes', { exact: true }).click();
  await expect(diff).toContainText('{system.reference-space.small}');
  expect(requests).toEqual(['/git/open']);
  await page.getByRole('button', { name: 'Create pull request', exact: true }).click();
  const refresh = page.getByRole('button', { name: 'Review latest revision', exact: true });
  await expect(refresh).toBeVisible();
  const changedFile = sources.find(({ path }) => path === 'reference.tokens.json');
  if (!changedFile) throw new Error('Missing reference fixture.');
  snapshot = { ...snapshot, revision: latestRevision, files: [
    { path: changedFile.path, text: changedFile.text.replace('"value": 8', '"value": 10') },
    ...sources.filter(({ path }) => path !== changedFile.path),
  ] };
  await refresh.click();
  await expect(page.getByText(/reference\.tokens\.json changed in the repository/u)).toBeVisible();
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
  await page.getByRole('button', { name: 'Create pull request', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View pull request' })).toHaveAttribute('href', url);
  expect(requests).toEqual(['/git/open', '/git/propose', '/git/open', '/git/open', '/git/propose']);
  expect(proposal).toMatchObject({ revision: snapshot.revision, repository, changes: sources.map(({ path, text }) => ({ path, before: text })) });
  expect(proposal?.changes.find(({ path }) => path === 'system.tokens.json')?.after).toContain('{system.reference-space.small}');
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
  }, sources);
  await page.goto('/');
  await command(page, 'File', 'Open token folder…');
  await expect(page.locator('[data-workspace-name]')).toHaveText('fixture');
  await openProposal(page);
  await page.getByRole('button', { name: 'Review and save' }).click();
  const save = page.getByRole('button', { name: 'Save to folder' });
  const writeSystem = (text: string) => page.evaluate(async (value) => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('fixture');
    const stream = await (await directory.getFileHandle('system.tokens.json')).createWritable();
    await stream.write(value);
    await stream.close();
  }, text);
  const system = sources.find(({ path }) => path === 'system.tokens.json')?.text;
  if (!system) throw new Error('Missing system fixture.');
  await writeSystem(system + '\n');
  await save.click();
  await expect(page.getByText(/system\.tokens\.json changed on disk/u)).toBeVisible();
  const readReference = () => page.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('fixture');
    return (await (await directory.getFileHandle('reference.tokens.json')).getFile()).text();
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
  await command(page, 'File', 'Open token folder…');
  await (await chooser).setFiles(directory);
  await expect(page.getByRole('button', { name: 'Review and save' })).toHaveCount(0);
  await openProposal(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Download patch', exact: true }).click();
  execFileSync('git', ['apply', '--check', await (await download).path()], { cwd: directory });
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
  if (benchmark) await command(page, 'File', 'Open Material 3 sample');
  else {
    const chooser = page.waitForEvent('filechooser');
    await command(page, 'File', 'Open token files…');
    await (await chooser).setFiles(fallback);
  }
  await expect(page.getByText(benchmark ? '6,818 tokens' : '2 tokens', { exact: true })).toBeVisible();
  const toolbar = page.getByRole('main').getByRole('region', { name: 'Token commands' });
  const search = toolbar.getByRole('searchbox', { name: 'Search tokens in group' });
  await expect(search).toBeVisible();
  await expect(page.getByRole('banner').getByRole('searchbox')).toHaveCount(0);
  await page.setViewportSize({ width: 2560, height: 880 });
  expect((await search.boundingBox())?.width).toBeLessThanOrEqual(300);
  await expect(toolbar.getByText('0 selected', { exact: true })).toHaveCount(0);
  const nameColumn = page.getByRole('columnheader', { name: /^Name(?: |$)/u });
  const typeColumn = page.getByRole('columnheader', { name: /^Type(?: |$)/u });
  const descriptionColumn = page.getByRole('columnheader', { name: /^Description(?: |$)/u });
  const table = page.getByRole('grid', { name: 'Tokens', exact: true });
  const paneWidth = await table.evaluate(node => node.parentElement?.clientWidth ?? 0);
  const tableWidth = async () => (await table.boundingBox())?.width ?? 0;
  const descriptionWidth = async () => (await descriptionColumn.boundingBox())?.width ?? 0;
  expect(await tableWidth()).toBeCloseTo(paneWidth, 0);
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
  expect(await width()).toBeGreaterThan(initialWidth + 40);
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
  await page.setViewportSize({ width: 1075, height: 880 });
  const layout = () => Promise.all([
    search.boundingBox(),
    page.getByRole('columnheader', { name: /^Name(?: |$)/u }).boundingBox(),
  ]);
  const initial = await layout();
  await table.locator('thead .selection-checkbox').click();
  await expect(toolbar.getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
  await expect(toolbar.getByRole('button', { name: 'New token' })).toBeVisible();
  expect((await layout())[1]?.y).toBe(initial[1]?.y);
  const tree = page.getByRole('navigation', { name: 'Token groups' });
  await page.getByRole('button', { name: 'Hide groups sidebar', exact: true }).click();
  await expect(tree).toBeHidden();
  await page.getByRole('button', { name: 'Show groups sidebar', exact: true }).click();
  await expect(tree).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'New token' })).toBeVisible();
  expect((await layout())[1]?.y).toBe(initial[1]?.y);
  const rootGroup = benchmark ? 'goog' : 'base';
  await tree.getByRole('button', { name: rootGroup, exact: true }).click();
  await expect(toolbar.getByRole('button', { name: 'New token' })).toBeVisible();
  const [groupSearch, groupColumn] = await layout();
  expect(groupSearch?.y).toBe(initial[0]?.y);
  expect(groupColumn).toEqual(initial[1]);
  await tree.getByRole('button', { name: 'All tokens', exact: true }).click();
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
  const rowHeight = (await token.boundingBox())?.height;
  await value.press('F2');
  const picker = page.getByRole('dialog', { name: 'Link a token' });
  const referenceSearch = picker.getByRole('searchbox', { name: 'Search tokens' });
  await expect(referenceSearch).toBeFocused();
  expect((await token.boundingBox())?.height).toBe(rowHeight);
  await referenceSearch.fill(benchmark ? 'label large weight' : 'scale');
  await expect(picker.getByRole('button', { name: rootPath, exact: true })).toBeVisible();
  await referenceSearch.clear();
  const hierarchy = picker.getByRole('navigation', { name: 'Reference groups' });
  const branch = benchmark ? ['md', 'sys', 'typescale', 'label-large', 'weight'] : ['base', 'scale'];
  await branch.reduce(async (previous, group) => {
    await previous;
    await hierarchy.getByRole('button', { name: group, exact: true }).click();
  }, Promise.resolve());
  await picker.getByRole('button', { name: rootPath, exact: true }).click();
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
  await expect(page.getByText('Connected as @designer', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to GitHub', exact: true })).toHaveCount(0);
  await page.getByLabel('Repository', { exact: true }).selectOption('other/design-system');
  await expect(page.getByLabel('Repository', { exact: true })).toHaveValue('other/design-system');
  repositories = ['example/tokens'];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Repository', { exact: true })).toHaveValue('example/tokens');
  await expect(page.getByRole('option', { name: 'other/design-system', exact: true })).toHaveCount(0);
  session = 'forbidden';
  await page.reload();
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Open GitHub repository…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Download token JSON', exact: true })).toBeDisabled();
});

test('edits cells, rewrites references, and reviews bulk move and group delete', async ({ page }) => {
  await page.route('**/git/session', (route) => route.fulfill({ status: 401, json: {} }));
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await command(page, 'File', 'Open token files…');
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
  const row = page.getByRole('row').filter({ has: value });
  const height = (await row.boundingBox())?.height;
  await value.fill('bad dimension');
  await value.press('Enter');
  await expect(value).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert')).toContainText('Enter a value');
  await value.fill('12 px');
  expect((await row.boundingBox())?.height).toBe(height);
  await page.getByRole('button', { name: 'Name for reference.spare', exact: true }).click();
  await expect(value).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'system.gap' })).toContainText('{reference.compact}');
  await expect(page.getByRole('row').filter({ hasText: 'system.gap' })).toContainText('12 px');

  const typeCell = page.getByRole('button', { name: 'Type for reference.extra', exact: true });
  await typeCell.dblclick();
  await page.getByLabel('Token type', { exact: true }).selectOption('dimension');
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
  await page.getByLabel('Token type', { exact: true }).selectOption('number');
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
  await expect(page.getByRole('main').locator('footer').getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Name for reference.compact', exact: true }).press('Shift+F10');
  await page.getByRole('menuitem', { name: 'References', exact: true }).click();
  const references = page.getByRole('complementary', { name: 'Token details' });
  await expect(references.getByText('reference.compact', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(references).toBeHidden();
  const search = toolbar.getByRole('searchbox');
  await search.fill('compact');
  await expect(page.getByRole('main').locator('footer').getByText('2 selected · 2 not shown', { exact: true })).toBeVisible();
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
  await expect(type).toHaveValue('color');
  await type.selectOption('fontFamily');
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
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review changes', exact: true });
  await expect(review.getByRole('status')).toContainText('Foundry needs valid JSON to check references');
  await expect(review.getByRole('status')).toContainText('broken.tokens.json');
  await review.getByRole('button', { name: 'Back to edit' }).click();
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
  await editor.getByLabel('Source file').selectOption('reference.tokens.json');
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
  await table.locator('[data-token-row="reference.color.ink"] .selection-checkbox').click();
  await expect(all).toHaveJSProperty('indeterminate', true);
  const actions = page.getByRole('region', { name: 'Token commands' });
  const move = actions.getByRole('button', { name: 'Move', exact: true });
  const clear = page.getByRole('main').locator('footer').getByRole('button', { name: 'Clear selection' });
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
  const context = page.getByRole('region', { name: 'Group context' });
  const groupActions = page.getByRole('complementary', { name: 'Groups' });
  const referenceToggle = tree.getByRole('button', { name: /^(Expand|Collapse) reference$/u });
  const systemToggle = tree.getByRole('button', { name: /^(Expand|Collapse) system$/u });

  await reference.click();
  await expect(context.getByRole('heading')).toHaveText('reference');
  await expect(referenceToggle).toHaveAttribute('aria-expanded', 'false');
  const closedFolderIcon = reference.locator('.md-list-leading svg');
  await expect(closedFolderIcon).toHaveClass(/lucide-folder\b/u);
  await referenceToggle.press('Space');
  await expect(referenceToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(closedFolderIcon).toHaveClass(/lucide-folder-open\b/u);
  const folderIcon = await closedFolderIcon.boundingBox();
  const childIcon = await tree.getByRole('button', { name: 'space', exact: true }).locator('.md-list-leading svg').boundingBox();
  const chevron = await referenceToggle.boundingBox();
  expect(folderIcon).not.toBeNull();
  expect(childIcon).not.toBeNull();
  expect(chevron).not.toBeNull();
  if (folderIcon && childIcon && chevron) {
    expect(childIcon.x).toBeGreaterThan(folderIcon.x);
    expect(chevron.x).toBeGreaterThan(folderIcon.x);
    expect(chevron.y + chevron.height / 2).toBeCloseTo(folderIcon.y + folderIcon.height / 2);
  }
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
  const menuPosition = await menu.boundingBox();
  await reference.dblclick();
  await expect(referenceToggle).toHaveAttribute('aria-expanded', 'true');
  await tree.getByRole('button', { name: 'space', description: 'reference.space', exact: true }).click();
  const childMenu = groupActions.getByRole('button', { name: 'Actions for reference / space', exact: true });
  await expect(childMenu).toBeVisible();
  const childMenuPosition = await childMenu.boundingBox();
  expect(childMenuPosition?.x).toBe(menuPosition?.x);
});

test('resizes both panes and keeps the empty inspector open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await command(page, 'View', 'Edit token');
  const inspector = page.getByRole('complementary', { name: 'Token details' });
  await expect(inspector.getByText('Select a token to see its details.')).toBeVisible();
  const right = page.getByRole('slider', { name: 'Resize token details' });
  await right.press('ArrowLeft');
  await expect(inspector).toHaveCSS('width', '312px');
  const groups = page.getByRole('complementary', { name: 'Groups' });
  const left = page.getByRole('slider', { name: 'Resize groups sidebar' });
  const handle = await left.boundingBox();
  if (!handle) throw new Error('Group resize handle is missing.');
  await page.mouse.move(handle.x + 4, handle.y + 40);
  await page.mouse.down();
  await page.mouse.move(handle.x + 52, handle.y + 40);
  await expect(groups).toHaveCSS('width', '300px');
  await page.mouse.up();
  await expect(groups).toHaveCSS('width', '300px');
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
  const navigation = page.getByRole('navigation', { name: 'Foundry' });
  await navigation.getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workspace management' })).toBeVisible();
  await navigation.getByRole('button', { name: 'Tokens', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search tokens in group' });
  await expect(search.locator('..')).toHaveCSS('border-radius', '17px');
  await search.fill('ink');
  await page.getByRole('button', { name: 'Clear token search' }).click();
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
  await inspector.getByRole('combobox', { name: 'Token type' }).selectOption('color');
  await inspector.getByRole('textbox', { name: 'Token value' }).fill('#123456');
  await inspector.getByRole('textbox', { name: 'Description' }).fill('Ink for text');
  await inspector.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Rename token' });
  await expect(review).toContainText('1 reference updated');
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(inspector.getByRole('textbox', { name: 'Token name' })).toHaveValue('dark-ink');
  await expect(inspector.getByRole('textbox', { name: 'Token value' })).toHaveValue('#123456');
  await expect(inspector.getByRole('combobox', { name: 'Token type' })).toHaveValue('color');
  await expect(inspector.getByRole('textbox', { name: 'Description' })).toHaveValue('Ink for text');
  await inspector.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await expect(inspector).toBeHidden();
  await expect(page.getByRole('button', { name: 'Value for reference.color.dark-ink', exact: true })).toHaveText('#123456');
  await expect(page.getByRole('button', { name: 'Value for system.color.text', exact: true })).toContainText('{reference.color.dark-ink}');
});

test('keeps the menu surface rounded on click and shows keyboard row focus', async ({ page }) => {
  await page.goto('/');
  const file = page.getByRole('button', { name: 'File', exact: true });
  await file.click();
  const menu = page.getByRole('menu', { name: 'File' });
  await expect(menu).toBeFocused();
  await expect(menu).toHaveCSS('outline-style', 'none');
  await expect(menu.locator('..')).toHaveCSS('border-radius', '16px');
  await page.keyboard.press('ArrowDown');
  const item = menu.getByRole('menuitem', { name: 'Open token files…', exact: true });
  await expect(item).toBeFocused();
  await expect(item).toHaveCSS('outline-style', 'solid');
  await expect(item).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.keyboard.press('Escape');
  await expect(file).toBeFocused();
});

test('highlights menu items on hover without flashing on outside dismissal', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Integrations' });
  const item = menu.getByRole('menuitem', { name: 'Open GitHub repository…' });

  await item.hover();
  await expect(item).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.mouse.move(850, 500);
  await expect(item).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.mouse.down();
  // The menu stays mounted between pointerdown and release.
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => { requestAnimationFrame(() => resolve()); });
  }));
  await expect(item).toBeVisible();
  await expect(item).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.mouse.up();
  await expect(menu).toBeHidden();
});

test('keeps keyboard focus in the grid independently of checked rows', async ({ page }) => {
  await page.route('**/git/session', route => route.fulfill({ status: 401, json: {} }));
  await page.goto('/');
  const grid = page.getByRole('grid', { name: 'Tokens' });
  const name = (path: string) => grid.getByRole('button', { name: 'Name for reference.color.' + path, exact: true });
  const check = (path: string) => grid.locator('[data-token-row="reference.color.' + path + '"]').getByRole('checkbox');
  await name('ink').click();
  await expect(check('ink')).toBeChecked();
  await name('ocean').click({ modifiers: ['Shift'] });
  await expect(check('paper')).toBeChecked();
  await expect(check('ocean')).toBeChecked();
  await page.keyboard.press('Shift+ArrowUp');
  await expect(name('paper')).toBeFocused();
  await expect(check('ocean')).not.toBeChecked();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(grid.getByRole('button', { name: 'Value for reference.color.paper', exact: true })).toBeFocused();
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
  await expect(menu.getByRole('menuitem', { name: 'Open token files…' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Open token folder…' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(file).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'View', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  const variants = page.getByRole('button', { name: 'Variants', exact: true });
  await expect(variants).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Set up variants…', exact: true })).toBeFocused();
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
  await page.getByLabel('Inherit from group').selectOption({ label: 'base · inheritance.tokens.json' });
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
  await metadata.getByLabel('Default type').selectOption('color');
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
  await finder.getByRole('searchbox', { name: 'Search tokens' }).fill('$root');
  await finder.getByRole('button', { name: 'spacing.$root', exact: true }).click();
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
  await finder.getByRole('button', { name: /components \/ 0/iu }).click();
  await finder.getByRole('button', { name: 'Link token', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resolved value for theme.channel', exact: true })).toHaveText('0.25');
  await expect(page.getByRole('button', { name: 'Resolved value for theme.alias', exact: true })).toHaveText('0.25');
  await command(page, 'View', 'Edit token');
  const inspector = page.getByRole('complementary', { name: 'Token details' });
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
  const available = finder.getByRole('button', { name: /components \/ 0/iu });
  await expect(available).toBeFocused();
  await expect(finder.getByRole('button', { name: /components \/ [12]/u })).toHaveCount(0);
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
  await command(page, 'View', 'Edit token');
  const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
  await expect(inspector.getByLabel('Color preview')).toBeVisible();
  await inspector.getByLabel('Color space', { exact: true }).selectOption('oklch');
  await inspector.getByRole('textbox', { name: 'Lightness', exact: true }).fill('0.72');
  await inspector.getByText('Advanced color options', { exact: true }).click();
  await inspector.getByText('Missing hue', { exact: true }).click();
  await inspector.getByRole('textbox', { name: 'Alpha', exact: true }).fill('0.4');
  await inspector.getByRole('textbox', { name: 'Fallback hex', exact: true }).fill('#22AA33');
  await inspector.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
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
  await create.getByLabel('Token type', { exact: true }).selectOption('duration');
  const value = create.getByRole('textbox', { name: 'Token value', exact: true });
  await value.fill('');
  await value.pressSequentially('1.25');
  await create.getByLabel('Unit', { exact: true }).selectOption('s');
  await create.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review changes', exact: true }).getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for animation-time', exact: true })).toHaveText('1.25 s');
  await command(page, 'View', 'Edit token');
  const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
  await expect(inspector.getByRole('textbox', { name: 'Token value', exact: true })).toHaveValue('1.25');
  await expect(inspector.getByLabel('Unit', { exact: true })).toHaveValue('s');
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
  await command(page, 'View', 'Edit token');
  const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
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
  expect(parseJson(await raw.inputValue())).toEqual({
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
  await command(page, 'View', 'Edit token');
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
  await inspector.getByLabel('Stroke format', { exact: true }).selectOption('pattern');
  await inspector.getByLabel('Line cap', { exact: true }).selectOption('round');
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
  await command(page, 'View', 'Edit token');
  const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
  await inspector.getByRole('textbox', { name: 'Red', exact: true }).fill('0.35');
  const type = inspector.getByLabel('Token type', { exact: true });
  await type.selectOption('dimension');
  await inspector.getByRole('textbox', { name: 'Token value', exact: true }).fill('8');
  await type.selectOption('color');
  await expect(inspector.getByRole('textbox', { name: 'Red', exact: true })).toHaveValue('0.35');
  await expect(inspector.getByRole('textbox', { name: 'Alpha', exact: true })).toHaveValue('0.5');
  await type.selectOption('dimension');
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
    await create.getByLabel('Token type', { exact: true }).selectOption(type);
    await create.getByRole('button', { name: 'Review changes', exact: true }).press('Enter');
    const review = page.getByRole('dialog', { name: 'Review changes', exact: true });
    await review.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
    const cell = page.getByRole('button', { name: 'Value for ' + path, exact: true });
    await expect(cell).toBeVisible();

    const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
    if (!await inspector.isVisible()) await command(page, 'View', 'Edit token');
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
  await command(page, 'File', 'Download token JSON');
  const download = await downloading;
  const text = await readFile(await download.path(), 'utf8');
  expect(parseJson(text)).toMatchObject({
    target: Object.fromEntries(Object.entries(values).map(([type, value]) => [type, { $type: type, $value: value }])),
    ...Object.fromEntries(Object.keys(values).map(type => ['new-' + type, { $type: type, $value: '{target.' + type + '}' }])),
  });
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'reopened.tokens.json', mimeType: 'application/json', buffer: Buffer.from(text),
  });
  await expect(page.getByRole('banner').getByText('reopened.tokens.json', { exact: true })).toBeVisible();
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
  await command(page, 'View', 'Edit token');
  const inspector = page.getByRole('complementary', { name: 'Token details', exact: true });
  const red = inspector.getByRole('textbox', { name: 'Red', exact: true });
  const green = inspector.getByRole('textbox', { name: 'Green', exact: true });
  const resize = page.getByRole('slider', { name: 'Resize token details' });
  const fieldY = (field: typeof red) => field.evaluate(node => node.getBoundingClientRect().y);
  await expect.poll(() => fieldY(green)).toBeGreaterThan(await fieldY(red));
  await resize.press('End');
  await expect.poll(() => fieldY(green)).toBe(await fieldY(red));
  await red.fill('0.8');
  await green.locator('..').locator('[data-slot="trailing-icon"]').getByRole('button', { name: 'Link Green', exact: true }).click();
  const finder = page.getByRole('dialog', { name: 'Link a token', exact: true });
  await finder.getByRole('button', { name: 'Browse fields in shade', exact: true }).click();
  await expect(finder.getByRole('button', { name: /components \/ 1/u })).toHaveCount(0);
  await finder.getByRole('button', { name: /components \/ 0/iu }).click();
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
  await expect(pane.getByRole('heading', { name: 'Theme workspace' })).toBeVisible();
  await pane.getByRole('group', { name: 'Active variant', exact: true }).getByLabel('theme', { exact: true }).selectOption('dark');
  await pane.getByRole('button', { name: 'Name for gap', exact: true }).click();
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
  await pane.getByRole('button', { name: 'Compare variants', exact: true }).click();
  const table = pane.getByRole('table', { name: 'Variant comparison' });
  await expect(table.getByRole('row', { name: /padding Changed 20 4/u })).toBeVisible();
  const snapshotWait = page.waitForEvent('download');
  await pane.getByRole('button', { name: 'Download resolved tokens' }).click();
  const snapshot = await snapshotWait;
  expect(parseJson(await readFile(await snapshot.path(), 'utf8'))).toMatchObject({ gap: { $value: 20 }, padding: { $value: 20 } });
  const bundleWait = page.waitForEvent('download');
  await pane.getByRole('button', { name: 'Download editable sources (.zip)', exact: true }).click();
  const bundle = await bundleWait;
  const { unzipSync, strFromU8 } = await import('fflate');
  const unpacked = unzipSync(new Uint8Array(await readFile(await bundle.path())));
  expect(strFromU8(unpacked['base.tokens.json'] ?? new Uint8Array())).toBe(baseSource);
  expect(parseJson(strFromU8(unpacked['dark.tokens.json'] ?? new Uint8Array()))).toMatchObject({ gap: { $value: 20 } });
  expect(parseJson(strFromU8(unpacked['theme.resolver.json'] ?? new Uint8Array()))).toMatchObject({
    modifiers: { theme: { contexts: { dark: [{ $ref: 'dark.tokens.json' }] } } },
  });

  await command(page, 'Variants', 'Return to active variant');
  await pane.getByRole('group', { name: 'Active variant', exact: true }).getByLabel('theme', { exact: true }).selectOption('light');
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
  await command(page, 'Variants', 'Set up variants…');
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
  await expect(pane.getByRole('heading', { name: 'Density example' })).toBeVisible();
  const table = pane.getByRole('grid', { name: 'Tokens' });

  await pane.getByRole('button', { name: 'New token set', exact: true }).click();
  const set = page.getByRole('dialog', { name: 'New token set', exact: true });
  await set.getByRole('textbox', { name: 'Set name' }).fill('Extras');
  await set.getByRole('combobox', { name: 'Open file or set' }).selectOption({ label: 'base.tokens.json' });
  await set.getByRole('button', { name: 'Add source' }).click();
  await set.getByRole('button', { name: 'Add inline tokens' }).click();
  await set.getByRole('textbox', { name: 'Source 2 · Inline tokens' }).fill('{"accent":{"$type":"number","$value":7}}');
  await set.getByRole('button', { name: 'Move source 2 up' }).click();
  await set.getByRole('button', { name: 'Add reference' }).click();
  await set.getByRole('button', { name: 'Remove source 3' }).click();
  await expect(set.getByRole('button', { name: 'Add reference' })).toBeFocused();
  await set.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('dialog', { name: 'Review changes', exact: true }).getByRole('button', { name: 'Back to edit' }).click();
  await expect(set.getByRole('textbox', { name: 'Set name' })).toHaveValue('Extras');
  await set.getByRole('button', { name: 'Review changes' }).click();
  await apply();

  await pane.getByRole('button', { name: 'New variant option', exact: true }).click();
  const modifier = page.getByRole('dialog', { name: 'New variant option', exact: true });
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
  await spacious.getByRole('textbox', { name: 'Source 1 · Inline tokens' }).fill('{"gap":{"$type":"number","$value":16}}');
  await modifier.getByRole('combobox', { name: 'Default option' }).selectOption({ label: 'spacious' });
  await modifier.getByRole('button', { name: 'Review changes' }).click();
  await apply();

  await pane.getByRole('button', { name: 'Add to override order' }).click();
  const entry = page.getByRole('dialog', { name: 'Add to override order' });
  await entry.getByLabel('Entry', { exact: true }).selectOption({ label: 'Set · Extras' });
  await entry.getByRole('button', { name: 'Review changes' }).click();
  await apply();
  await expect(table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for accent', exact: true }) }).getByText('7', { exact: true })).toBeVisible();

  await pane.getByRole('button', { name: 'Add to override order' }).click();
  await entry.getByLabel('Entry', { exact: true }).selectOption({ label: 'Modifier · density' });
  await entry.getByRole('button', { name: 'Review changes' }).click();
  await apply();
  await expect(table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('16', { exact: true })).toBeVisible();

  await pane.getByRole('button', { name: 'Add to override order' }).click();
  await entry.getByRole('textbox', { name: 'Inline entry JSON' }).fill(
    '{"name":"Late","type":"set","sources":[{"gap":{"$type":"number","$value":30}}]}',
  );
  await entry.getByRole('button', { name: 'Review changes' }).click();
  await apply();
  await expect(table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('30', { exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Move Late up', exact: true }).press('Enter');
  await apply();
  await expect(table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('16', { exact: true })).toBeVisible();
  await pane.getByRole('group', { name: 'Active variant' }).getByLabel('density', { exact: true }).selectOption('compact');
  await expect(table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('30', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const patch = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Download patch', exact: true }).click();
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
  await command(page, 'File', 'Open token folder…');
  await expect(page.locator('[data-workspace-name]')).toHaveText('resolver-fixture');
  await command(page, 'Variants', 'Set up variants…');
  const create = page.getByRole('dialog', { name: 'Set up variants', exact: true });
  await create.getByRole('textbox', { name: 'Configuration name' }).fill('Folder theme');
  await create.getByRole('button', { name: 'Set up variants' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Review and save', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save to folder' }).click();
  await expect(page.getByRole('main', { name: 'Token library' }).getByText('Saved to folder.', { exact: true })).toBeVisible();
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
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles([
    { name: 'base.tokens.json', mimeType: 'application/json', buffer: Buffer.from(base) },
    { name: 'consumer.tokens.json', mimeType: 'application/json', buffer: Buffer.from(consumer) },
  ]);
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  const management = page.getByRole('region', { name: 'Workspace management' });
  const newFile = management.getByRole('button', { name: 'New source file' });
  await newFile.click();
  await page.getByRole('textbox', { name: 'File path' }).fill('nested/unused.tokens.json');
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

  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const patch = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Download patch', exact: true }).click();
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
  await command(page, 'File', 'Open token folder…');
  await expect(page.locator('[data-workspace-name]')).toHaveText('source-move-fixture');
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for base.tokens.json' }).click();
  await page.getByRole('menuitem', { name: 'Rename or move…' }).click();
  await page.getByRole('textbox', { name: 'File path' }).fill('theme/brand colors.tokens.json');
  await page.getByRole('button', { name: 'Review file change' }).click();
  await page.getByRole('dialog', { name: 'Move source file' }).getByRole('button', { name: 'Apply to workspace' }).click();
  await page.getByRole('button', { name: 'Review and save' }).click();
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
  await pane.getByRole('button', { name: 'Manage variants' }).click();
  await pane.getByRole('button', { name: 'Actions for set brand' }).click();
  await page.getByRole('menuitem', { name: 'Rename set…' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename set', exact: true });
  await rename.getByRole('textbox', { name: 'Set name' }).fill('foundation');
  await rename.getByRole('button', { name: 'Review rename' }).click();
  const review = page.getByRole('dialog', { name: 'Review set rename', exact: true });
  await expect(review).toContainText('1 reference updated');
  await review.getByText('Show file changes', { exact: true }).click();
  await expect(review.getByRole('region', { name: 'File changes' })).toContainText('#/sets/foundation');
  await review.getByRole('button', { name: 'Apply to workspace' }).click();
  await expect(pane.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('4', { exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Actions for set foundation' }).click();
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
  const checkbox = (path: string) => grid.locator('[data-token-row="' + path + '"] .selection-checkbox');
  await checkbox('small').click();
  await checkbox('large').click();
  const trigger = page.getByRole('button', { name: 'Change value', exact: true });
  await trigger.click();
  const form = page.getByRole('dialog', { name: 'Change value · 2 tokens', exact: true });
  await form.getByLabel('Part to change').selectOption({ label: 'Value' });
  await form.getByText('Mixed values', { exact: true }).click();
  await expect(form.getByRole('region', { name: 'Current values' })).toContainText('12');
  await form.getByRole('button', { name: 'Review edits' }).click();
  await expect(form.getByRole('alert')).toContainText('Enter a replacement value');
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
  await change.getByLabel('New token type').selectOption('dimension');
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
  await grid.locator('[data-token-row="brand.base"] .selection-checkbox').click();
  await grid.locator('[data-token-row="brand.ref"] .selection-checkbox').click();
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
  const definition = pane.getByRole('button', { name: 'Manage variants', exact: true });
  await definition.click();
  await pane.getByRole('button', { name: 'Actions for set brand', exact: true }).click();
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
  await expect(definition).toBeFocused();
  await expect(pane.getByRole('row').filter({ has: page.getByRole('button', { name: 'Name for gap', exact: true }) }).getByText('4', { exact: true })).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Order of overrides' })).toContainText('shared.resolver.json#/sets/foundation');
  await expect(pane.getByRole('button', { name: 'Actions for set brand', exact: true })).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Variant configuration' }).selectOption('shared.resolver.json');
  await expect(pane.getByRole('button', { name: 'Actions for set foundation', exact: true })).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Order of overrides' }).locator('li')).toHaveCount(0);

  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Download patch', exact: true }).click();
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
  const source = page.getByRole('region', { name: 'Workspace management' });
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
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(review.getByText(/app\.resolver\.json.*1 token affected/u).first()).toBeVisible();
  const saved = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Download patch', exact: true }).click();
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
  await command(page, 'File', 'Download token JSON');
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
  const pane = page.getByRole('main', { name: 'Token library' });
  await pane.getByText('Context source diagnostics (1)', { exact: true }).click();
  await pane.getByRole('button', { name: /gap.*\$description.*Invalid value/u }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit token source' });
  await expect(dialog).toContainText('base.tokens.json');
  const source = dialog.getByRole('textbox', { name: 'Token source JSON' });
  await expect(source).toBeFocused();
  await expect.poll(() => source.evaluate(node => node instanceof HTMLTextAreaElement ? node.value.slice(node.selectionStart, node.selectionEnd) : '')).toBe('12');
});
