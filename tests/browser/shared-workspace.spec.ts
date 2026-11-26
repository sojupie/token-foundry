import { expect } from '@playwright/test';
import { test } from './runtime-test.ts';
import type { APIRequestContext, BrowserContext, Page, Route } from '@playwright/test';
import { isBundle } from '../../integrations/figma/contract.ts';
import { changedValues, importedValue } from '../../integrations/figma/merge.ts';
import { isRecord } from '../../lib/json.ts';
import { editSource, recoveryCopies } from './recovery-helpers.ts';
import { chooseOption } from './select-field.ts';
import { isWorkspaceView } from '../../integrations/workspace/model.ts';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve as resolvePath, sep } from 'node:path';

const githubReady = (page: Page) => page.evaluate(() => { const channel = new BroadcastChannel('token-foundry-github'); const broadcast = channel.postMessage.bind(channel); broadcast('ready'); channel.close(); });
const aliasSources = (a: boolean, b: number | string) => [{ path: 'tokens/base.tokens.json', text: JSON.stringify({
  ...(a ? { a: { $type: 'number', $value: 8 } } : {}), b: { $type: 'number', $value: b }, c: { $type: 'number', $value: 16 },
}) }];

test('concurrent reference interactions retain the local draft, explain the invalid merge and save after repair', async ({ page, request }) => {
  const files = aliasSources(true, 12);
  const view: unknown = await (await request.post('/git/workspaces', { headers: { Origin: 'http://127.0.0.1:4319' }, data: {
    client: crypto.randomUUID(), snapshot: { name: 'Concurrent aliases', files, baseline: files },
  } })).json();
  if (!isWorkspaceView(view)) throw new Error('Workspace fixture unavailable.');
  await page.goto('/?workspace=' + view.id);
  await expect(page.locator('[data-workspace-name]')).toHaveText(view.name);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: 'Value for b', exact: true }).click();
  await page.getByRole('button', { name: 'Change value', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Change value · 1 token', exact: true });
  await form.getByRole('button', { name: 'Raw JSON', exact: true }).click();
  await form.getByRole('textbox', { name: 'Replacement value JSON', exact: true }).fill('"{a}"');
  const remote = await request.put('/git/workspaces/' + view.id, { headers: { Origin: 'http://127.0.0.1:4319' }, data: {
    before: view.draft.revision, snapshot: { name: view.name, files: aliasSources(false, 12), baseline: files },
  } }); expect(remote.ok()).toBe(true);
  await form.getByRole('button', { name: 'Review edits', exact: true }).click();
  await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.locator('.workspace-save-state')).toHaveText('Draft needs attention');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Combined changes need attention' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review and export patch', exact: true })).toBeDisabled();
  const retained: unknown = await (await request.get('/git/workspaces/' + view.id)).json();
  expect(isWorkspaceView(retained) && retained.draft.files).toEqual(aliasSources(false, 12));
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for a', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Value for b', exact: true }).click(); await page.getByRole('button', { name: 'Change value', exact: true }).click();
  await form.getByRole('button', { name: 'Raw JSON', exact: true }).click();
  await form.getByRole('textbox', { name: 'Replacement value JSON', exact: true }).fill('"{c}"');
  await form.getByRole('button', { name: 'Review edits', exact: true }).click(); await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.locator('.workspace-save-state')).toHaveText('Saved to workspace');
  const saved: unknown = await (await request.get('/git/workspaces/' + view.id)).json();
  expect(isWorkspaceView(saved) && saved.draft.files).toEqual(aliasSources(false, '{c}'));
  await expect(page.getByRole('button', { name: 'Value for a', exact: true })).toBeHidden();
});

async function start(page: Page) {
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Start shared workspace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workspace storage' })).toContainText('Saved to workspace');
  await expect.poll(async () => (await recoveryCopies(page))[0]?.shared?.id).toBeTruthy();
  const id = (await recoveryCopies(page))[0]?.shared?.id;
  if (!id) throw new Error('Shared identity was not retained.');
  return id;
}

async function browserConflict(page: Page, context: BrowserContext, request: APIRequestContext) {
  await page.goto('/'); const id = await start(page);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: 'Value for reference.space.small', exact: true }).click();
  await page.getByRole('button', { name: 'Change value', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Change value · 1 token', exact: true });
  await edit.getByRole('button', { name: 'Raw JSON', exact: true }).click();
  await edit.getByRole('textbox', { name: 'Replacement value JSON', exact: true }).fill('{"value":12,"unit":"px"}');
  const other = await context.newPage(); await other.goto('/?workspace=' + id); await editSource(other, 8, 10);
  await expect.poll(async () => { const view: unknown = await (await request.get('/git/workspaces/' + id)).json(); return isWorkspaceView(view) && view.draft.files.some(file => file.text.includes('"value": 10')); }).toBe(true);
  await other.close(); await page.bringToFront();
  await edit.getByRole('button', { name: 'Review edits', exact: true }).click(); await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.locator('.workspace-save-state')).toHaveText('Conflicts need review');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve conflicting definitions', exact: true }).click();
  return { id, dialog: page.getByRole('dialog', { name: 'Resolve workspace changes', exact: true }) };
}
async function remoteSpace(request: APIRequestContext, id: string, before: number, after: number) {
  const view: unknown = await (await request.get('/git/workspaces/' + id)).json(); if (!isWorkspaceView(view)) throw new Error('Missing remote fixture.');
  const files = view.draft.files.map(file => ({ ...file, text: file.path.endsWith('reference.tokens.json') ? file.text.replace('"value": ' + before, '"value": ' + after) : file.text }));
  const result = await request.put('/git/workspaces/' + id, { headers: { Origin: 'http://127.0.0.1:4319' }, data: { before: view.draft.revision, snapshot: { name: view.name, files, baseline: view.baseline.files } } });
  expect(result.ok()).toBe(true);
}

test('browser conflict input survives reload and a changed source without retyping', async ({ page, context, request }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  const { id, dialog } = await browserConflict(page, context, request);
  await chooseOption(dialog.getByRole('combobox'), 'custom'); await dialog.getByLabel('Value (px)', { exact: true }).fill('unfinished browser input');
  const recoveryId = await page.evaluate(() => sessionStorage.getItem('foundry-active-recovery'));
  await expect.poll(async () => (await recoveryCopies(page)).find(copy => copy.id === recoveryId)?.editor?.workspaceReview?.choices[0]?.text).toBe('unfinished browser input');
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await expect(dialog.getByLabel('Value (px)', { exact: true })).toHaveValue('unfinished browser input');
  await remoteSpace(request, id, 10, 11);
  await expect(dialog).toContainText('Source values changed.');
  await expect(dialog.getByLabel('Value (px)', { exact: true })).toHaveValue('unfinished browser input');
  await dialog.getByLabel('Value (px)', { exact: true }).fill('14');
  await dialog.getByRole('button', { name: 'Review merged changes', exact: true }).click(); await expect(dialog).toBeHidden();
  await expect.poll(async () => { const view: unknown = await (await request.get('/git/workspaces/' + id)).json(); return isWorkspaceView(view) && view.draft.files.some(file => file.text.includes('"value": 14')); }).toBe(true);
});

