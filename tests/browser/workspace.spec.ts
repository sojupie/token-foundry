import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { baseChanged, isProposal } from '../../integrations/github/contract.ts';
import type { PullRequestProposal } from '../../integrations/github/contract.ts';

const sources = await Promise.all(['reference.tokens.json', 'system.tokens.json'].map(async (path) => ({
  path, text: await readFile(new URL('../../examples/' + path, import.meta.url), 'utf8'),
})));
const referenceChange = { schemaVersion: 1, changes: [
  { path: 'reference.space.small', before: { value: 8, unit: 'px' }, after: { value: 12, unit: 'px' } },
] };

async function command(page: Page, menu: 'File' | 'Integrations', item: string | RegExp) {
  await page.getByRole('menubar', { name: 'Workspace commands' }).getByRole('menuitem', { name: menu, exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

async function openProposal(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await command(page, 'File', 'Import value changes…');
  const dialog = page.getByRole('dialog', { name: 'Import value changes' });
  await expect(dialog).toContainText('Choose a file with edits to the tokens you have open.');
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  await (await chooser).setFiles({
    name: 'token-proposal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(referenceChange)),
  });
  const review = page.getByRole('dialog', { name: 'Review value changes' });
  await expect(review).toContainText('keeps your other edits');
  await expect(review.getByRole('row', { name: /reference\.space\.small 8 px 12 px/u })).toBeVisible();
  await review.getByRole('button', { name: 'Apply changes', exact: true }).click();
}

test('reviews a linked proposal and cross-file move again if the pinned GitHub revision changes', async ({ page }) => {
  const revision = 'a'.repeat(40);
  const latestRevision = 'b'.repeat(40);
  const repository = 'example/tokens';
  const url = 'https://github.com/' + repository + '/pull/7';
  const requests: string[] = [];
  let proposal: PullRequestProposal | undefined;
  let snapshot = { repository, revision, files: sources };
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
  await expect(page.getByRole('banner').getByText(repository, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review linked changes' }).click();
  await expect(page.getByText('Values that change after following links (2)')).toBeVisible();
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();

  await page.getByRole('button', { name: 'Expand reference', exact: true }).click();
  await page.getByRole('navigation', { name: 'Token groups' }).getByRole('button', { name: 'space', exact: true }).click();
  await page.getByRole('button', { name: 'Rename group', exact: true }).click();
  await page.getByLabel('Group name', { exact: true }).fill('reference-space');
  await page.getByRole('button', { name: 'Review rename' }).click();
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await page.getByRole('button', { name: 'Group actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move group', exact: true }).click();
  await page.getByRole('navigation', { name: 'Destination group' }).getByRole('button', { name: 'system', exact: true }).click();
  await page.getByRole('button', { name: 'Review move' }).click();
  const diff = page.getByRole('region', { name: 'File changes' });
  await expect(diff).toContainText('{system.reference-space.small}');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await page.getByRole('button', { name: 'Review for pull request' }).click();
  await expect(diff).toContainText('{system.reference-space.small}');
  expect(requests).toEqual(['/git/open']);
  await page.getByRole('button', { name: 'Open pull request', exact: true }).click();
  const refresh = page.getByRole('button', { name: 'Review latest revision', exact: true });
  await expect(refresh).toBeVisible();
  const changedFile = sources.find(({ path }) => path === 'reference.tokens.json');
  if (!changedFile) throw new Error('Missing reference fixture.');
  snapshot = { repository, revision: latestRevision, files: [
    { path: changedFile.path, text: changedFile.text.replace('"value": 8', '"value": 10') },
    ...sources.filter(({ path }) => path !== changedFile.path),
  ] };
  await refresh.click();
  await expect(page.getByText(/reference\.tokens\.json changed in the repository/u)).toBeVisible();
  await expect(diff).toContainText('{system.reference-space.small}');
  expect(requests).toEqual(['/git/open', '/git/propose', '/git/open']);

  snapshot = { repository, revision: 'c'.repeat(40), files: [
    ...sources,
    { path: 'consumer.tokens.json', text: '{"consumer":{"gap":{"$type":"dimension","$value":"{system.space.control-gap}"}}}' },
  ] };
  await refresh.click();
  await expect(page.getByText('This diff and its resolved values use the latest revision.')).toBeVisible();
  await expect(diff).toContainText('{system.reference-space.small}');
  const impact = page.getByText(/Values that change after following links/u);
  await impact.click();
  await expect(page.getByRole('dialog').getByText('consumer.gap', { exact: true })).toBeVisible();
  expect(requests).toEqual(['/git/open', '/git/propose', '/git/open', '/git/open']);
  await page.getByRole('button', { name: 'Open pull request', exact: true }).click();
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
  await expect(page.getByRole('banner').getByText('fixture', { exact: true })).toBeVisible();
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
  const nameColumn = page.getByRole('columnheader', { name: 'Name', exact: true });
  const typeColumn = page.getByRole('columnheader', { name: 'Type', exact: true });
  const descriptionColumn = page.getByRole('columnheader', { name: 'Description', exact: true });
  const table = page.getByRole('table', { name: 'Tokens', exact: true });
  const paneWidth = (await page.getByRole('main').boundingBox())?.width ?? 0;
  const tableWidth = async () => (await table.boundingBox())?.width ?? 0;
  const descriptionWidth = async () => (await descriptionColumn.boundingBox())?.width ?? 0;
  const initialDescriptionWidth = await descriptionWidth();
  expect(await tableWidth()).toBeCloseTo(paneWidth, 0);
  const width = async () => (await nameColumn.boundingBox())?.width ?? 0;
  const initialWidth = await width();
  const initialTypeWidth = (await typeColumn.boundingBox())?.width;
  const resize = page.getByRole('button', { name: 'Resize Name column', exact: true });
  const handle = await resize.boundingBox();
  const nameHeader = await nameColumn.boundingBox();
  if (!handle || !nameHeader) throw new Error('The name header or resize handle is missing.');
  const nameCell = await table.getByRole('row').nth(1).getByRole('cell').nth(1).boundingBox();
  if (!nameCell) throw new Error('The name cell is missing.');
  expect(nameHeader.x).toBeCloseTo(nameCell.x, 0);
  expect(Math.abs(handle.x + handle.width / 2 - (nameCell.x + nameCell.width))).toBeLessThan(1);
  expect(await nameColumn.evaluate((header) => getComputedStyle(header).borderInlineEndWidth)).toBe('1px');
  expect(await table.getByRole('columnheader').first().evaluate((header) => getComputedStyle(header).borderInlineEndWidth)).toBe('1px');
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 48, y, { steps: 4 });
  await page.mouse.up();
  expect(await width()).toBeGreaterThan(initialWidth + 47);
  expect((await typeColumn.boundingBox())?.width).toBe(initialTypeWidth);
  expect(await tableWidth()).toBeCloseTo(paneWidth, 0);
  await resize.dblclick();
  expect(await width()).toBe(initialWidth);
  await resize.press('ArrowRight');
  expect(await width()).toBeGreaterThan(initialWidth + 15);
  await resize.press('Enter');
  expect(await width()).toBe(initialWidth);
  const resizeDescription = page.getByRole('button', { name: 'Resize Description column', exact: true });
  await resizeDescription.press('ArrowLeft');
  expect(Math.abs(await descriptionWidth() - (initialDescriptionWidth - 16))).toBeLessThan(1);
  expect(await tableWidth()).toBeCloseTo(paneWidth, 0);
  await resizeDescription.press('Enter');
  expect(await descriptionWidth()).toBeCloseTo(initialDescriptionWidth, 0);
  await page.setViewportSize({ width: 1075, height: 880 });
  const layout = () => Promise.all([
    toolbar.getByRole('button', { name: 'New token' }).boundingBox(),
    toolbar.getByTitle('Move tokens').boundingBox(),
    search.boundingBox(),
    page.getByRole('columnheader', { name: 'Name', exact: true }).boundingBox(),
  ]);
  const initial = await layout();
  await page.getByRole('checkbox', { name: 'Select all visible tokens', exact: true }).check();
  await expect(toolbar.getByRole('button', { name: 'Move selected' })).toBeEnabled();
  expect(await layout()).toEqual(initial);
  const tree = page.getByRole('navigation', { name: 'Token groups' });
  await page.getByRole('button', { name: 'Hide groups sidebar', exact: true }).click();
  await expect(tree).toBeHidden();
  await page.getByRole('button', { name: 'Show groups sidebar', exact: true }).click();
  await expect(tree).toBeVisible();
  expect(await layout()).toEqual(initial);
  await tree.getByRole('button', { name: benchmark ? 'goog' : 'base', exact: true }).click();
  expect(await layout()).toEqual(initial);
  await tree.getByRole('button', { name: 'All tokens', exact: true }).click();
  const unresolved = page.getByRole('button', { name: 'Unresolved (' + unresolvedCount + ')', exact: true });
  await unresolved.click();
  await expect(unresolved).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(benchmark ? '38 tokens' : '1 token', { exact: true })).toBeVisible();
  const token = page.getByRole('row').filter({ hasText: tokenPath });
  await token.getByText('Unresolved', { exact: true }).click();
  await page.getByRole('button', { name: 'References', exact: true }).click();
  await expect(page.getByText('Reference points to a group. Use {' + rootPath + '} to reference its root token.')).toBeVisible();
  await page.keyboard.press('Escape');
  const value = page.getByRole('button', { name: 'Value for ' + tokenPath, exact: true });
  await value.click();
  await expect(page.getByRole('dialog', { name: 'Edit value' })).toHaveCount(0);
  const rowHeight = (await token.boundingBox())?.height;
  await value.press('Space');
  const picker = page.getByRole('dialog', { name: 'Edit value' });
  const referenceSearch = picker.getByRole('searchbox', { name: 'Search references' });
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
  await picker.getByRole('button', { name: 'Apply', exact: true }).click();
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
  await page.getByRole('menuitem', { name: 'Integrations', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Open GitHub repository…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
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
  await expect(page.getByRole('cell').filter({ has: name })).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await name.press('Tab');
  const valueCell = page.getByRole('button', { name: 'Value for reference.compact', exact: true });
  await expect(valueCell).toBeFocused();
  await expect(linkActions).toHaveCount(1);
  await valueCell.press('Space');
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
  const suggestions = page.getByRole('searchbox', { name: 'Search references' });
  await expect(suggestions).toHaveValue('compact');
  await expect(suggestions).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(linkValue).toHaveText('8 px');

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
  const spare = page.getByRole('button', { name: 'Name for reference.spare', exact: true });
  const extra = page.getByRole('button', { name: 'Value for reference.extra', exact: true });
  const extraSelected = page.getByRole('checkbox', { name: 'Select reference.extra', exact: true });
  const toolbar = page.getByRole('region', { name: 'Token commands' });
  const selectedRows = page.locator('[data-token-row][data-state="selected"]');
  const compact = page.getByRole('button', { name: 'Name for reference.compact', exact: true });
  await spare.click();
  await compact.click({ modifiers: ['Shift'] });
  await expect(selectedRows).toHaveCount(3);
  await expect(toolbar.getByText('3 selected')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(selectedRows).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Clear selection' })).toHaveCount(0);
  await spare.click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(selectedRows).toHaveCount(3);
  await page.keyboard.press('Shift+ArrowUp');
  await expect(selectedRows).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(selectedRows).toHaveCount(0);
  await spare.click();
  await extra.click({ modifiers: ['Control'] });
  await expect(page.getByRole('checkbox', { name: 'Select reference.spare', exact: true })).toBeChecked();
  await expect(extraSelected).toBeChecked();
  await extra.click({ modifiers: ['Control'] });
  await expect(extraSelected).not.toBeChecked();
  await extra.click({ modifiers: ['Control'] });
  await expect(toolbar.getByText('2 selected')).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Delete selected', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Move selected', exact: true }).click();
  await page.getByRole('navigation', { name: 'Destination group' }).getByRole('button', { name: 'archive', exact: true }).click();
  await page.getByRole('button', { name: 'Review move' }).click();
  await expect(page.getByRole('region', { name: 'File changes' })).toContainText('system.tokens.json');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await page.getByRole('navigation', { name: 'Token groups' }).getByRole('button', { name: 'archive', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Name for archive.spare', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Group actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete group', exact: true }).click();
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Token groups' }).getByRole('button', { name: 'archive', exact: true })).toHaveCount(0);
  const rowCount = await page.getByRole('table', { name: 'Tokens' }).getByRole('row').count();
  await toolbar.getByRole('button', { name: 'New group', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New group' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Tokens', includeHidden: true }).getByRole('row', { includeHidden: true })).toHaveCount(rowCount);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});
