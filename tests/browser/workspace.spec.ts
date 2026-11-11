import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { isProposal } from '../../integrations/github/contract.ts';
import type { PullRequestProposal } from '../../integrations/github/contract.ts';

const sources = await Promise.all(['reference.tokens.json', 'system.tokens.json'].map(async (path) => ({
  path, text: await readFile(new URL('../../examples/' + path, import.meta.url), 'utf8'),
})));
const referenceChange = { schemaVersion: 1, changes: [
  { path: 'reference.space.small', before: { value: 8, unit: 'px' }, after: { value: 12, unit: 'px' } },
] };

async function openProposal(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open proposal', exact: true }).click();
  await (await chooser).setFiles({
    name: 'proposal.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(referenceChange)),
  });
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
}

test('reviews a linked proposal and cross-file move before submitting the pinned GitHub diff', async ({ page }) => {
  const revision = 'a'.repeat(40);
  const repository = 'example/tokens';
  const url = 'https://github.com/' + repository + '/pull/7';
  const requests: string[] = [];
  let proposal: PullRequestProposal | undefined;
  await page.route('**/git/*', async (route) => {
    const action = new URL(route.request().url()).pathname;
    requests.push(action);
    if (action === '/git/open') {
      await route.fulfill({ json: { repository, revision, files: sources } });
    } else if (action === '/git/propose') {
      const body: unknown = route.request().postDataJSON();
      if (!isProposal(body)) throw new Error('Malformed proposal.');
      proposal = body;
      await route.fulfill({ json: { url } });
    } else throw new Error('Unexpected Git request: ' + action);
  });

  await page.goto('/#proposal=' + encodeURIComponent(JSON.stringify(referenceChange)));
  await expect(page.getByRole('button', { name: 'Review linked proposal' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  await page.getByLabel('Repository', { exact: true }).fill(repository);
  await page.getByRole('button', { name: 'Open repository' }).click();
  await expect(page.getByRole('heading', { name: repository + ' · 2 files' })).toBeVisible();
  await page.getByRole('button', { name: 'Review linked proposal' }).click();
  await expect(page.getByText('2 resolved values changed')).toBeVisible();
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();

  await page.getByRole('button', { name: 'Expand reference', exact: true }).click();
  await page.getByRole('navigation', { name: 'Token groups' }).getByRole('button', { name: 'space', exact: true }).click();
  await page.getByRole('button', { name: 'Move or rename' }).click();
  await page.getByLabel('Destination file').selectOption('system.tokens.json');
  await page.getByLabel('New path').fill('system.reference-space');
  await page.getByRole('button', { name: 'Review move' }).click();
  const diff = page.getByRole('region', { name: 'Proposed file diff' });
  await expect(diff).toContainText('{system.reference-space.small}');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await page.getByRole('button', { name: 'Review for pull request' }).click();
  await expect(diff).toContainText('{system.reference-space.small}');
  expect(requests).toEqual(['/git/open']);
  await page.getByRole('button', { name: 'Open pull request', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View pull request' })).toHaveAttribute('href', url);
  expect(requests).toEqual(['/git/open', '/git/propose']);
  expect(proposal).toMatchObject({ revision, repository, changes: sources.map(({ path, text }) => ({ path, before: text })) });
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
  await page.getByRole('button', { name: 'Open folder' }).click();
  await expect(page.getByRole('heading', { name: 'fixture · 2 files' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Open folder' }).click();
  await (await chooser).setFiles(directory);
  await expect(page.getByRole('button', { name: 'Review and save' })).toHaveCount(0);
  await openProposal(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download patch' }).click();
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
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open files' }).click();
  await (await chooser).setFiles(benchmark || fallback);
  await expect(page.getByText(benchmark ? '6,818 tokens' : '2 tokens', { exact: true })).toBeVisible();
  const unresolved = page.getByRole('button', { name: 'Unresolved (' + unresolvedCount + ')', exact: true });
  await unresolved.click();
  await expect(unresolved).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(benchmark ? '38 tokens' : '1 token', { exact: true })).toBeVisible();
  const token = page.getByRole('row').filter({ hasText: tokenPath });
  await token.click();
  await page.getByRole('button', { name: 'References', exact: true }).click();
  await expect(page.getByText('Reference points to a group. Use {' + rootPath + '} to reference its root token.')).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Choose token reference').selectOption(rootPath);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Proposed file diff' })).toContainText('{' + rootPath + '}');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(unresolved).toHaveCount(0);
  if (benchmark) await expect(page.getByRole('button', { name: 'Unresolved (37)', exact: true })).toHaveAttribute('aria-pressed', 'true');
  else await expect(page.getByText('2 tokens', { exact: true })).toBeVisible();
});