test('a source change after clicking Apply retains the conflict and input instead of writing a stale choice', async ({ page, context, request }) => {
  const { id, dialog } = await browserConflict(page, context, request);
  await chooseOption(dialog.getByRole('combobox'), 'custom'); await dialog.getByLabel('Value (px)', { exact: true }).fill('14');
  let release: (() => void) | undefined; let started: (() => void) | undefined; let gate = true;
  const waiting = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/git/workspaces/' + id + '?summary=1', async route => { if (gate) { gate = false; started?.(); await waiting; } return route.continue(); });
  await dialog.getByRole('button', { name: 'Review merged changes', exact: true }).click(); await entered;
  await expect(dialog.getByLabel('Value (px)', { exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  await remoteSpace(request, id, 10, 11); release?.();
  await expect(dialog).toContainText('Source values changed.');
  await expect(dialog.getByLabel('Value (px)', { exact: true })).toHaveValue('14');
  const before: unknown = await (await request.get('/git/workspaces/' + id)).json(); expect(isWorkspaceView(before) && before.draft.files.some(file => file.text.includes('"value": 11'))).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Review merged changes', exact: true })).toBeDisabled();
  await chooseOption(dialog.getByRole('combobox'), 'custom');
  await dialog.getByRole('button', { name: 'Review merged changes', exact: true }).click(); await expect(dialog).toBeHidden();
  await expect.poll(async () => { const view: unknown = await (await request.get('/git/workspaces/' + id)).json(); return isWorkspaceView(view) && view.draft.files.some(file => file.text.includes('"value": 14')); }).toBe(true);
});

for (const keep of ['custom', 'draft', 'repository'] as const) test('a refreshed browser conflict retains ' + keep + ' input without treating it as a choice of the new source values', async ({ page, context, request }) => {
  const { id, dialog } = await browserConflict(page, context, request);
  await chooseOption(dialog.getByRole('combobox'), keep);
  if (keep === 'custom') await dialog.getByLabel('Value (px)', { exact: true }).fill('14');
  await remoteSpace(request, id, 10, 11);
  await expect(dialog).toContainText('Source values changed.');
  await expect(dialog.getByRole('button', { name: 'Review merged changes', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('combobox')).toHaveValue('Choose a definition');
  if (keep === 'custom') await expect(dialog.getByLabel('Value (px)', { exact: true })).toHaveValue('14');
  const before: unknown = await (await request.get('/git/workspaces/' + id)).json();
  expect(isWorkspaceView(before) && before.draft.files.some(file => file.text.includes('"value": 11'))).toBe(true);
  await chooseOption(dialog.getByRole('combobox'), keep);
  await dialog.getByRole('button', { name: 'Review merged changes', exact: true }).click(); await expect(dialog).toBeHidden();
  const after: unknown = await (await request.get('/git/workspaces/' + id)).json();
  expect(isWorkspaceView(after) && after.draft.files.some(file => file.text.includes('"value": ' + (keep === 'custom' ? 14 : keep === 'draft' ? 12 : 11)))).toBe(true);
});

test('converged browser conflicts keep custom input and resume it as an ordinary token edit', async ({ page, context, request }) => {
  const { id, dialog } = await browserConflict(page, context, request);
  await chooseOption(dialog.getByRole('combobox'), 'custom'); await dialog.getByLabel('Value (px)', { exact: true }).fill('14');
  await remoteSpace(request, id, 10, 12);
  const earlier = dialog.getByRole('region', { name: 'Earlier conflict input', exact: true }); await expect(earlier).toContainText('14');
  await expect(dialog.getByRole('button', { name: 'Review merged changes', exact: true })).toBeDisabled();
  await earlier.getByRole('button', { name: 'Resume token edit', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Token value', exact: true })).toHaveValue('14');
  await page.getByRole('dialog', { name: 'Edit value', exact: true }).getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect.poll(async () => { const view: unknown = await (await request.get('/git/workspaces/' + id)).json(); return isWorkspaceView(view) && view.draft.files.some(file => file.text.includes('"value": 14')); }).toBe(true);
});

for (const finish of ['cancel', 'apply'] as const) test('an open bulk form retains its baseline while another browser edits, then ' + finish + ' handles the update explicitly', async ({ page, context, request }) => {
  await page.goto('/'); const id = await start(page);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: 'Value for reference.space.small', exact: true }).click();
  await page.getByRole('button', { name: 'Change value', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Change value · 1 token', exact: true });
  await form.getByRole('button', { name: 'Raw JSON', exact: true }).click();
  await form.getByRole('textbox', { name: 'Replacement value JSON', exact: true }).fill('{"value":12,"unit":"px"}');
  const other = await context.newPage(); await other.goto('/?workspace=' + id); await editSource(other, 8, 10);
  await expect.poll(async () => { const remote: unknown = await (await request.get('/git/workspaces/' + id)).json(); return isWorkspaceView(remote) && remote.draft.files.some(file => file.text.includes('"value": 10')); }).toBe(true);
  await other.close(); await page.bringToFront();
  await expect(page.locator('.workspace-save-state')).toHaveText('Updates available');
  await expect(form.getByRole('region', { name: 'Current values', exact: true })).toContainText('8');
  await expect(form.getByRole('textbox', { name: 'Replacement value JSON', exact: true })).toHaveValue('{"value":12,"unit":"px"}');
  if (finish === 'cancel') {
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Value for reference.space.small', exact: true })).toHaveText('10 px', { timeout: 10000 });
  } else {
    await form.getByRole('button', { name: 'Review edits', exact: true }).click();
    await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
    await expect(page.locator('.workspace-save-state')).toHaveText('Conflicts need review');
    await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
    await page.getByRole('button', { name: 'Resolve conflicting definitions', exact: true }).click();
    const conflict = page.getByRole('dialog', { name: 'Resolve workspace changes', exact: true });
    await expect(conflict).toContainText('Before'); await expect(conflict).toContainText('Your draft');
    await chooseOption(conflict.getByRole('combobox'), 'draft');
    await conflict.getByRole('button', { name: 'Review merged changes', exact: true }).click();
    await expect(conflict).toBeHidden();
    await expect.poll(async () => { const remote: unknown = await (await request.get('/git/workspaces/' + id)).json(); return isWorkspaceView(remote) && remote.draft.files.some(file => file.text.includes('"value": 12')); }).toBe(true);
  }
});

test('first-time Figma pairing finds a repository workspace without opening its repository first', async ({ page, request }) => {
  const files = [{ path: 'tokens/base.tokens.json', text: '{"space":{"$type":"number","$value":8},"alias":{"$type":"number","$value":"{space}"}}' }];
  const created: unknown = await (await request.post('/git/workspaces', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { client: crypto.randomUUID(), snapshot: { name: 'Repository design draft', files, baseline: files, repository: { repository: 'org/tokens', root: 'tokens', revision: 'a'.repeat(40) } } } })).json();
  if (!isWorkspaceView(created)) throw new Error('Missing repository fixture.');
  // Permission/ownership is covered by the SQLite test; this view receives
  // the authorized shared listing before any repository connection is open.
  await page.route('**/git/workspaces?refresh=*', route => route.fulfill({ json: { repositoryDiscovery: 'ready', workspaces: [{ id: created.id, name: created.name, repository: 'org/tokens' }] } }));
  let opened = 0; page.on('request', outgoing => { if (new URL(outgoing.url()).pathname === '/git/open') opened++; });
  const pair = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''); const secret = 'b'.repeat(64);
  const document = 'first-time-' + crypto.randomUUID();
  await page.goto('/#pair=' + pair + '&secret=' + secret + '&document=' + document + '&name=Repository%20library');
  await page.evaluate(() => {
    const report = console.error.bind(console);
    console.error = (...values: unknown[]) => {
      if (typeof values[0] === 'string' && values[0].includes('Cannot update a component')) {
        const stack = new Error('Pairing warning').stack ?? '';
        void window.foundryRuntimeError?.(values.map(String).join(' ') + '\n' + stack);
        report(...values, stack); return;
      }
      report(...values);
    };
  });
  const listing = page.getByRole('region', { name: 'Saved workspaces' });
  await listing.getByRole('searchbox', { name: 'Find workspace', exact: true }).fill('org/tokens');
  await listing.getByRole('button', { name: 'Repository design draft' }).click();
  await expect(page.locator('[data-workspace-name]')).toHaveText('Repository design draft');
  await page.getByRole('button', { name: 'Connect to this workspace', exact: true }).click();
  await expect(page.getByText('Connected. Return to Figma to continue.', { exact: true })).toBeVisible();
  await expect(page.getByRole('main', { name: 'Figma', exact: true })).toHaveAttribute('aria-busy', 'false');
  const result: unknown = await (await request.get('/figma/pairing/' + pair, { headers: { Authorization: 'Bearer ' + secret } })).json();
  expect(isRecord(result) && typeof result['connection'] === 'string').toBe(true); expect(opened).toBe(0);
  const before: unknown = await (await request.get('/git/workspaces/' + created.id)).json();
  const repeated = await request.post('/git/workspaces/' + created.id + '/pair', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { pair, secret, document, name: 'Repository library', role: 'library' } });
  expect(repeated.ok()).toBe(true); expect(await (await request.get('/git/workspaces/' + created.id)).json()).toEqual(before);
});

test('a hidden pairing page ignores its late reply and resumes one durable approval after page restore', async ({ page, request }) => {
  const files = [{ path: 'tokens/lifetime.json', text: '{"space":{"$type":"number","$value":8}}' }];
  const created: unknown = await (await request.post('/git/workspaces', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { client: crypto.randomUUID(), snapshot: { name: 'Pairing lifetime', files, baseline: files } } })).json();
  if (!isWorkspaceView(created)) throw new Error('Missing workspace fixture.');
  const pair = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  let delayed: Route | undefined; let result: unknown; let calls = 0;
  await page.route('**/git/workspaces/' + created.id + '/pair', async route => {
    calls++;
    if (calls !== 1) { await route.continue(); return; }
    result = await (await route.fetch()).json(); delayed = route;
  });
  await page.goto('/?workspace=' + created.id + '#pair=' + pair + '&secret=' + 'b'.repeat(64) + '&document=lifetime-file&name=Lifetime%20library');
  const main = page.getByRole('main', { name: 'Figma', exact: true });
  await main.getByRole('button', { name: 'Connect to this workspace', exact: true }).click();
  await expect.poll(() => !!delayed).toBe(true);
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); });
  if (!delayed) throw new Error('Missing delayed pairing response.'); await delayed.fulfill({ json: result });
  await expect(page.getByText('Connected. Return to Figma to continue.', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await expect(main).toHaveAttribute('aria-busy', 'false');
  await main.getByRole('button', { name: 'Connect to this workspace', exact: true }).click();
  await expect(page.getByText('Connected. Return to Figma to continue.', { exact: true })).toBeVisible();
  await expect(main).toHaveAttribute('aria-busy', 'false');
  const final: unknown = await (await request.get('/git/workspaces/' + created.id)).json();
  expect(isWorkspaceView(final) && final.documents[0]?.connections?.length).toBe(1);
});

test('the workspace chooser keeps personal drafts and refreshes shared discovery after GitHub sign-in', async ({ page }) => {
  let checks = 0; let connected = false;
  await page.route('**/git/workspaces?refresh=*', route => {
    checks++;
    return route.fulfill({ json: { repositoryDiscovery: connected ? 'ready' : 'sign-in', workspaces: connected ? [{ id: 'c'.repeat(64), name: 'Personal draft' }, { id: 'd'.repeat(64), name: 'Shared repository draft', repository: 'org/tokens' }] : [{ id: 'c'.repeat(64), name: 'Personal draft' }] } });
  });
  await page.goto('/#pair=' + 'a'.repeat(64) + '&secret=' + 'b'.repeat(64) + '&document=first-time-' + crypto.randomUUID() + '&name=Library');
  const listing = page.getByRole('region', { name: 'Saved workspaces' });
  await expect(listing.getByRole('button', { name: 'Personal draft' })).toBeVisible();
  await expect(listing.getByRole('link', { name: 'Connect GitHub', exact: true })).toHaveAttribute('href', '/git/sign-in');
  const before = checks; connected = true;
  await githubReady(page);
  await expect(listing.getByRole('button', { name: 'Shared repository draft' })).toBeVisible();
  await expect(listing.getByRole('link', { name: 'Connect GitHub', exact: true })).toHaveCount(0); expect(checks).toBe(before + 1);
});

test('workspace loading stays distinct from empty state and an access change cannot leave pagination on an empty page', async ({ page }) => {
  let release: (() => void) | undefined; const waiting = new Promise<void>(resolve => { release = resolve; }); let signedOut = false;
  const personal = { id: 'c'.repeat(64), name: 'Personal draft' };
  const entries = [personal, ...Array.from({ length: 7 }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), name: 'Shared draft ' + index, repository: 'org/tokens' }))];
  await page.route('**/git/workspaces?refresh=*', async route => { await waiting; return route.fulfill({ json: { repositoryDiscovery: signedOut ? 'sign-in' : 'ready', workspaces: signedOut ? [personal] : entries } }); });
  await page.goto('/#pair=' + 'a'.repeat(64) + '&secret=' + 'b'.repeat(64) + '&document=loading-' + crypto.randomUUID() + '&name=Library');
  const listing = page.getByRole('region', { name: 'Saved workspaces' });
  await expect(listing).toHaveAttribute('aria-busy', 'true'); await expect(listing.getByRole('progressbar', { name: 'Loading workspaces', exact: true })).toBeVisible();
  await expect(listing.getByRole('searchbox', { name: 'Find workspace', exact: true })).toHaveCount(0);
  await expect(listing.getByText('Saved shared workspaces appear here.', { exact: true })).toHaveCount(0);
  release?.(); await expect(listing).toHaveAttribute('aria-busy', 'false');
  await expect(listing.getByRole('searchbox', { name: 'Find workspace', exact: true })).toBeVisible();
  await listing.getByRole('button', { name: 'Next workspaces', exact: true }).click();
  await expect(listing.getByRole('button', { name: 'Shared draft 6' })).toBeVisible();
  signedOut = true; await githubReady(page);
  await expect(listing.getByRole('button', { name: 'Personal draft' })).toBeVisible();
  await expect(listing.getByRole('button', { name: 'Next workspaces', exact: true })).toHaveCount(0);
  await expect(listing.getByRole('link', { name: 'Connect GitHub', exact: true })).toBeVisible();
});

test('phone navigation fits five destinations, keeps keyboard access and resizes back to the rail', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 850 }); await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Foundry', exact: true });
  const checkWidth = async (width: number) => {
    await page.setViewportSize({ width, height: 850 });
    await expect(navigation).toHaveClass(/md-navigation-bar/u);
    expect(await navigation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const items = navigation.getByRole('button'); await expect(items).toHaveCount(5);
    const bounds = await navigation.boundingBox(); if (!bounds) throw new Error('Missing phone navigation.');
    const boxes = await items.evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
    expect(boxes.every(box => box.left >= bounds.x && box.right <= bounds.x + bounds.width + 1)).toBe(true);
  };
  await checkWidth(400); await checkWidth(320);
  await navigation.getByRole('button', { name: 'Tokens', exact: true }).focus(); await page.keyboard.press('End');
  await expect(navigation.getByRole('button', { name: 'Figma', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('main', { name: 'Figma', exact: true })).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: 'View', exact: true }).click();
  const toggle = page.getByRole('menuitem', { name: /Switch to .* mode/u }); await expect(toggle).toBeVisible();
  const before = await page.locator('html').getAttribute('data-theme'); await toggle.click(); await expect(page.locator('html')).not.toHaveAttribute('data-theme', before ?? '');
  await page.setViewportSize({ width: 1200, height: 850 }); await expect(navigation).toHaveClass(/md-navigation-rail/u);
  await expect(navigation.getByRole('button', { name: 'Figma', exact: true })).toHaveAttribute('tabindex', '0');
});

test('switching a saved shared draft retains it without a discard warning and unfinished forms still block unload', async ({ page, request }) => {
  await page.goto('/'); const first = await start(page); await editSource(page, 8, 12);
  await expect.poll(async () => { const value: unknown = await (await request.get('/git/workspaces/' + first)).json(); return isWorkspaceView(value) && value.draft.files.some(file => file.text.includes('"value": 12')); }).toBe(true);
  await expect(page.locator('.workspace-save-state')).toHaveText('Saved to workspace');
  const stored: unknown = await (await request.get('/git/workspaces/' + first)).json(); if (!isWorkspaceView(stored)) throw new Error('Missing shared draft.');
  const targetName = 'Navigation ' + crypto.randomUUID();
  const created = await request.post('/git/workspaces', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { client: crypto.randomUUID(), snapshot: { name: targetName, files: stored.baseline.files, baseline: stored.baseline.files } } });
  expect(created.ok()).toBe(true);
  const prompts: string[] = []; page.on('dialog', async dialog => { prompts.push(dialog.message()); await dialog.dismiss(); });
  await expect.poll(() => page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(false);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Open workspace', exact: true });
  await picker.getByRole('searchbox', { name: 'Find workspace', exact: true }).fill(targetName);
  await picker.getByRole('button', { name: targetName }).click();
  await expect(page.locator('[data-workspace-name]')).toHaveText(targetName); expect(prompts).toEqual([]);
  const retained: unknown = await (await request.get('/git/workspaces/' + first)).json(); if (!isWorkspaceView(retained)) throw new Error('Previous draft was lost.'); expect(retained.draft).toEqual(stored.draft);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: 'Value for reference.space.small', exact: true }).dblclick();
  await expect.poll(() => page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
});

test('two devices in one file keep their receipts and revoking one from Figma management retains the other', async ({ page, request }) => {
  await page.goto('/'); const id = await start(page); const document = 'shared-file-' + crypto.randomUUID();
  const connect = async () => {
    const result: unknown = await (await request.post('/git/workspaces/' + id + '/documents', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { document, name: 'Shared library', role: 'library' } })).json();
    if (!isRecord(result) || typeof result['connection'] !== 'string') throw new Error('Missing device connection.');
    const url = new URL(result['connection']); const headers = { Authorization: 'Bearer ' + url.hash.slice(1) }; url.hash = '';
    return { url: url.href, headers };
  };
  const one = await connect(); const two = await connect();
  const base: unknown = await (await request.get(one.url, { headers: one.headers })).json(); if (!isBundle(base)) throw new Error('Pairing a second device revoked the first.');
  const valuesOne = new Map(base.variables.map(row => [row.path, importedValue(row)])); valuesOne.set('reference.space.small', 12);
  const first: unknown = await (await request.post(one.url, { headers: one.headers, data: changedValues(base, valuesOne) })).json(); if (!isBundle(first) || !isRecord(first) || !isRecord(first['acknowledgement'])) throw new Error('The first device was not acknowledged.');
  const valuesTwo = new Map(base.variables.map(row => [row.path, importedValue(row)])); valuesTwo.set('reference.space.medium', 20);
  const second: unknown = await (await request.post(two.url, { headers: two.headers, data: changedValues(base, valuesTwo) })).json(); if (!isBundle(second) || !isRecord(second) || !isRecord(second['acknowledgement'])) throw new Error('The second device was not acknowledged.');
  expect(first['acknowledgement']['id']).not.toBe(second['acknowledgement']['id']);
  expect((await request.post(one.url, { headers: one.headers, data: { action: 'acknowledge', revision: first.revision } })).ok()).toBe(true);
  expect((await request.post(two.url, { headers: two.headers, data: { action: 'acknowledge', revision: second.revision } })).ok()).toBe(true);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Figma', exact: true }).click();
  const files = page.getByRole('region', { name: 'Linked Figma files' });
  await expect(files).toContainText('1 of 2 device connections up to date');
  await files.getByText('Manage connections (2)', { exact: true }).click();
  await files.getByRole('button', { name: 'Revoke connection', exact: true }).first().click();
  await expect(files.getByText('Manage connections (1)', { exact: true })).toBeVisible();
  expect((await request.get(one.url, { headers: one.headers })).status()).toBe(410);
  const retained: unknown = await (await request.get(two.url, { headers: two.headers })).json(); if (!isBundle(retained)) throw new Error('Revoking one device disconnected the other.');
  expect(retained.variables.find(row => row.path === 'reference.space.small')?.value).toBe(12);
  expect(retained.variables.find(row => row.path === 'reference.space.medium')?.value).toBe(20);
  expect(retained.variables.find(row => row.path === 'system.space.control-gap')?.alias).toBe('reference.space.small');
});

test('two conflicting devices in one file keep separate unfinished choices through reload', async ({ page, request }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/'); const id = await start(page); const document = 'concurrent-' + crypto.randomUUID();
  const connect = async () => {
    const result: unknown = await (await request.post('/git/workspaces/' + id + '/documents', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { document, name: 'Concurrent library', role: 'library' } })).json();
    if (!isRecord(result) || typeof result['connection'] !== 'string') throw new Error('Missing connection.');
    const url = new URL(result['connection']); const headers = { Authorization: 'Bearer ' + url.hash.slice(1) }; url.hash = '';
    return { url: url.href, headers };
  };
  const connections = [await connect(), await connect()];
  const first = connections[0]; if (!first) throw new Error('Missing first connection.');
  const base: unknown = await (await request.get(first.url, { headers: first.headers })).json(); if (!isBundle(base)) throw new Error('Missing source.');
  await editSource(page, 8, 10);
  await expect.poll(async () => { const value: unknown = await (await request.get('/git/workspaces/' + id)).json(); return isWorkspaceView(value) && value.draft.files.some(file => file.text.includes('"value": 10')); }).toBe(true);
  await Promise.all(connections.map(async (connection, index) => {
    const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('reference.space.small', 12 + index * 2);
    const result: unknown = await (await request.post(connection.url, { headers: connection.headers, data: changedValues(base, local) })).json();
    expect(isRecord(result) && result['accepted']).toBe(false);
  }));
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
  let queue = page.getByRole('region', { name: 'Figma changes needing review' });
  let entries = queue.getByRole('button', { name: /^Concurrent library · 1 token change/u }); await expect(entries).toHaveCount(2);
  const editChoice = async (index: number) => {
    await entries.nth(index).click(); const form = queue.getByRole('region', { name: 'Conflicting changes' }); await expect(form).toHaveCount(1);
    await chooseOption(form.getByRole('combobox', { name: 'Keep value for reference.space.small', exact: true }), 'custom');
    await form.getByLabel('Value (px)', { exact: true }).fill('unfinished-' + index);
    await expect.poll(async () => {
      const value: unknown = await (await request.get('/git/workspaces/' + id)).json();
      return isWorkspaceView(value) && value.incoming[index]?.review?.drafts[0]?.text;
    }).toBe('unfinished-' + index);
  };
  await editChoice(0); await editChoice(1);
  await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.figmaReviews?.entries.length).toBe(2);
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover local work', exact: true }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
  queue = page.getByRole('region', { name: 'Figma changes needing review' }); entries = queue.getByRole('button', { name: /^Concurrent library · 1 token change/u });
  const checkChoice = async (index: number) => {
    await entries.nth(index).click(); await expect(queue.getByRole('region', { name: 'Conflicting changes' }).getByLabel('Value (px)', { exact: true })).toHaveValue('unfinished-' + index);
  };
  await checkChoice(0); await checkChoice(1);
});

test('workspace names distinguish saved drafts and survive a source edit without creating another draft', async ({ page, request }) => {
  await page.goto('/'); const id = await start(page);
  await page.getByRole('button', { name: 'Rename workspace', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Name workspace', exact: true });
  await form.getByLabel('Workspace name', { exact: true }).fill('Spacing exploration');
  await form.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(form).toBeHidden(); await expect(page.locator('[data-workspace-name]')).toHaveText('Spacing exploration');
  await editSource(page, 8, 12);
  await expect.poll(async () => (await recoveryCopies(page))[0]?.files.some(file => file.text.includes('"value": 12'))).toBe(true);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Open workspace', exact: true }).getByRole('region', { name: 'Saved workspaces' })).toContainText('Spacing exploration');
  const server: unknown = await (await request.get('/git/workspaces/' + id)).json();
  expect(isRecord(server) && server['name']).toBe('Spacing exploration');
});
test('browser pairing, native edits, acknowledgement and recovery use the durable workspace without Share', async ({ page, request }) => {
  const pair = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''); const secret = 'b'.repeat(64);
  await page.goto('/#pair=' + pair + '&secret=' + secret + '&document=workflow-' + crypto.randomUUID() + '&name=Workflow%20library');
  await expect(page.getByRole('button', { name: 'Connect to this workspace', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Connect to this workspace', exact: true }).click();
  await expect(page.getByText('Connected. Return to Figma to continue.', { exact: true })).toBeVisible();
  const polled: unknown = await (await request.get('/figma/pairing/' + pair, { headers: { Authorization: 'Bearer ' + secret } })).json();
  if (!isRecord(polled) || typeof polled['connection'] !== 'string') throw new Error('Pairing did not deliver a device connection.');
  const target = new URL(polled['connection']); const capability = target.hash.slice(1); target.hash = '';
  const headers = { Authorization: 'Bearer ' + capability };
  const source: unknown = await (await request.get(target.href, { headers })).json();
  if (!isBundle(source)) throw new Error('The connected source is invalid.');
  const local = new Map(source.variables.map(row => [row.path, importedValue(row)])); local.set('reference.space.small', 12);
  const posted: unknown = await (await request.post(target.href, { headers, data: changedValues(source, local) })).json();
  expect(isRecord(posted) && posted['accepted']).toBe(true);
  await expect.poll(async () => (await recoveryCopies(page))[0]?.files.some(file => file.text.includes('"value": 12'))).toBe(true);
  expect(JSON.stringify(await recoveryCopies(page))).not.toContain(capability);
  const accepted: unknown = await (await request.get(target.href, { headers })).json(); if (!isBundle(accepted)) throw new Error('Missing accepted bundle.');
  expect(accepted.variables.find(row => row.path === 'system.space.control-gap')?.alias).toBe('reference.space.small');
  expect((await request.post(target.href, { headers, data: { action: 'acknowledge', revision: accepted.revision } })).ok()).toBe(true);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Changes' })).toContainText('reference.tokens.json');
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Recover local work', exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Figma', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Linked Figma files' })).toContainText('Workflow library');
  await expect(page.getByRole('region', { name: 'Linked Figma files' })).toContainText('Up to date');
});

test('a true Figma conflict retains unfinished choices through reload and a later source edit before resolving in Changes', async ({ page, request }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/'); const id = await start(page);
  const paired: unknown = await (await request.post('/git/workspaces/' + id + '/documents', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { document: 'conflict-library', name: 'Conflict library', role: 'library' } })).json();
  if (!isRecord(paired) || typeof paired['connection'] !== 'string') throw new Error('Missing connection.');
  const target = new URL(paired['connection']); const headers = { Authorization: 'Bearer ' + target.hash.slice(1) }; target.hash = '';
  const base: unknown = await (await request.get(target.href, { headers })).json(); if (!isBundle(base)) throw new Error('Missing source.');
  await editSource(page, 8, 10);
  await expect.poll(async () => { const value: unknown = await (await request.get('/git/workspaces/' + id)).json(); return isRecord(value) && isRecord(value['draft']) && JSON.stringify(value['draft']).includes('\\"value\\": 10'); }).toBe(true);
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('reference.space.small', 12);
  const result: unknown = await (await request.post(target.href, { headers, data: changedValues(base, local) })).json();
  expect(isRecord(result) && result['accepted']).toBe(false);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('button', { name: 'Conflict library · 1 token change' }).click();
  let conflict = page.getByRole('region', { name: 'Conflicting changes' });
  await chooseOption(conflict.getByRole('combobox', { name: 'Keep value for reference.space.small', exact: true }), 'custom');
  await conflict.getByLabel('Value (px)', { exact: true }).fill('unfinished');
  await expect.poll(async () => JSON.stringify(await (await request.get('/git/workspaces/' + id + '/review?document=conflict-library')).json())).toContain('unfinished');
  await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.figmaReviews?.entries[0]?.drafts[0]?.text).toBe('unfinished');
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover local work', exact: true }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('button', { name: 'Conflict library · 1 token change' }).click();
  conflict = page.getByRole('region', { name: 'Conflicting changes' });
  await expect(conflict.getByLabel('Value (px)', { exact: true })).toHaveValue('unfinished');
  const other = await page.context().newPage();
  await other.goto('/?workspace=' + id); await editSource(other, 10, 11);
  await expect.poll(async () => { const value: unknown = await (await request.get(target.href, { headers })).json(); return isBundle(value) && value.variables.find(row => row.path === 'reference.space.small')?.value; }).toBe(11);
  await other.close(); await page.bringToFront();
  await expect(conflict).toContainText('11 px'); await expect(conflict).toContainText('Source values changed');
  await expect(conflict.getByLabel('Value (px)', { exact: true })).toHaveValue('unfinished');
  await conflict.getByLabel('Value (px)', { exact: true }).fill('14'); await conflict.getByRole('button', { name: 'Apply choices', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Figma changes needing review' })).toHaveCount(0);
  const final: unknown = await (await request.get(target.href, { headers })).json(); if (!isBundle(final)) throw new Error('Missing reconciled source.');
  expect(final.variables.find(row => row.path === 'reference.space.small')?.value).toBe(14);
});

for (const failure of ['none', 'storage', 'source', 'finished-elsewhere', 'interrupted-transfer']) test('private incoming Figma input survives a rejected save and resumes after convergence with ' + failure, async ({ page, request }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  const productionDirectory = process.env['FOUNDRY_REVIEW_ASSETS'];
  const production = failure === 'none' && !!productionDirectory;
  if (production) {
    const directory = resolvePath(productionDirectory === '1' ? '.wrangler/staging-assets' : productionDirectory);
    await page.setViewportSize({ width: 520, height: 900 });
    await page.route(url => url.origin === 'http://127.0.0.1:4319' && (['/', '/variants', '/workspace', '/changes', '/figma'].includes(url.pathname) || url.pathname.startsWith('/assets/')), async route => {
      const pathname = new URL(route.request().url()).pathname;
      const resolvedPath = pathname.startsWith('/assets/') ? pathname : '/index.html';
      const file = resolvePath(directory, '.' + resolvedPath);
      if (!file.startsWith(directory + sep)) throw new Error('Invalid production artifact path.');
      const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)] ?? 'application/octet-stream';
      await route.fulfill({ body: await readFile(file), contentType });
    });
  }
  await page.goto('/'); const id = await start(page); const document = 'private-library';
  const recordId = (await recoveryCopies(page)).find(copy => copy.shared?.id === id)?.id;
  if (!recordId) throw new Error('Missing private recovery identity.');
  const paired: unknown = await (await request.post('/git/workspaces/' + id + '/documents', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { document, name: 'Private input library', role: 'library' } })).json();
  if (!isRecord(paired) || typeof paired['connection'] !== 'string') throw new Error('Missing connection.');
  const url = new URL(paired['connection']); const headers = { Authorization: 'Bearer ' + url.hash.slice(1) }; url.hash = '';
  const base: unknown = await (await request.get(url.href, { headers })).json(); if (!isBundle(base)) throw new Error('Missing source.');
  await editSource(page, 8, 10);
  await expect(page.locator('.workspace-save-state')).toHaveText('Saved to workspace');
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('reference.space.small', 12); const proposal = changedValues(base, local);
  const queued: unknown = await (await request.post(url.href, { headers, data: proposal })).json(); expect(isRecord(queued) && queued['accepted']).toBe(false);
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('button', { name: 'Private input library · 1 token change' }).click();
  let rejectField = true; let cleared = 0; let staged = '';
  await page.route('**/git/workspaces/' + id + '/review', async route => {
    const body: unknown = route.request().postDataJSON();
    if (isRecord(body) && Array.isArray(body['drafts']) && !body['drafts'].length) {
      cleared++; staged = (await recoveryCopies(page)).find(copy => copy.id === recordId)?.editor?.stagedFigmaDraft?.value ?? ''; return route.continue();
    }
    if (rejectField) return route.fulfill({ status: 409, json: { message: 'The workspace changed before the field was saved.' } });
    return route.continue();
  });
  const conflict = page.getByRole('region', { name: 'Conflicting changes' });
  await chooseOption(conflict.getByRole('combobox'), 'custom'); await conflict.getByLabel('Value (px)', { exact: true }).fill('14');
  await expect(conflict.locator('..').getByRole('alert')).toContainText('before the field was saved');
  await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.figmaReviews?.entries[0]?.drafts[0]?.text).toBe('14');
  await page.reload(); await page.getByRole('dialog', { name: 'Recover local work', exact: true }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await expect(conflict.getByLabel('Value (px)', { exact: true })).toHaveValue('14'); rejectField = false;
  const other = await page.context().newPage(); await other.goto('/?workspace=' + id); await editSource(other, 10, 12);
  await expect(other.locator('.workspace-save-state')).toHaveText('Saved to workspace'); await other.close(); await page.bringToFront();
  await expect(conflict.getByRole('region', { name: 'Earlier conflict input' }).getByLabel('Earlier input for reference.space.small', { exact: true })).toHaveValue('14');
  if (production) {
    await conflict.getByRole('button', { name: 'Cancel review', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.locator('script[type=module]')).toHaveAttribute('src', /\/assets\/index-[\w-]+\.js/u);
    expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const reviewButton = await page.locator('.workspace-review .md-button').boundingBox(); if (!reviewButton) throw new Error('Missing header review action.'); expect(reviewButton.x + reviewButton.width).toBeLessThanOrEqual(520);
    await expect(page.locator('.md-snackbar:popover-open'), 'An existing recovery copy does not repeat its initial save notice.').toHaveCount(0);
    const scroller = await page.getByRole('main', { name: 'Changes', exact: true }).boundingBox(); const cancel = await conflict.getByRole('button', { name: 'Cancel review', exact: true }).boundingBox();
    if (!scroller || !cancel) throw new Error('Missing scroll viewport or review action.');
    // Integer scroll offsets can leave a fractional CSS-pixel border edge.
    expect(cancel.y + cancel.height).toBeLessThanOrEqual(scroller.y + scroller.height + 1);
    await mkdir('.wrangler/verification', { recursive: true }); await page.screenshot({ path: '.wrangler/verification/incoming-review-520-' + test.info().project.name + '.png' });
  }
  if (failure === 'finished-elsewhere') {
    const view: unknown = await (await request.get('/git/workspaces/' + id)).json(); if (!isWorkspaceView(view)) throw new Error('Missing view.');
    expect((await request.post('/git/workspaces/' + id + '/resolve', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { document, proposal, revision: view.draft.revision, choices: [] } })).ok()).toBe(true);
    await expect(page.getByRole('region', { name: 'Unfinished Figma input' }).getByLabel('Earlier input for reference.space.small', { exact: true })).toHaveValue('14');
  } else if (failure === 'storage') await page.evaluate(() => {
    IDBObjectStore.prototype.put = () => { throw new Error('Injected resumed-form storage failure'); };
  });
  else if (failure === 'source') await page.route('**/git/workspaces/' + id + '/resolve', route => route.fulfill({ status: 409, json: { message: 'The source changed during resume.' } }));
  let held: Route | undefined;
  if (failure === 'interrupted-transfer') await page.route('**/git/workspaces/' + id + '/resolve', route => { held = route; });
  await page.getByRole('button', { name: 'Resume token edit', exact: true }).click();
  if (failure === 'interrupted-transfer') {
    await expect.poll(() => !!held).toBe(true);
    const prepared = (await recoveryCopies(page)).find(copy => copy.id === recordId)?.editor;
    expect(prepared?.stagedFigmaDraft?.value).toBe('14 px'); expect(prepared?.draft).toBeUndefined();
    const online: unknown = await (await request.get('/git/workspaces/' + id + '/review?document=' + document)).json(); expect(isRecord(online) && online['drafts']).toEqual([]);
    await page.reload(); await held?.abort(); await page.unroute('**/git/workspaces/' + id + '/resolve');
    await page.getByRole('dialog', { name: 'Recover local work', exact: true }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Edit value', exact: true })).toHaveCount(0);
    await expect(conflict.getByLabel('Earlier input for reference.space.small', { exact: true })).toHaveValue('14');
    await conflict.getByRole('button', { name: 'Resume token edit', exact: true }).click();
  }
  if (failure === 'storage' || failure === 'source') {
    await expect(page.getByRole('alert').filter({ hasText: failure === 'storage' ? 'recovery copy could not be saved' : 'source changed during resume' })).toBeVisible();
    await expect(conflict.getByLabel('Earlier input for reference.space.small', { exact: true })).toHaveValue('14');
    expect(cleared).toBe(failure === 'storage' ? 0 : 1);
  } else {
    const editor = page.getByRole('dialog', { name: 'Edit value', exact: true }); await expect(editor).toBeVisible();
    await expect.poll(() => editor.evaluate(node => node.contains(window.document.activeElement))).toBe(true);
    await page.keyboard.press('Tab'); await expect.poll(() => editor.evaluate(node => node.contains(window.document.activeElement))).toBe(true);
    if (production) { expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: '.wrangler/verification/incoming-editor-520-' + test.info().project.name + '.png' }); }
    expect(failure === 'finished-elsewhere' ? cleared : staged).toBe(failure === 'finished-elsewhere' ? 0 : '14 px');
    await editor.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
    await expect(page.locator('.workspace-save-state')).toHaveText('Saved to workspace');
    const final: unknown = await (await request.get(url.href, { headers })).json(); expect(isBundle(final) && final.variables.find(row => row.path === 'reference.space.small')?.value).toBe(14);
    await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.figmaReviews?.entries.length ?? 0).toBe(0);
  }
});

const resumedColor = (red: number) => ({ colorSpace: 'srgb', components: [red, 0.2, 0.3], alpha: 0.5 });
for (const kind of ['alias', 'color', 'unit']) for (const choice of ['input', 'source']) test('resumed incoming ' + kind + ' input after ' + choice + ' choice preserves references, alpha and authored metadata', async ({ page, request }) => {
  const files = (value: number, unit = 'px') => [{ path: 'tokens/resume.tokens.json', text: JSON.stringify({
    small: { $type: kind === 'color' ? 'color' : kind === 'unit' ? 'dimension' : 'number', $value: kind === 'color' ? resumedColor(value / 100) : kind === 'unit' ? { value, unit } : value, $extensions: { authored: { preserve: true } } },
    other: { $type: 'number', $value: 16 }, alias: { $type: kind === 'color' ? 'color' : kind === 'unit' ? 'dimension' : 'number', $value: '{small}' },
  }) }];
  const created: unknown = await (await request.post('/git/workspaces', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { client: crypto.randomUUID(), snapshot: { name: 'Resume fidelity', files: files(8), baseline: files(8) } } })).json();
  if (!isWorkspaceView(created)) throw new Error('Missing workspace.'); const id = created.id; const document = 'fidelity-library';
  const paired: unknown = await (await request.post('/git/workspaces/' + id + '/documents', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { document, name: 'Fidelity library', role: 'library' } })).json();
  if (!isRecord(paired) || typeof paired['connection'] !== 'string') throw new Error('Missing connection.');
  const url = new URL(paired['connection']); const headers = { Authorization: 'Bearer ' + url.hash.slice(1) }; url.hash = '';
  const base: unknown = await (await request.get(url.href, { headers })).json(); if (!isBundle(base)) throw new Error('Missing source.');
  const save = async (value: number, unit = 'px') => {
    const view: unknown = await (await request.get('/git/workspaces/' + id)).json(); if (!isWorkspaceView(view)) throw new Error('Missing view.');
    const response = await request.put('/git/workspaces/' + id, { headers: { Origin: 'http://127.0.0.1:4319' }, data: { before: view.draft.revision, snapshot: { name: view.name, files: files(value, unit), baseline: files(8) } } }); expect(response.ok()).toBe(true);
  };
  await save(10);
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('small', kind === 'color' ? { r: 0.12, g: 0.2, b: 0.3, a: 0.5 } : 12);
  const queued: unknown = await (await request.post(url.href, { headers, data: changedValues(base, local) })).json(); expect(isRecord(queued) && queued['accepted']).toBe(false);
  await page.goto('/?workspace=' + id); await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('button', { name: /^Fidelity library · 1 token change/u }).click();
  const conflict = page.getByRole('region', { name: 'Conflicting changes' }); await chooseOption(conflict.getByRole('combobox'), kind === 'alias' ? 'alias' : 'custom');
  const input = kind === 'alias' ? 'other' : kind === 'color' ? '#70809040' : '14';
  await conflict.getByLabel(kind === 'alias' ? 'Target token path' : kind === 'color' ? 'Color (#RRGGBBAA)' : 'Value (px)', { exact: true }).fill(input);
  await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.figmaReviews?.entries[0]?.drafts[0]?.text).toBe(input);
  if (choice === 'source') await chooseOption(conflict.getByRole('combobox'), 'source');
  await save(12, kind === 'unit' ? 'dp' : 'px'); await expect(conflict.getByLabel('Earlier input for small', { exact: true })).toHaveValue(input);
  await conflict.getByRole('button', { name: 'Resume token edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit value', exact: true }); await expect(editor).toBeVisible(); await editor.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.locator('.workspace-save-state')).toHaveText('Saved to workspace');
  const final: unknown = await (await request.get(url.href, { headers })).json(); if (!isBundle(final)) throw new Error('Missing accepted source.');
  const row = final.variables.find(item => item.path === 'small');
  if (kind === 'alias') expect(row?.alias).toBe('other');
  else if (kind === 'color') expect(row?.before).toEqual({ colorSpace: 'srgb', components: [112 / 255, 128 / 255, 144 / 255], alpha: 64 / 255 });
  else expect(row?.before).toEqual({ value: 14, unit: 'px' });
  expect(final.variables.find(item => item.path === 'alias')?.alias).toBe('small'); expect(final.files[0]?.text).toContain('"authored":{"preserve":true}');
});

test('recovery snackbar leaves the application layout fixed and does not repeat for each autosave', async ({ page }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/');
  const top = await page.locator('.workspace-top').boundingBox();
  await editSource(page, 8, 12);
  const bar = page.locator('.md-snackbar');
  await expect(bar).toBeVisible();
  expect((await page.locator('.workspace-top').boundingBox())?.height).toBe(top?.height);
  await expect(bar).toBeHidden({ timeout: 10_000 });
  await editSource(page, 12, 14);
  await expect.poll(async () => (await recoveryCopies(page))[0]?.files.some(file => file.text.includes('"value": 14'))).toBe(true);
  await expect(bar).toBeHidden();
  await page.reload(); await page.getByRole('dialog', { name: 'Recover local work', exact: true }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await editSource(page, 14, 16);
  await expect.poll(async () => (await recoveryCopies(page))[0]?.files.some(file => file.text.includes('"value": 16'))).toBe(true);
  await expect(page.locator('.workspace-save-state')).toHaveText('Saved locally'); await expect(bar).toBeHidden();
});

test('unchanged responses do not create a render and network feedback loop', async ({ page }) => {
  await page.goto('/'); await start(page);
  let summaries = 0; let writes = 0;
  page.on('request', request => { if (request.url().includes('/git/workspaces/')) { if (request.method() === 'PUT') writes++; if (request.url().includes('summary=1')) summaries++; } });
  await expect.poll(() => summaries, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  expect(summaries).toBeLessThanOrEqual(3); expect(writes).toBe(0);
  await editSource(page, 8, 12);
  await expect.poll(() => writes).toBe(1);
  const settled = summaries;
  await expect.poll(() => summaries, { timeout: 10_000 }).toBeGreaterThanOrEqual(settled + 2);
  expect(summaries).toBeLessThanOrEqual(settled + 3); expect(writes).toBe(1);
});

test('saved workspace links resume the draft and source search stays bounded for many files', async ({ page, request }) => {
  const files = Array.from({ length: 21 }, (_, index) => ({ path: 'tokens/source-' + String(index).padStart(2, '0') + '.tokens.json', text: JSON.stringify({ ['token' + index]: { $type: 'number', $value: index } }) }));
  const response: unknown = await (await request.post('/git/workspaces', { headers: { Origin: 'http://127.0.0.1:4319' }, data: { client: crypto.randomUUID(), snapshot: { name: 'Many sources', files, baseline: files } } })).json();
  if (!isRecord(response) || typeof response['id'] !== 'string') throw new Error('The workspace was not created.');
  await page.goto('/?workspace=' + response['id']);
  await expect(page.locator('[data-workspace-name]')).toHaveText('Many sources');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  const sources = page.getByRole('region', { name: 'Source files' });
  await expect(sources.locator('[data-source-file]')).toHaveCount(8);
  await sources.getByRole('button', { name: 'Next files', exact: true }).click();
  await expect(sources.locator('[data-source-file]').first()).toContainText('source-08');
  await sources.getByLabel('Find source file', { exact: true }).fill('source-20');
  await expect(sources.locator('[data-source-file]')).toHaveCount(1);
  await expect(sources.locator('[data-source-file]')).toContainText('source-20');
});

test('manual connection issues a single-use pairing code without requiring document identity', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Figma', exact: true }).click();
  await page.getByRole('button', { name: 'Create shared workspace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Connect Figma file' })).toBeVisible();
  await page.getByText('Manual connection', { exact: true }).click();
  await page.getByRole('button', { name: 'Create pairing code', exact: true }).click();
  const codeField = page.getByLabel('One-time pairing code', { exact: true });
  await expect(codeField).not.toHaveValue('');
  const code = await codeField.inputValue();
  const parsed = new URL(code);
  const secret = parsed.hash.slice(1);
  parsed.hash = '';
  const redeemed = await request.post(parsed.href, {
    headers: { Origin: 'null', Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    data: { document: 'manual-doc-' + crypto.randomUUID(), name: 'Manual Figma file' },
  });
  expect(redeemed.status()).toBe(200);
  const body: unknown = await redeemed.json();
  expect(isRecord(body) && typeof body['connection'] === 'string').toBe(true);
  await expect(page.getByRole('region', { name: 'Linked Figma files' })).toContainText('Manual Figma file', { timeout: 10_000 });
  const replay = await request.post(parsed.href, {
    headers: { Origin: 'null', Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    data: { document: 'manual-doc-2', name: 'Other file' },
  });
  expect(replay.status()).toBe(410);
});
