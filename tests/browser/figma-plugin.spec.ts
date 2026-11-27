import { expect } from '@playwright/test';
import { test } from './runtime-test.ts';
import type { Page } from '@playwright/test';
import type { Route } from '@playwright/test';
import { build } from 'esbuild';
import { figmaBundle } from '../../integrations/figma/projection.ts';
import { changedValues, importedValue, pullConflicts } from '../../integrations/figma/merge.ts';
import { openWorkspace } from '../../lib/workspace.ts';
import { isRecord, isUnknownArray, requireValue } from '../../lib/json.ts';
import { isConflictDraft } from '../../integrations/figma/recovery.ts';
import type { ConflictDraft } from '../../integrations/figma/recovery.ts';
import { chooseOption } from './select-field.ts';
import { isTokenForms } from '../../figma/forms.ts';
import { readFile } from 'node:fs/promises';
import { identifySubmission } from '../../integrations/figma/submission.ts';
import { cubicFromPoints } from '../../integrations/figma/easing.ts';

declare global { interface Window { foundryPluginMessages: unknown[] } }
const ui = await build({ entryPoints: ['figma/ui.tsx'], bundle: true, format: 'iife', target: 'es2022', write: false,
  outdir: 'dist/test-plugin-ui', loader: { '.woff2': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' } });
const html = '<!doctype html><html lang="en"><meta charset="utf-8"><style>' + requireValue(ui.outputFiles.find(file => file.path.endsWith('.css'))?.text, 'UI styles') +
  '</style><div id="root"></div><script>' + requireValue(ui.outputFiles.find(file => file.path.endsWith('.js'))?.text, 'UI script').replaceAll('</script', '<\\/script') + '</script></html>';
const bundle = (value: number) => figmaBundle(openWorkspace('Sevan', [{ path: 'tokens/test.tokens.json', text: JSON.stringify({
  sevan: { sys: { space: { $type: 'dimension', $value: { value, unit: 'px' } } } },
}) }]));
const post = (page: Page, messages: unknown[]) => page.evaluate(values => {
  values.forEach(value => {
    // Emulate the SDK response envelope; explicit serials remain available for stale-reply tests.
    let pluginMessage = value;
    if (value && typeof value === 'object' && 'type' in value) {
      const responses: Record<string, string[]> = { proposal: ['proposal'], pulled: ['pull', 'resume-pull', 'resolve-pull'], conflicts: ['pull', 'resume-pull', 'resolve-pull'], edited: ['edit'], 'pull-cancelled': ['cancel-pull'], 'library-built': ['build-library'], state: ['inspect', 'pull', 'resume-pull', 'resolve-pull', 'edit', 'resolve-native-unit'] };
      const types = responses[String(value.type)] ?? ('request' in value && typeof value.request === 'string' ? [value.request] : value.type === 'error' ? ['pull', 'resume-pull', 'resolve-pull', 'edit', 'cancel-pull', 'build-library', 'resolve-native-unit'] : []);
      const request = window.foundryPluginMessages.map(item => item && typeof item === 'object' && 'pluginMessage' in item ? item.pluginMessage : undefined).findLast(item => item && typeof item === 'object' && 'type' in item && types.includes(String(item.type)) && 'client' in item && !(item.type === 'proposal' && 'proposal' in item));
      if (request && typeof request === 'object') pluginMessage = { ...value,
        ...(!('serial' in value) && 'serial' in request ? { serial: request.serial } : {}),
        ...(!('client' in value) && 'client' in request ? { client: request.client } : {}),
        ...(!('request' in value) && 'type' in request ? { request: request.type } : {}) };
    }
    window.postMessage({ pluginMessage }, '*');
  });
}, messages);
async function sent(page: Page, type: string) {
  const values = await page.evaluate(() => window.foundryPluginMessages);
  return values.filter(isRecord).map(value => value['pluginMessage']).filter(isRecord).findLast(value => value['type'] === type);
}
async function sentPayload(page: Page, type: string) {
  const message = await sent(page, type); if (!message) return undefined;
  const { client, serial, request, ...payload } = message; void client; void serial; void request;
  return payload;
}
async function openUI(page: Page) {
  await page.addInitScript(() => {
    window.foundryPluginMessages = [];
    window.addEventListener('message', event => { window.foundryPluginMessages.push(event.data); });
  });
  await page.route('**/__figma-ui-test', route => route.fulfill({ body: html, contentType: 'text/html' }));
  await page.setViewportSize({ width: 520, height: 720 });
  await page.goto('/__figma-ui-test');
  await expect(page.getByRole('heading', { name: 'Foundry', exact: true })).toBeVisible();
  await post(page, [{ type: 'saved-token-forms', forms: [] }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Changes', exact: true }).click();
}
async function openConnect(page: Page, section?: 'Connect with a code' | 'Offline Figma snapshots and edits') {
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  if (section) {
    const label = page.getByText(section, { exact: true });
    if (!await label.evaluate(node => node.closest('details')?.open === true)) await label.click();
  }
}

test('plugin status icons separate native Figma from workspace acknowledgement, offline, and revoked connections', async ({ page }) => {
  await page.clock.install();
  await openUI(page);
  const source = await bundle(8);
  const id = 'a'.repeat(64);
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let mode: 'online' | 'offline' | 'revoked' = 'online';
  let acknowledgement: Route | undefined;
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const data: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (mode === 'offline') return route.fulfill({ status: 503, json: { message: 'Workspace temporarily unavailable.' } });
    if (mode === 'revoked') return route.fulfill({ status: 403, json: { message: 'Connection revoked.' } });
    if (isRecord(data) && data['action'] === 'acknowledge') { acknowledgement = route; return undefined; }
    if (new URL(route.request().url()).searchParams.has('since')) return route.fulfill({ json: {
      unchanged: true, workspace: { id, document: 'native-file', name: 'Checkpoint · source preservation QA', role: 'library' },
    } });
    return route.fulfill({ json: { ...source, workspace: { id, document: 'native-file', name: 'Checkpoint · source preservation QA', role: 'library' } } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }]);
  const native = page.locator('.plugin-appbar [data-service=figma]');
  const workspace = page.locator('.plugin-appbar [data-service=workspace]');
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [] }]);
  await expect(native).toHaveAttribute('data-status', 'good');
  await expect(workspace).toHaveAttribute('data-status', 'bad');
  await post(page, [{ type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  await expect.poll(() => sent(page, 'pull')).toBeTruthy();
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [] }, { type: 'pulled', revision: source.revision }]);
  await expect.poll(() => !!acknowledgement).toBe(true);
  await expect(workspace).toHaveAttribute('data-status', 'pending');
  await acknowledgement?.fulfill({ json: { saved: true } });
  await expect(workspace).toHaveAttribute('data-status', 'good');
  await expect(native).toHaveAttribute('data-status', 'good');
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Workspace', exact: true }).click();

  await page.setViewportSize({ width: 360, height: 760 });
  await page.evaluate(() => document.documentElement.classList.add('figma-dark'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('.plugin-appbar').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  mode = 'offline';
  await page.clock.runFor(3500);
  await expect(workspace).toHaveAttribute('data-status', 'bad');
  await expect(native).toHaveAttribute('data-status', 'good');
  mode = 'online';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(workspace).toHaveAttribute('data-status', 'good');
  mode = 'revoked';
  await page.clock.runFor(3500);
  await expect(workspace).toHaveAttribute('data-status', 'bad');
  await expect(native).toHaveAttribute('data-status', 'good');
});

test('easing fields retain unfinished coordinates through reopening, validate, and keep exact input after a native precision error', async ({ page }) => {
  await openUI(page); const source = await figmaBundle(openWorkspace('Easing', [{ path: 'easing.json', text: '{"curve":{"$type":"cubicBezier","$value":[0.2,0,0,1]}}' }]));
  const before = requireValue(source.variables[0]?.value, 'Curve');
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'curve', value: before }] }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /^curve/u }).click(); await expect(page.getByLabel('X1', { exact: true })).toHaveValue('0.2');
  await expect(page.getByRole('figure', { name: 'Cubic Bézier curve preview' })).toBeVisible();
  await page.getByLabel('X1', { exact: true }).fill('-');
  const saved = await sent(page, 'save-token-forms'); const forms = saved?.['forms']; expect(isTokenForms(forms)).toBe(true);
  await page.reload(); await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'curve', value: before }] }, { type: 'saved-token-forms', forms }]);
  await expect(page.getByLabel('X1', { exact: true })).toHaveValue('-');
  await expect(page.getByRole('figure', { name: 'Cubic Bézier curve preview' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('finite control points');
  expect(await sent(page, 'edit')).toBeUndefined();
  await page.getByRole('button', { name: 'Use source control points', exact: true }).click();
  await page.getByLabel('Y1', { exact: true }).fill('-1e308'); await page.getByLabel('Y2', { exact: true }).fill('1e308');
  const path = await page.locator('.easing-curve').getAttribute('d'); expect(path).not.toMatch(/NaN|Infinity/u);
  await expect(page.getByRole('button', { name: 'Play curve', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Use source control points', exact: true }).click();
  await page.getByLabel('X1', { exact: true }).fill('0.123456781234567');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(() => sentPayload(page, 'edit')).toEqual({ type: 'edit', path: 'curve', expected: before, revision: source.revision, value: cubicFromPoints([0.123456781234567, 0, 0, 1]) });
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'curve', value: before }] }, { type: 'error', request: 'edit', code: 'easing-precision', message: 'Control points do not round-trip. Your exact input is retained.' }]);
  await expect(page.getByLabel('X1', { exact: true })).toHaveValue('0.123456781234567');
  await page.getByRole('button', { name: 'Use source control points', exact: true }).click();
  await expect(page.getByLabel('X1', { exact: true })).toHaveValue('0.2'); await page.getByLabel('Y1', { exact: true }).fill('-0.25');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(() => sentPayload(page, 'edit')).toEqual({ type: 'edit', path: 'curve', expected: before, revision: source.revision, value: cubicFromPoints([0.2, -0.25, 0, 1]) });
});

test('a native easing preset remains visible and can be repaired with the source curve', async ({ page }) => {
  await openUI(page); const source = await figmaBundle(openWorkspace('Easing', [{ path: 'easing.json', text: '{"curve":{"$type":"cubicBezier","$value":[0.2,0,0,1]}}' }]));
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'curve', value: { type: 'QUICK' } }], issue: 'The native easing has no cubic Bézier mapping.' }]);
  await expect(page.locator('header')).toContainText('Needs attention');
  const changes = page.getByRole('region', { name: 'Workspace changes', exact: true });
  await expect(changes).toContainText('Sync paused: The native easing has no cubic Bézier mapping.');
  await expect(changes).not.toContainText('All local changes are saved');
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /^curve/u }).click();
  await expect(page.getByLabel('Retained curve input', { exact: true })).toHaveValue('{"type":"QUICK"}');
  await page.getByRole('button', { name: 'Use source control points', exact: true }).click();
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(() => sentPayload(page, 'edit')).toEqual({ type: 'edit', path: 'curve', expected: { type: 'QUICK' }, revision: source.revision, value: source.variables[0]?.value });
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'curve', value: source.variables[0]?.value }] }, { type: 'edited', path: 'curve' }]);
  await expect(page.locator('header')).not.toContainText('Needs attention');
});

test('easing conflict choices use the coordinate editor and preserve an invalid coordinate until corrected', async ({ page }) => {
  await openUI(page); const source = await figmaBundle(openWorkspace('Easing', [{ path: 'easing.json', text: '{"curve":{"$type":"cubicBezier","$value":[0.2,0,0,1]}}' }]));
  const incoming = await figmaBundle(openWorkspace('Easing', [{ path: 'easing.json', text: '{"curve":{"$type":"cubicBezier","$value":[0.4,0,0,1]}}' }]));
  const before = source.variables[0]?.value; const current = cubicFromPoints([0.3, 0, 0, 1]);
  await post(page, [{ type: 'state', bundle: source, changed: 1, local: [{ path: 'curve', value: current }] },
    { type: 'conflicts', id: 'easing-review', incoming, local: [{ path: 'curve', value: current }], conflicts: [{ path: 'curve', before, local: current, remote: incoming.variables[0]?.value }] }]);
  const review = page.getByRole('region', { name: 'Conflicting changes' });
  await chooseOption(review.getByRole('combobox'), 'custom');
  await review.getByRole('button', { name: 'Use source control points', exact: true }).click();
  await review.getByLabel('Y1', { exact: true }).fill('-');
  await review.getByRole('button', { name: 'Apply choices', exact: true }).click();
  await expect(review.getByRole('alert')).toContainText('finite control points'); expect(await sent(page, 'resolve-pull')).toBeUndefined();
  await review.getByLabel('Y1', { exact: true }).fill('-0.25');
  await review.getByRole('button', { name: 'Apply choices', exact: true }).click();
  await expect.poll(() => sent(page, 'resolve-pull')).toMatchObject({ id: 'easing-review', choices: [{ path: 'curve', value: cubicFromPoints([0.4, -0.25, 0, 1]) }] });
});

test('a background inspection cannot release controls while a native source mutation is still pending', async ({ page }) => {
  await openUI(page); await openConnect(page, 'Offline Figma snapshots and edits'); const base = await bundle(8); const next = await bundle(10);
  await post(page, [{ type: 'state', bundle: base, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  await page.getByLabel('Foundry snapshot', { exact: true }).setInputFiles({ name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(next)) });
  await expect.poll(async () => (await sent(page, 'pull'))?.['bundle']).toEqual(next);
  await post(page, [{ type: 'state', bundle: base, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  await expect(page.getByRole('button', { name: 'Open Figma snapshot…', exact: true })).toBeDisabled();
  const operation = await sent(page, 'pull');
  await post(page, [{ type: 'pulled', revision: next.revision, serial: operation?.['serial'], client: 'f'.repeat(64) }]);
  await expect(page.getByRole('button', { name: 'Open Figma snapshot…', exact: true })).toBeDisabled();
  await post(page, [{ type: 'pulled', revision: next.revision, serial: 0 }]);
  await expect(page.getByRole('button', { name: 'Open Figma snapshot…', exact: true })).toBeDisabled();
  await post(page, [{ type: 'state', bundle: next, changed: 0, local: [{ path: 'sevan.sys.space', value: 10 }] }, { type: 'pulled', revision: next.revision }]);
  await expect(page.getByRole('button', { name: 'Open Figma snapshot…', exact: true })).toBeEnabled();
});

test('UI kit completion remains in a snackbar through background refresh and can be dismissed', async ({ page }) => {
  await openUI(page); const source = await bundle(8);
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }, { type: 'library-available', name: 'Sevan', compatible: true }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByText('Library maintenance', { exact: true }).click();
  const buildButton = page.getByRole('button', { name: 'Sync foundations', exact: true });
  await buildButton.click(); await expect.poll(() => sent(page, 'build-library')).toBeTruthy();
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  await post(page, [{ type: 'library-built', components: 0, variants: 0, collections: 2, styles: 18 }, { type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  const snackbar = page.locator('.md-snackbar');
  await expect(snackbar).toContainText('Foundations synced: 2 mode collections, 18 styles.');
  await expect(snackbar).toBeVisible();
  const dismiss = snackbar.getByRole('button', { name: 'Dismiss notification', exact: true }); await dismiss.focus(); await dismiss.press('Enter');
  await expect(snackbar).toBeHidden();
});

test('an unfinished native token form resumes exact invalid input and requires review after a native edit', async ({ page }) => {
  await openUI(page); const source = await bundle(8);
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /sevan.sys.space/u }).click();
  await page.getByLabel('Value (px)', { exact: true }).fill('unfinished native value');
  const saved = await sent(page, 'save-token-forms'); const forms = saved?.['forms']; expect(isTokenForms(forms)).toBe(true); if (!isTokenForms(forms)) throw new Error('Missing saved form.');
  await post(page, [{ type: 'token-forms-saved', serial: saved?.['serial'] }]);
  await expect(page.getByText('Unfinished edits saved on this device.', { exact: true })).toBeVisible();
  await page.reload();
  await post(page, [{ type: 'state', bundle: source, changed: 1, local: [{ path: 'sevan.sys.space', value: 10 }] }, { type: 'saved-token-forms', forms }]);
  const input = page.getByLabel('Value (px)', { exact: true }); await expect(input).toHaveValue('unfinished native value');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed in Figma'); expect(await sent(page, 'edit')).toBeUndefined();
  await page.getByRole('button', { name: 'Review current value', exact: true }).click(); await expect(input).toHaveValue('unfinished native value');
  await input.fill('14'); await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(() => sent(page, 'edit')).toMatchObject({ expected: 10, value: 14, revision: source.revision });
});

for (const nativeValue of [12, 13]) test('a delayed native edit acknowledgement retains later form input with native value ' + nativeValue, async ({ page }) => {
  await openUI(page); const source = await bundle(8);
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /sevan.sys.space/u }).click();
  const input = page.getByLabel('Value (px)', { exact: true }); await input.fill('12');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click(); await input.fill('14');
  await post(page, [{ type: 'state', bundle: source, changed: 1, local: [{ path: 'sevan.sys.space', value: nativeValue }] }, { type: 'edited', path: 'sevan.sys.space' }]);
  await expect(input).toHaveValue('14');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  if (nativeValue === 12) await expect.poll(() => sent(page, 'edit')).toMatchObject({ expected: 12, value: 14 });
  else {
    await expect(page.getByRole('alert')).toContainText('changed in Figma');
    expect(await sent(page, 'edit')).toMatchObject({ expected: 8, value: 12 });
    await page.getByRole('button', { name: 'Review current value', exact: true }).click();
    await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
    await expect.poll(() => sent(page, 'edit')).toMatchObject({ expected: 13, value: 14 });
  }
});

test('a failed device form save exports exact input, reopens it elsewhere, and never overwrites a different unfinished edit', async ({ page, browser }) => {
  await openUI(page); const source = await bundle(8);
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /sevan.sys.space/u }).click();
  await page.getByLabel('Value (px)', { exact: true }).fill('unfinished storage value');
  await post(page, [{ type: 'token-forms-error', message: 'Storage full' }]);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download edits', exact: true }).click();
  const path = await (await download).path(); if (!path) throw new Error('Missing token edit download.');
  const text = await readFile(path, 'utf8'); expect(text).toContain('unfinished storage value');
  await page.getByRole('button', { name: 'Retry saving edits', exact: true }).click();
  await expect.poll(() => sent(page, 'save-token-forms')).toMatchObject({ serial: 2 });
  const retry = await sent(page, 'save-token-forms');
  await post(page, [{ type: 'token-forms-saved', serial: 1 }]);
  await expect(page.getByText('Saving unfinished edits on this device…', { exact: true })).toBeVisible();
  await post(page, [{ type: 'token-forms-saved', serial: retry?.['serial'] }]);
  await expect(page.getByText('Unfinished edits saved on this device.', { exact: true })).toBeVisible();
  const fresh = await browser.newPage(); await openUI(fresh);
  await post(fresh, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  const upload = fresh.getByLabel('Token edit copy', { exact: true });
  await upload.setInputFiles({ name: 'edits.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  const input = fresh.getByLabel('Value (px)', { exact: true }); await expect(input).toHaveValue('unfinished storage value');
  expect(await sent(fresh, 'edit')).toBeUndefined();
  await input.fill('different local input');
  await upload.setInputFiles({ name: 'edits.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(input).toHaveValue('different local input');
  await expect(fresh.getByText('Finish or cancel the current edit for sevan.sys.space before opening this copy.', { exact: true })).toBeVisible();
  await fresh.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await expect.poll(() => sent(fresh, 'save-token-forms')).toMatchObject({ forms: [] });
  await fresh.close();
});

test('different saved inputs from plugin windows require an explicit choice before resuming', async ({ page }) => {
  await openUI(page); const source = await bundle(8); const row = source.variables[0]; if (!row) throw new Error('Missing source row.');
  const forms = ['first unfinished input', 'other unfinished input'].map(text => ({ row, before: 8, revision: source.revision, kind: 'value', text }));
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: row.path, value: 8 }] }, { type: 'saved-token-forms', forms }]);
  const conflicts = page.getByRole('region', { name: 'Conflicting unfinished edits', exact: true });
  await expect(conflicts.getByRole('button', { name: 'Resume this edit', exact: true })).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Edit token', exact: true })).toHaveCount(0);
  await expect(conflicts).toContainText('first unfinished input'); await expect(conflicts).toContainText('other unfinished input');
  await conflicts.getByRole('button', { name: 'Resume this edit', exact: true }).nth(1).click();
  await expect(page.getByLabel('Value (px)', { exact: true })).toHaveValue('other unfinished input');
  await expect(conflicts).toHaveCount(0);
  await expect.poll(() => sent(page, 'save-token-forms')).toMatchObject({ forms: [forms[1]] });
  expect(await sent(page, 'edit')).toBeUndefined();
});

for (const state of ['changed', 'removed', 'unavailable'] as const) test('a saved token form retains input when its source is ' + state, async ({ page }) => {
  await openUI(page); const base = await bundle(8); const row = base.variables[0]; if (!row) throw new Error('Missing source.');
  const current = state === 'changed' ? await bundle(10) : state === 'removed' ? await figmaBundle(openWorkspace('Sevan', [{ path: 'tokens/test.tokens.json', text: '{"other":{"$type":"number","$value":10}}' }])) : undefined;
  await post(page, [{ type: 'state', bundle: current, changed: 0, local: current?.variables.map(token => ({ path: token.path, value: token.value })) ?? [] },
    { type: 'saved-token-forms', forms: [{ row, before: 8, revision: base.revision, kind: 'value', text: '12' }] }]);
  if (state === 'unavailable') {
    const saved = page.getByRole('region', { name: 'Saved token edit', exact: true });
    await expect(saved.getByLabel('Saved input', { exact: true })).toHaveValue('12');
    await expect(saved.getByRole('button', { name: 'Download token edits', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply in Figma', exact: true })).toHaveCount(0);
  } else {
    const input = page.getByLabel('Value (px)', { exact: true }); await expect(input).toHaveValue('12');
    await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('token changed'); expect(await sent(page, 'edit')).toBeUndefined();
    await page.getByRole('button', { name: 'Review current value', exact: true }).click();
    await expect(input).toHaveValue('12');
    if (state === 'removed') await expect(page.getByRole('alert')).toContainText('absent from the current source');
    else { await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click(); await expect.poll(() => sent(page, 'edit')).toMatchObject({ expected: 10, value: 12, revision: current?.revision }); }
  }
});

test('saving unfinished token input leaves the edit controls in place', async ({ page }) => {
  await openUI(page); const source = await bundle(8);
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /sevan.sys.space/u }).click();
  const apply = page.getByRole('button', { name: 'Apply in Figma', exact: true });
  await page.getByLabel('Value (px)', { exact: true }).fill('12');
  await expect(page.getByText('Saving unfinished edits on this device…', { exact: true })).toBeVisible();
  await expect(apply).toBeVisible();
  await expect.poll(() => sent(page, 'save-token-forms')).toBeTruthy();
  const saved = await sent(page, 'save-token-forms'); await post(page, [{ type: 'token-forms-saved', serial: saved?.['serial'] }]);
  await expect(page.getByText('Unfinished edits saved on this device.', { exact: true })).toBeVisible();
});

test('a newer source retains even an unacknowledged conflict field and applies against the refreshed revision', async ({ page }) => {
  await page.clock.install(); await openUI(page);
  const base = await bundle(8); const first = await bundle(10); const newer = await bundle(11); const chosen = await bundle(14);
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
  const id = 'a'.repeat(64); const proposal = await identifySubmission(changedValues(base, local), '', id);
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let current = first; let pending = false; let rejectDraft = false; let drafts: ConflictDraft[] = []; let applied: unknown;
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const data: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (isRecord(data) && data['action'] === 'review') {
      if (rejectDraft) return route.fulfill({ status: 409, json: { message: 'The workspace changed. Review its current values before choosing.' } });
      if (!isUnknownArray(data['drafts']) || !data['drafts'].every(isConflictDraft)) throw new Error('Invalid review draft.');
      drafts = data['drafts']; return route.fulfill({ json: { saved: true } });
    }
    if (isRecord(data) && isUnknownArray(data['choices'])) {
      applied = data; return route.fulfill({ json: { ...chosen, accepted: true, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' } } });
    }
    if (isRecord(data) && data['schemaVersion'] === 1) { pending = true; return route.fulfill({ json: { accepted: false, current, conflicts: pullConflicts(base, current, local), drafts } }); }
    return route.fulfill({ json: { ...current, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' },
      ...(pending ? { pending: { proposal, current, conflicts: pullConflicts(base, current, local), drafts, reviewChanged: current.revision !== first.revision } } : {}) } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, { type: 'state', bundle: base, changed: 1, local: [...local].map(([path, value]) => ({ path, value })) }, { type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  const form = page.getByRole('region', { name: 'Conflicting changes', exact: true });
  await chooseOption(form.getByRole('combobox'), 'custom'); await form.getByLabel('Value (px)', { exact: true }).fill('unfinished');
  await expect.poll(() => drafts[0]?.text).toBe('unfinished');
  rejectDraft = true; await form.getByLabel('Value (px)', { exact: true }).fill('unfinished-current');
  await expect(page.locator('main > output.sr-only')).toContainText('The workspace changed');
  current = newer; await page.clock.runFor(6000);
  await expect(form).toContainText('11 px'); await expect(form).toContainText('Source values changed');
  await expect(form.getByLabel('Value (px)', { exact: true })).toHaveValue('unfinished-current');
  expect(drafts[0]?.text).toBe('unfinished'); expect(applied).toBeUndefined();
  rejectDraft = false; await form.getByLabel('Value (px)', { exact: true }).fill('14');
  await expect.poll(() => drafts[0]?.text).toBe('14');
  await form.getByRole('button', { name: 'Apply choices', exact: true }).click();
  await expect.poll(() => applied).toEqual({ proposal, revision: newer.revision, choices: [{ path: 'sevan.sys.space', value: 14 }] });
  await expect.poll(async () => (await sent(page, 'pull'))?.['bundle']).toEqual(chosen);
});

test('a local pull that converges retains custom conflict input as a recoverable token edit', async ({ page }) => {
  await openUI(page);
  const base = await bundle(8); const incoming = await bundle(10); const converged = await bundle(12);
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
  const rows = [...local].map(([path, value]) => ({ path, value }));
  await post(page, [{ type: 'state', bundle: base, local: rows, changed: 1 },
    { type: 'conflicts', id: 'local-retention', conflicts: pullConflicts(base, incoming, local), incoming, local: rows }]);
  const conflict = page.getByRole('region', { name: 'Conflicting changes' });
  await chooseOption(conflict.getByRole('combobox'), 'custom'); await conflict.getByLabel('Value (px)', { exact: true }).fill('14');
  await expect.poll(async () => (await sent(page, 'save-token-forms'))?.['forms']).toEqual([{ row: base.variables[0], before: 12, revision: base.revision, kind: 'value', text: '14' }]);
  await post(page, [{ type: 'pulled', revision: converged.revision }, { type: 'state', bundle: converged, local: rows, changed: 0 }]);
  await expect(conflict).toBeHidden();
  await page.getByRole('button', { name: 'Review unfinished edits', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Edit token', exact: true })).toContainText('Saving unfinished edits on this device…');
  await expect(page.getByLabel('Value (px)', { exact: true })).toHaveValue('14');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Edit token', exact: true })).toContainText('Review its current value');
  await page.getByRole('button', { name: 'Review current value', exact: true }).click();
  await expect(page.getByLabel('Value (px)', { exact: true })).toHaveValue('14');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(() => sentPayload(page, 'edit')).toEqual({ type: 'edit', path: 'sevan.sys.space', expected: 12, revision: converged.revision, value: 14 });
});

test('custom conflict input reopens after its local review converges and closes', async ({ page }) => {
  await openUI(page); const base = await bundle(8); const incoming = await bundle(10); const converged = await bundle(12);
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
  const rows = [...local].map(([path, value]) => ({ path, value }));
  await post(page, [{ type: 'state', bundle: base, local: rows, changed: 1 },
    { type: 'conflicts', id: 'private-reopen', conflicts: pullConflicts(base, incoming, local), incoming, local: rows }]);
  const conflict = page.getByRole('region', { name: 'Conflicting changes' });
  await chooseOption(conflict.getByRole('combobox'), 'custom'); await conflict.getByLabel('Value (px)', { exact: true }).fill('retained invalid input');
  await expect.poll(async () => (await sent(page, 'save-token-forms'))?.['forms']).toMatchObject([{ text: 'retained invalid input' }]);
  const saved = await sent(page, 'save-token-forms');
  await post(page, [{ type: 'token-forms-saved', serial: saved?.['serial'] }, { type: 'pulled', revision: converged.revision }, { type: 'state', bundle: converged, local: rows, changed: 0 }]);
  await page.reload();
  await post(page, [{ type: 'state', bundle: converged, local: rows, changed: 0 }, { type: 'saved-token-forms', forms: saved?.['forms'] }]);
  await expect(page.getByLabel('Value (px)', { exact: true })).toHaveValue('retained invalid input');
  await expect(page.getByRole('region', { name: 'Edit token' })).toContainText('Current value: 12');
  expect(await sent(page, 'edit')).toBeUndefined();
});

for (const scenario of [{ keep: 'source', existing: false, remaining: 0 }, { keep: 'source', existing: true, remaining: 1 }, { keep: 'custom', existing: true, remaining: 0 }]) test('conflict acknowledgement consumes only fulfilled input with ' + scenario.keep + ' and existing edit ' + scenario.existing, async ({ page }) => {
  await openUI(page); const base = await bundle(8); const incoming = await bundle(10); const row = base.variables[0]; if (!row) throw new Error('Missing source.');
  const local = new Map(base.variables.map(token => [token.path, importedValue(token)])); local.set(row.path, 12);
  const rows = [...local].map(([path, value]) => ({ path, value }));
  const form = { row, before: 12, revision: base.revision, kind: 'value', text: '14' };
  await post(page, [{ type: 'state', bundle: base, local: rows, changed: 1 }, ...(scenario.existing ? [{ type: 'saved-token-forms', forms: [form] }] : []),
    { type: 'conflicts', id: 'ack-retained', conflicts: pullConflicts(base, incoming, local), incoming, local: rows }]);
  const conflict = page.getByRole('region', { name: 'Conflicting changes' });
  await chooseOption(conflict.getByRole('combobox'), 'custom'); await conflict.getByLabel('Value (px)', { exact: true }).fill('14');
  if (scenario.keep === 'source') await chooseOption(conflict.getByRole('combobox'), 'source');
  await conflict.getByRole('button', { name: 'Apply choices', exact: true }).click();
  await expect.poll(() => sent(page, 'resolve-pull')).toBeTruthy();
  const failedAttempt = await sent(page, 'resolve-pull');
  await post(page, [{ type: 'error', message: 'Injected interrupted native write.' }]);
  expect(await sent(page, 'save-token-forms')).not.toMatchObject({ forms: [] });
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Apply choices', exact: true }).click();
  await expect.poll(async () => (await sent(page, 'resolve-pull'))?.['serial']).not.toBe(failedAttempt?.['serial']);
  await post(page, [{ type: 'pulled', revision: incoming.revision }, { type: 'state', bundle: incoming, local: [{ path: row.path, value: scenario.keep === 'source' ? 10 : 14 }], changed: scenario.keep === 'source' ? 0 : 1 }]);
  if (scenario.remaining) {
    await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Unfinished token edits', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Review unfinished edits', exact: true }).click();
    await expect(page.getByLabel('Value (px)', { exact: true })).toHaveValue('14');
  } else {
    await expect.poll(async () => (await sent(page, 'save-token-forms'))?.['forms']).toEqual([]);
    await expect(page.getByRole('region', { name: 'Unfinished token edits', exact: true })).toBeHidden();
  }
});

test('an online review labels its submitted Figma value separately from a later native edit', async ({ page }) => {
  await openUI(page); const base = await bundle(8); const current = await bundle(10); const accepted = await bundle(12); const id = 'a'.repeat(64);
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
  const proposal = changedValues(base, local); const acknowledgement = { id: 'submitted-12', sourceRevision: base.revision, values: [{ path: 'sevan.sys.space', value: 12 }] };
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64); let applied: unknown;
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const body: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (isRecord(body) && body['action'] === 'review') return route.fulfill({ json: { saved: true } });
    if (isRecord(body) && Array.isArray(body['choices'])) { applied = body; return route.fulfill({ json: { ...accepted, accepted: true, acknowledgement, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' } } }); }
    return route.fulfill({ json: { ...current, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' }, pending: { proposal, current, conflicts: pullConflicts(base, current, local), drafts: [] } } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, { type: 'state', bundle: base, changed: 1, local: [{ path: 'sevan.sys.space', value: 14 }] }, { type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  const review = page.getByRole('region', { name: 'Conflicting changes', exact: true });
  await expect(review.locator('dt').filter({ hasText: /^Submitted Figma$/u }).locator('+ dd')).toHaveText('12 px');
  await expect(review.locator('dt').filter({ hasText: /^Current Figma$/u }).locator('+ dd')).toHaveText('14 px');
  await expect(review).toContainText('Later Figma edits stay queued');
  await chooseOption(review.getByRole('combobox'), 'figma'); await review.getByRole('button', { name: 'Apply choices', exact: true }).click();
  await expect.poll(() => applied).toMatchObject({ proposal, choices: [{ path: 'sevan.sys.space', value: 12 }] });
  await expect.poll(() => sent(page, 'pull')).toMatchObject({ bundle: accepted, acknowledgement });
});

test('converged conflicts show retained earlier input until explicit discard', async ({ page }) => {
  await openUI(page); const base = await bundle(8); const current = await bundle(12);
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
  const proposal = changedValues(base, local); const id = 'a'.repeat(64);
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let drafts: ConflictDraft[] = [{ path: 'sevan.sys.space', keep: 'custom', text: '14' }]; let applied: unknown;
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const data: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (isRecord(data) && data['action'] === 'review') {
      if (!isUnknownArray(data['drafts']) || !data['drafts'].every(isConflictDraft)) throw new Error('Invalid review draft.');
      drafts = data['drafts']; return route.fulfill({ json: { saved: true } });
    }
    if (isRecord(data) && isUnknownArray(data['choices'])) { applied = data; return route.fulfill({ json: { ...current, accepted: true, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' } } }); }
    return route.fulfill({ json: { ...current, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' }, pending: { proposal, current, conflicts: [], drafts, reviewChanged: true } } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, { type: 'state', bundle: base, changed: 1, local: [...local].map(([path, value]) => ({ path, value })) }, { type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  const form = page.getByRole('region', { name: 'Conflicting changes', exact: true });
  await expect(form.getByRole('textbox', { name: 'Earlier input for sevan.sys.space', exact: true })).toHaveValue('14');
  await expect(form.getByRole('button', { name: 'Apply choices', exact: true })).toBeDisabled(); expect(applied).toBeUndefined();
  await form.getByRole('button', { name: 'Discard earlier input', exact: true }).click();
  await expect.poll(() => drafts.length).toBe(0);
  await form.getByRole('button', { name: 'Apply choices', exact: true }).click();
  await expect.poll(() => applied).toEqual({ proposal, revision: current.revision, choices: [] });
});

for (const failure of ['none', 'device', 'source'] as const) test('resuming online earlier input confirms device recovery before releasing its review with ' + failure + ' failure', async ({ page }) => {
  await openUI(page); const base = await bundle(8); const current = await bundle(12);
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
  const proposal = changedValues(base, local); const id = 'a'.repeat(64);
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let drafts: ConflictDraft[] = [{ path: 'sevan.sys.space', keep: 'custom', text: '14' }]; let writes = 0; let applied: unknown;
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const data: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (isRecord(data) && data['action'] === 'acknowledge') return route.fulfill({ json: { saved: true } });
    if (isRecord(data) && data['action'] === 'review') {
      writes++;
      if (failure === 'source') return route.fulfill({ status: 409, json: { message: 'The workspace changed. Your input is retained.' } });
      if (!isUnknownArray(data['drafts']) || !data['drafts'].every(isConflictDraft)) throw new Error('Invalid review draft.');
      drafts = data['drafts']; return route.fulfill({ json: { saved: true } });
    }
    if (isRecord(data) && isUnknownArray(data['choices'])) { applied = data; return route.fulfill({ json: { ...current, accepted: true, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' } } }); }
    return route.fulfill({ json: { ...current, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' }, ...(applied ? {} : { pending: { proposal, current, conflicts: [], drafts, reviewChanged: true } }) } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, { type: 'state', bundle: base, changed: 1, local: [...local].map(([path, value]) => ({ path, value })) }, { type: 'saved-token-forms', forms: [] }, { type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  const earlier = page.getByRole('region', { name: 'Earlier conflict input', exact: true });
  await earlier.getByRole('button', { name: 'Resume token edit', exact: true }).click();
  await expect.poll(async () => (await sent(page, 'save-token-forms'))?.['forms']).toMatchObject([{ text: '14' }]);
  const saved = await sent(page, 'save-token-forms'); expect(writes).toBe(0); expect(applied).toBeUndefined();
  await post(page, [failure === 'device' ? { type: 'token-forms-error', serial: saved?.['serial'], message: 'Injected full device storage.' } : { type: 'token-forms-saved', serial: saved?.['serial'] }]);
  if (failure !== 'none') {
    await expect(page.locator('main > output.sr-only')).toContainText(failure === 'device' ? 'Injected full device storage.' : 'The workspace changed.');
    await expect(earlier.getByLabel('Earlier input for sevan.sys.space', { exact: true })).toHaveValue('14');
    expect(drafts[0]?.text).toBe('14'); expect(applied).toBeUndefined(); expect(writes).toBe(failure === 'device' ? 0 : 1);
    return;
  }
  await expect.poll(() => applied).toEqual({ proposal, revision: current.revision, choices: [] });
  await expect.poll(async () => (await sent(page, 'pull'))?.['bundle']).toEqual(current);
  await post(page, [{ type: 'state', bundle: current, changed: 0, local: [{ path: 'sevan.sys.space', value: 12 }] }, { type: 'pulled', revision: current.revision }]);
  await expect(page.locator('.plugin-sync-status[data-service=workspace]')).toHaveAttribute('data-status', 'pending');
  await expect(page.locator('.plugin-sync-status[data-service=figma]')).toHaveAttribute('data-status', 'pending');
  await expect(page.getByLabel('Value (px)', { exact: true })).toHaveValue('14');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await page.getByRole('button', { name: 'Review current value', exact: true }).click();
  await expect(page.getByLabel('Value (px)', { exact: true })).toHaveValue('14');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(() => sent(page, 'edit')).toMatchObject({ expected: 12, revision: current.revision, value: 14 });
});

for (const inputKind of ['value', 'alias'] as const) for (const legacy of [false, true]) test('native earlier ' + inputKind + ' input resumes after a source choice with legacy record ' + legacy, async ({ page }) => {
  await openUI(page); const base = await bundle(8); const current = await bundle(12); const id = 'a'.repeat(64);
  await page.evaluate(() => {
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      const envelope = event.data;
      if (!envelope || typeof envelope !== 'object' || !('pluginMessage' in envelope)) return;
      const request = envelope.pluginMessage;
      if (request && typeof request === 'object' && 'type' in request && request.type === 'save-token-forms' && 'serial' in request && 'client' in request)
        window.postMessage({ pluginMessage: { type: 'token-forms-saved', serial: request.serial, client: request.client } }, '*');
    });
  });
  const proposal = changedValues(base, new Map([['sevan.sys.space', 12]]));
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  const text = inputKind === 'alias' ? 'sevan.sys.other' : '14';
  let drafts: ConflictDraft[] = [{ path: 'sevan.sys.space', keep: 'source', text, ...(legacy ? {} : { inputKind }) }];
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const data: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (isRecord(data) && data['action'] === 'review') {
      if (!isUnknownArray(data['drafts']) || !data['drafts'].every(isConflictDraft)) throw new Error('Invalid review draft.');
      drafts = data['drafts']; return route.fulfill({ json: { saved: true } });
    }
    if (isRecord(data) && isUnknownArray(data['choices'])) return route.fulfill({ json: { ...current, accepted: true, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' } } });
    return route.fulfill({ json: { ...current, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' }, pending: { proposal, current, conflicts: [], drafts } } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, { type: 'state', bundle: base, changed: 1, local: [{ path: 'sevan.sys.space', value: 12 }] }, { type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  const earlier = page.getByRole('region', { name: 'Earlier conflict input', exact: true });
  await expect(earlier.getByLabel('Earlier input for sevan.sys.space', { exact: true })).toHaveValue(text);
  if (legacy) {
    await expect(earlier.getByRole('button', { name: 'Resume token edit', exact: true })).toHaveCount(0);
    await chooseOption(earlier.getByRole('combobox', { name: 'Input type for sevan.sys.space', exact: true }), inputKind);
  }
  const previousSave = await sent(page, 'save-token-forms');
  const previousSerial = typeof previousSave?.['serial'] === 'number' ? previousSave['serial'] : 0;
  await earlier.getByRole('button', { name: 'Resume token edit', exact: true }).click();
  await expect.poll(async () => (await sent(page, 'save-token-forms'))?.['serial']).toBeGreaterThan(previousSerial);
  const saved = await sent(page, 'save-token-forms'); expect(saved?.['forms']).toMatchObject([{ kind: inputKind, text }]);
  await expect.poll(async () => (await sent(page, 'pull'))?.['bundle']).toEqual(current);
  if (inputKind === 'alias') {
    await expect(page.getByRole('combobox', { name: 'Value kind', exact: true })).toHaveAttribute('data-select-value', 'alias');
    await expect(page.getByRole('region', { name: 'Reference token', exact: true })).toContainText('Reference: ' + text);
  } else await expect(page.getByLabel('Value (px)', { exact: true })).toHaveValue(text);
});

test('applying an untouched hex preview preserves the original native color precision without a write', async ({ page }) => {
  await openUI(page);
  const source = await figmaBundle(openWorkspace('Precision', [{ path: 'tokens/color.tokens.json', text: JSON.stringify({ brand: { ink: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.15, 0.18, 0.27], alpha: 0.5 } } } }) }]));
  const native = { r: Math.fround(0.15), g: Math.fround(0.18), b: Math.fround(0.27), a: 0.5 };
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'brand.ink', value: native }] }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /brand.ink/u }).click();
  await expect(page.getByLabel('Color (#RRGGBBAA)', { exact: true })).toHaveValue('#262e4580');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect(page.locator('main > output.sr-only')).toHaveText('No value change.');
  expect(await sent(page, 'edit')).toBeUndefined();
});

test('a token form refuses a native value changed since the form opened', async ({ page }) => {
  await openUI(page); const source = await bundle(8);
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /sevan.sys.space/u }).click();
  await page.getByLabel('Value (px)', { exact: true }).fill('12');
  await post(page, [{ type: 'state', bundle: source, changed: 1, local: [{ path: 'sevan.sys.space', value: 10 }] }]);
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect(page.locator('main > output.sr-only')).toContainText('changed in Figma while this form was open');
  expect(await sent(page, 'edit')).toBeUndefined(); await expect(page.getByLabel('Value (px)', { exact: true })).toHaveValue('12');
  await post(page, [{ type: 'state', bundle: source, changed: 1, local: [{ path: 'sevan.sys.space', value: 10 }] }]);
  await expect(page.getByRole('alert')).toContainText('changed in Figma while this form was open');
});

test('an intentional form edit carries its native value and source revision as write preconditions', async ({ page }) => {
  await openUI(page); const source = await bundle(8);
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /sevan.sys.space/u }).click(); await page.getByLabel('Value (px)', { exact: true }).fill('12');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(() => sentPayload(page, 'edit')).toEqual({ type: 'edit', path: 'sevan.sys.space', expected: 8, revision: source.revision, value: 12 });
  await post(page, [{ type: 'error', message: 'Injected native write failure' }]);
  await expect(page.getByLabel('Value (px)', { exact: true })).toHaveValue('12');
  await expect(page.locator('main > output.sr-only')).toHaveText('Injected native write failure');
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  await expect(page.getByRole('alert')).toHaveText('Injected native write failure');
  await post(page, [{ type: 'edited', path: 'sevan.sys.space' }]);
  await expect(page.getByLabel('Value (px)', { exact: true })).toHaveValue('12');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(async () => (await sent(page, 'edit'))?.['serial']).toBe(2);
  await post(page, [{ type: 'state', bundle: source, changed: 1, local: [{ path: 'sevan.sys.space', value: 12 }] }, { type: 'edited', path: 'sevan.sys.space' }]);
  await expect(page.getByLabel('Value (px)', { exact: true })).toHaveCount(0);
});

test('a numeric precision rejection keeps the exact field input and leaves source editing as the recovery path', async ({ page }) => {
  await openUI(page); const source = await bundle(8);
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /sevan.sys.space/u }).click(); const input = page.getByLabel('Value (px)', { exact: true });
  await input.fill('8.0000001'); await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(() => sentPayload(page, 'edit')).toMatchObject({ expected: 8, value: 8.0000001 });
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] }, { type: 'error', request: 'edit', code: 'number-precision', message: 'This numeric value does not round-trip. Your exact input is retained. Use Foundry to edit the source value.' }]);
  await expect(input).toHaveValue('8.0000001'); await expect(page.getByRole('alert')).toContainText('exact input is retained');
  await expect(page.getByRole('button', { name: 'Review current value', exact: true })).toHaveCount(0);
});

test('duration forms edit authored milliseconds and reject negative input before a native command', async ({ page }) => {
  await openUI(page);
  const source = await figmaBundle(openWorkspace('Timing', [{ path: 'tokens/timing.json', text: JSON.stringify({ motion: { duration: { $type: 'duration', $value: { value: 300, unit: 'ms' } } } }) }]));
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'motion.duration', value: 300 }] }]);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /motion.duration/u }).click();
  const field = page.getByRole('textbox', { name: 'Value (ms)', exact: true }); await expect(field).toHaveValue('300');
  await field.fill('-1'); await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Duration cannot be negative'); expect(await sent(page, 'edit')).toBeUndefined();
  await field.fill('400.000001'); await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(() => sentPayload(page, 'edit')).toEqual({ type: 'edit', path: 'motion.duration', value: 400.000001, expected: 300, revision: source.revision });
  const rejected = await sent(page, 'edit');
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [{ path: 'motion.duration', value: 300 }] }, { type: 'error', request: 'edit', serial: rejected?.['serial'], code: 'timing-precision', message: 'This timing value does not round-trip through the native mapping. Your exact input is retained.' }]);
  await expect(field).toHaveValue('400.000001'); await expect(page.getByRole('alert')).toContainText('exact input is retained');
  await expect(page.getByRole('button', { name: 'Review current value', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply in Figma', exact: true })).toBeEnabled();
  await field.fill('400'); await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(() => sentPayload(page, 'edit')).toEqual({ type: 'edit', path: 'motion.duration', value: 400, expected: 300, revision: source.revision });
});

test('interrupted native recovery acknowledges its saved target before fetching a newer source', async ({ page }) => {
  await openUI(page); const base = await bundle(8); const recovered = await bundle(10); const current = await bundle(14);
  const id = 'a'.repeat(64); const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  const calls: { method: string; action?: string; revision?: string }[] = [];
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const data: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    calls.push({ method: route.request().method(), ...(isRecord(data) && typeof data['action'] === 'string' ? { action: data['action'] } : {}), ...(isRecord(data) && typeof data['revision'] === 'string' ? { revision: data['revision'] } : {}) });
    return route.fulfill({ json: route.request().method() === 'POST' ? { saved: true } : { ...current, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' } } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, { type: 'state', bundle: base, changed: 0, local: base.variables.map(row => ({ path: row.path, value: importedValue(row) })), recovery: true }, { type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  await expect(page.getByRole('button', { name: 'Resume interrupted pull', exact: true })).toBeVisible();
  expect(calls).toEqual([]);
  await page.getByRole('button', { name: 'Resume interrupted pull', exact: true }).click();
  await expect.poll(() => sent(page, 'resume-pull')).toBeTruthy();
  await post(page, [{ type: 'state', bundle: recovered, changed: 0, local: recovered.variables.map(row => ({ path: row.path, value: importedValue(row) })), recovery: false }, { type: 'pulled', revision: recovered.revision }]);
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[0]).toEqual({ method: 'POST', action: 'acknowledge', revision: recovered.revision }); expect(calls[1]?.method).toBe('GET');
  await expect.poll(async () => (await sent(page, 'pull'))?.['bundle']).toEqual(current);
});

test('an unavailable baseline stops repeated saves and offers a source review that preserves native edits', async ({ page }) => {
  await page.clock.install();
  await openUI(page); const base = await bundle(8); const current = await bundle(14);
  const id = 'a'.repeat(64); const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let snapshot = base; let failedSaves = 0;
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const data: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (isRecord(data) && data['schemaVersion'] === 1) { failedSaves++; snapshot = current; return route.fulfill({ status: 409, json: { code: 'source-baseline-unavailable', message: 'Review the current source.' } }); }
    return route.fulfill({ json: route.request().method() === 'POST' && !(isRecord(data) && data['action'] === 'resume') ? { saved: true } : { ...snapshot, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' } } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, { type: 'state', bundle: base, changed: 0, local: base.variables.map(row => ({ path: row.path, value: importedValue(row) })) }, { type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  await expect.poll(() => sent(page, 'pull')).toBeTruthy(); await post(page, [{ type: 'pulled', revision: base.revision }]);
  await expect(page.getByRole('button', { name: 'Refresh Figma', exact: true })).toBeEnabled();
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
  await post(page, [{ type: 'state', bundle: base, changed: 1, local: [...local].map(([path, value]) => ({ path, value })) }]);
  await expect.poll(() => sent(page, 'proposal')).toBeTruthy(); await post(page, [{ type: 'proposal', proposal: changedValues(base, local) }]);
  const review = page.getByRole('region', { name: 'Review current source' }); await expect(review).toBeVisible();
  // Observe a complete polling interval: the same failed proposal must not repeat.
  await page.clock.runFor(3500); expect(failedSaves).toBe(1);
  await review.getByRole('button', { name: 'Review source updates', exact: true }).click();
  await expect.poll(async () => (await sent(page, 'pull'))?.['bundle']).toEqual(current);
  expect(await sent(page, 'pull')).not.toHaveProperty('choices');
});

for (const ending of ['newer', 'forget', 'proposal', 'proposal-error', 'failure', 'version']) test('obsolete native sync work cannot overwrite ' + ending + ' connection state', async ({ page }) => {
  await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000)); await openUI(page);
  const base = await bundle(8); const newer = await bundle(10); const id = 'a'.repeat(64);
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  const identity = (version: number) => ({ id, document: 'native-file', name: 'Workspace', role: 'library', version });
  let delayed: Route | undefined; let reads = 0; let writes = 0; let downloads = 0;
  page.on('download', () => { downloads++; });
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const body: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (isRecord(body) && body['action'] === 'resume') return route.fulfill({ json: { ...base, workspace: identity(1) } });
    if (isRecord(body) && body['action'] === 'acknowledge') return route.fulfill({ json: { saved: true } });
    if (isRecord(body) && body['schemaVersion'] === 1) { writes++; return route.fulfill({ status: 500, json: { message: 'Unexpected obsolete write.' } }); }
    if (++reads === 1) { delayed = route; return Promise.resolve(); }
    if (reads > 2 && ending === 'version') return route.fulfill({ json: { ...base, workspace: identity(2) } });
    return route.fulfill({ json: { ...newer, workspace: identity(3) } });
  });
  const state = (source: typeof base, value: number) => ({ type: 'state', bundle: source, changed: value === source.variables[0]?.value ? 0 : 1, local: [{ path: 'sevan.sys.space', value }] });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, state(base, 8), { type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  await expect.poll(async () => (await sent(page, 'pull'))?.['bundle']).toEqual(base);
  await post(page, [state(base, 8), { type: 'pulled', revision: base.revision }]);
  await openConnect(page, 'Connect with a code');
  const pull = page.getByRole('button', { name: 'Pull source changes', exact: true }); await expect(pull).toBeEnabled();
  await expect(page.locator('.plugin-sync-status[data-service=workspace]')).toHaveAttribute('title', 'Workspace\nUp to date');
  if (!ending.startsWith('proposal')) { await pull.click(); await expect.poll(() => !!delayed).toBe(true); await post(page, [state(base, 8)]); }
  else { await post(page, [state(base, 12)]); await expect.poll(() => sent(page, 'proposal')).toBeTruthy(); await post(page, [state(base, 12)]); }
  if (ending === 'newer' || ending === 'version') {
    await pull.click(); await expect.poll(async () => (await sent(page, 'pull'))?.['bundle']).toEqual(newer);
    await post(page, [state(newer, 10), { type: 'pulled', revision: newer.revision }]); await expect(pull).toBeEnabled();
  } else {
    await page.getByRole('button', { name: 'Forget connection', exact: true }).click(); await post(page, [{ type: 'connection-forgotten' }]);
    await expect(page.locator('main > output.sr-only')).toContainText('Connection forgotten');
  }
  const remembered = await page.evaluate(() => window.foundryPluginMessages.length);
  if (ending.startsWith('proposal')) {
    const pending = await sent(page, 'proposal'); const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
    await post(page, [ending === 'proposal-error' ? { type: 'error', request: 'proposal', serial: pending?.['serial'], message: 'Obsolete native proposal error.' } : { type: 'proposal', proposal: await identifySubmission(changedValues(base, local), '', id), ...(typeof pending?.['serial'] === 'number' ? { serial: pending['serial'] } : {}) }]);
  } else {
    if (!delayed) throw new Error('Missing delayed response.');
    await delayed.fulfill(ending === 'failure' ? { status: 503, json: { message: 'Obsolete connection error.' } } : { json: { ...base, workspace: identity(2) } });
  }
  await page.clock.runFor(100);
  if (ending === 'newer' || ending === 'version') {
    await expect.poll(async () => (await sent(page, 'pull'))?.['bundle']).toEqual(newer);
    if (ending === 'version') {
      await pull.click(); await expect(page.locator('main > output.sr-only')).toContainText('A newer workspace update');
      await expect(pull).toBeEnabled(); expect((await sent(page, 'pull'))?.['bundle']).toEqual(newer);
    }
  }
  else {
    await expect(page.locator('main > output.sr-only')).toContainText('Connection forgotten');
    const later = (await page.evaluate(offset => window.foundryPluginMessages.slice(offset), remembered)).filter(isRecord).map(value => value['pluginMessage']).filter(isRecord);
    expect(later.filter(value => ['remember-connection', 'pull'].includes(String(value['type'])))).toEqual([]);
  }
  expect(writes).toBe(0); expect(downloads).toBe(0);
});

test('a current workspace response carrying an older receipt cannot replace a fresh native edit', async ({ page }) => {
  await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000)); await openUI(page);
  const base = await bundle(8); const id = 'a'.repeat(64);
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let delayed: Route | undefined;
  const workspace = (version: number) => ({ id, document: 'native-file', name: 'Workspace', role: 'library', version });
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const body: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (isRecord(body) && body['action'] === 'resume') return route.fulfill({ json: { ...base, workspace: workspace(1) } });
    if (isRecord(body) && body['action'] === 'acknowledge') return route.fulfill({ json: { saved: true } });
    delayed = route; return Promise.resolve();
  });
  const state = (value: number) => ({ type: 'state', bundle: base, changed: value === 8 ? 0 : 1, acknowledgedReceipt: 'device:30', local: [{ path: 'sevan.sys.space', value }] });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, state(8), { type: 'saved-connection', code, resume: true }]);
  await expect.poll(() => sent(page, 'pull')).toBeTruthy(); await post(page, [state(8), { type: 'pulled', revision: base.revision }]);
  await openConnect(page, 'Connect with a code');
  const pull = page.getByRole('button', { name: 'Pull source changes', exact: true }); await expect(pull).toBeEnabled(); await pull.click();
  await expect.poll(() => !!delayed).toBe(true); await post(page, [state(12)]);
  const previous = await page.evaluate(() => window.foundryPluginMessages.length);
  if (!delayed) throw new Error('Missing delayed read.');
  await delayed.fulfill({ json: { ...base, workspace: workspace(40), acknowledgement: { id: 'device:20', sourceRevision: base.revision, values: [{ path: 'sevan.sys.space', value: 12 }] } } });
  await expect(page.locator('main > output.sr-only')).toContainText('A newer source acknowledgement is already applied'); await expect(pull).toBeEnabled();
  const later = await page.evaluate(offset => window.foundryPluginMessages.slice(offset), previous);
  expect(later.filter(isRecord).map(value => value['pluginMessage']).filter(isRecord).filter(value => value['type'] === 'pull' || value['type'] === 'remember-connection')).toEqual([]);
});

test('a workspace device resumes automatically and saves and acknowledges a native edit without Send or Pull', async ({ page }) => {
  await openUI(page);
  const original = await bundle(8); const edited = await bundle(12);
  const id = 'a'.repeat(64); const grant = 'b'.repeat(64); const secret = 'c'.repeat(64);
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + grant + '#' + secret;
  const workspace = { id, name: 'Sevan workspace', document: 'native-file', role: 'library' };
  const receipt = { id: 'receipt', sourceRevision: original.revision, values: [{ path: 'sevan.sys.space', value: 12 }] };
  let current = original; const saves: unknown[] = []; const acknowledgements: unknown[] = [];
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', async route => {
    if (route.request().method() === 'POST') {
      const data: unknown = route.request().postDataJSON();
      if (isRecord(data) && data['action'] === 'acknowledge') { acknowledgements.push(data); return route.fulfill({ json: { acknowledged: true } }); }
      if (isRecord(data) && data['action'] === 'resume') { expect(data['revision']).toBe(original.revision); return route.fulfill({ json: { ...current, workspace } }); }
      saves.push(data); current = edited;
      return route.fulfill({ json: { ...edited, workspace, accepted: true, acknowledgement: receipt } });
    }
    return route.fulfill({ json: { ...current, workspace } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, { type: 'state', bundle: original, local: original.variables.map(row => ({ path: row.path, value: importedValue(row) })), changed: 0 }, { type: 'saved-connection', code, name: 'Sevan workspace', resume: true }]);
  await expect.poll(() => sent(page, 'pull')).toBeTruthy();
  await post(page, [{ type: 'state', bundle: original, local: original.variables.map(row => ({ path: row.path, value: importedValue(row) })), changed: 0 }, { type: 'pulled', revision: original.revision }]);
  await expect.poll(() => acknowledgements.length).toBe(1);
  const local = new Map(original.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
  await post(page, [{ type: 'state', bundle: original, local: [...local].map(([path, value]) => ({ path, value })), changed: 1 }]);
  await expect.poll(() => sent(page, 'proposal')).toBeTruthy();
  await post(page, [{ type: 'proposal', proposal: changedValues(original, local) }]);
  await expect.poll(() => saves.length).toBe(1);
  await expect.poll(async () => (await sent(page, 'pull'))?.['acknowledgement']).toEqual(receipt);
  await post(page, [{ type: 'state', bundle: edited, local: edited.variables.map(row => ({ path: row.path, value: importedValue(row) })), changed: 0 }, { type: 'pulled', revision: edited.revision }]);
  await expect.poll(() => acknowledgements.length).toBe(2);
  await expect(page.getByRole('region', { name: 'Workspace changes' })).toContainText('All local changes are saved to the workspace.');
});

test('a background source response waits for an in-flight native edit and submits its completed value', async ({ page }) => {
  await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000)); await openUI(page);
  const base = await bundle(8); const accepted = await bundle(12); const id = 'a'.repeat(64);
  const workspace = { id, document: 'native-file', name: 'Workspace', role: 'library', version: 1 };
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let background: Route | undefined; const proposals: unknown[] = [];
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    if (route.request().method() === 'GET') { background = route; return Promise.resolve(); }
    const body: unknown = route.request().postDataJSON();
    if (isRecord(body) && body['action'] === 'acknowledge') return route.fulfill({ json: { saved: true } });
    if (isRecord(body) && body['action'] === 'resume') return route.fulfill({ json: { ...base, workspace } });
    proposals.push(body); return route.fulfill({ json: { ...accepted, accepted: true, workspace: { ...workspace, version: 2 } } });
  });
  const state = (value: number) => ({ type: 'state', bundle: base, changed: value === 8 ? 0 : 1, local: [{ path: 'sevan.sys.space', value }] });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, state(8), { type: 'saved-connection', code, resume: true }]);
  await expect.poll(() => sent(page, 'pull')).toBeTruthy();
  const firstPull = await sent(page, 'pull');
  await post(page, [state(8), { type: 'pulled', revision: base.revision }]);
  await expect(page.locator('.plugin-sync-status[data-service=workspace]')).toHaveAttribute('title', 'Workspace\nUp to date');
  await page.clock.runFor(3001); await expect.poll(() => !!background).toBe(true);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /sevan.sys.space/u }).click(); await page.getByLabel('Value (px)', { exact: true }).fill('12');
  await page.getByRole('button', { name: 'Apply in Figma', exact: true }).click();
  await expect.poll(() => sent(page, 'edit')).toMatchObject({ value: 12 });
  await background?.fulfill({ json: { ...base, workspace } });
  await expect(page.getByRole('button', { name: 'Apply in Figma', exact: true })).toBeDisabled();
  expect((await sent(page, 'pull'))?.['serial']).toBe(firstPull?.['serial']); expect(proposals).toEqual([]);
  await post(page, [state(12), { type: 'edited', path: 'sevan.sys.space' }]);
  await expect.poll(() => proposals.length).toBe(1);
  expect(proposals[0]).toMatchObject({ sourceRevision: base.revision, changes: [{ path: 'sevan.sys.space', before: { value: 8, unit: 'px' }, after: { value: 12, unit: 'px' } }] });
  await expect.poll(async () => (await sent(page, 'pull'))?.['bundle']).toEqual(accepted);
  await expect.poll(async () => (await sent(page, 'save-token-forms'))?.['forms']).toEqual([]);
  await expect(page.getByLabel('Value (px)', { exact: true })).toHaveCount(0);
});

for (const delayedAcknowledgement of [false, true]) test('an external native snapshot resumes its same-file receipt before sending another edit with pending acknowledgement ' + delayedAcknowledgement, async ({ page }) => {
  await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 1000)); await openUI(page);
  const base = await bundle(8); const next = await bundle(12); const id = 'a'.repeat(64);
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  const resumes: unknown[] = []; let current = base; let heldAcknowledgement: Route | undefined;
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const body: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (isRecord(body) && body['action'] === 'resume') resumes.push(body);
    if (isRecord(body) && body['action'] === 'acknowledge') {
      if (delayedAcknowledgement) { heldAcknowledgement = route; return Promise.resolve(); }
      return route.fulfill({ json: { saved: true } });
    }
    return route.fulfill({ json: { ...current, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' } } });
  });
  const state = (source: typeof base, acknowledgedReceipt = '') => ({ type: 'state', bundle: source, acknowledgedReceipt, changed: 0, local: [{ path: 'sevan.sys.space', value: source.variables[0]?.value }] });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] }, state(base), { type: 'saved-connection', code, resume: true }]);
  await expect.poll(() => sent(page, 'pull')).toBeTruthy(); await post(page, [state(base), { type: 'pulled', revision: base.revision }]);
  if (delayedAcknowledgement) await expect.poll(() => !!heldAcknowledgement).toBe(true);
  else await expect(page.locator('.plugin-sync-status[data-service=workspace]')).toHaveAttribute('title', 'Workspace\nUp to date');
  await openConnect(page, 'Connect with a code');
  await expect(page.getByRole('button', { name: 'Pull source changes', exact: true })).toBeEnabled(); current = next;
  await post(page, [state(next, 'other-device-receipt')]);
  if (heldAcknowledgement) await heldAcknowledgement.fulfill({ json: { saved: true } });
  await expect.poll(() => resumes.at(-1)).toEqual({ action: 'resume', revision: next.revision, acknowledgedReceipt: 'other-device-receipt' });
  await expect.poll(async () => (await sent(page, 'pull'))?.['bundle']).toEqual(next);
  expect(await sent(page, 'proposal')).toBeUndefined();
});

test('automatic resume refuses an unknown native source before importing or saving and leaves source review available', async ({ page }) => {
  await page.clock.install();
  await openUI(page); const foreign = await bundle(6);
  const id = 'a'.repeat(64); const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  const calls: unknown[] = [];
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const data: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    calls.push(data);
    return route.fulfill({ status: 409, json: { code: 'source-baseline-unavailable', message: 'Review the current source. Your local changes are retained.' } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] },
    { type: 'state', bundle: foreign, changed: 1, local: [{ path: 'sevan.sys.space', value: 9 }] },
    { type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  const review = page.getByRole('region', { name: 'Review current source' });
  await expect(review.getByRole('button', { name: 'Review source updates', exact: true })).toBeEnabled();
  expect(calls).toEqual([{ action: 'resume', revision: foreign.revision }]);
  expect(await sent(page, 'pull')).toBeUndefined(); expect(await sent(page, 'proposal')).toBeUndefined();
  await page.clock.runFor(3500); expect(calls).toHaveLength(1);
});

test('native resume backs off after a temporary failure and automatically retries its retained connection', async ({ page }) => {
  await page.clock.install(); await openUI(page); const source = await bundle(8);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const id = 'a'.repeat(64); const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let resumes = 0;
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    const data: unknown = route.request().method() === 'POST' ? route.request().postDataJSON() : undefined;
    if (isRecord(data) && data['action'] === 'resume') {
      resumes++;
      if (resumes === 1) return route.fulfill({ status: 503, json: { message: 'Workspace temporarily unavailable.' } });
    }
    return route.fulfill({ json: isRecord(data) && data['action'] === 'acknowledge' ? { saved: true } : { ...source, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' } } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] },
    { type: 'state', bundle: source, changed: 0, local: source.variables.map(row => ({ path: row.path, value: importedValue(row) })) },
    { type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  await expect(page.locator('.plugin-sync-status[data-service=workspace]')).toHaveAttribute('title', 'Workspace\nOffline');
  await page.clock.runFor(5000); expect(resumes).toBe(1); expect(await sent(page, 'pull')).toBeUndefined();
  await page.clock.runFor(4000); await expect.poll(() => resumes).toBe(2);
  await expect.poll(() => sent(page, 'pull')).toBeTruthy();
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [] }, { type: 'pulled', revision: source.revision }]);
  await expect(page.locator('.plugin-sync-status[data-service=workspace]')).toHaveAttribute('title', 'Workspace\nUp to date');
});

test('native polling pauses while hidden, coalesces a slow response and updates metadata without importing unchanged source', async ({ page }) => {
  await page.clock.install(); await openUI(page); const source = await bundle(8);
  const id = 'a'.repeat(64); const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let polls = 0; let release: (() => void) | undefined; const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', async route => {
    if (route.request().method() === 'GET') {
      polls++; if (polls === 1) await waiting;
      return route.fulfill({ json: { unchanged: true, workspace: { id, document: 'native-file', name: 'Renamed draft', role: 'library', repository: 'org/tokens', dirty: false, pullRequest: 'https://github.com/org/tokens/pull/7' } } });
    }
    const data: unknown = route.request().postDataJSON();
    return route.fulfill({ json: isRecord(data) && data['action'] === 'acknowledge' ? { saved: true } : { ...source, workspace: { id, document: 'native-file', name: 'Workspace', role: 'library' } } });
  });
  await post(page, [{ type: 'document', document: 'native-file', name: 'Native file', selection: [] },
    { type: 'state', bundle: source, changed: 0, local: [] }, { type: 'saved-connection', code, name: 'Workspace', resume: true }]);
  await expect.poll(() => sent(page, 'pull')).toBeTruthy();
  await post(page, [{ type: 'state', bundle: source, changed: 0, local: [] }, { type: 'pulled', revision: source.revision }]);
  await expect(page.locator('.plugin-sync-status[data-service=workspace]')).toHaveAttribute('title', 'Workspace\nUp to date');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(6000); expect(polls).toBe(0);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => polls).toBe(1); await page.clock.runFor(9000); expect(polls).toBe(1);
  release?.(); await expect(page.getByRole('heading', { name: 'Renamed draft', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Workspace changes' })).toContainText('Matches repository checkpoint · Merge request #7');
  await page.clock.runFor(3100); await expect.poll(() => polls).toBe(2);
  expect(await page.evaluate(() => window.foundryPluginMessages.filter(isMessage => typeof isMessage === 'object' && isMessage !== null && 'pluginMessage' in isMessage && typeof isMessage.pluginMessage === 'object' && isMessage.pluginMessage !== null && 'type' in isMessage.pluginMessage && isMessage.pluginMessage.type === 'pull').length)).toBe(1);
});

test('a wrong-file connection never imports a snapshot and concept files never create local variables', async ({ page }) => {
  await openUI(page); const source = await bundle(8);
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + 'a'.repeat(64) + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let document = 'another-file';
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => route.fulfill({ json: route.request().method() === 'POST' ? { acknowledged: true } : { ...source, workspace: { id: 'a'.repeat(64), name: 'Workspace', role: 'concept', document } } }));
  await openConnect(page, 'Connect with a code');
  await openConnect(page, 'Offline Figma snapshots and edits');
  await post(page, [{ type: 'document', document: 'this-file', name: 'This file', selection: [] }]);
  await page.getByLabel('Foundry connection code', { exact: true }).fill(code);
  await page.getByRole('region', { name: 'Manual link and files', exact: true }).getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('main > output.sr-only')).toContainText('belongs to another Figma file'); expect(await sent(page, 'pull')).toBeUndefined();
  document = 'this-file'; await page.getByRole('region', { name: 'Manual link and files', exact: true }).getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
  expect(await sent(page, 'pull')).toBeUndefined();
  expect(await sent(page, 'remember-connection')).toMatchObject({ concept: true });
  await expect(page.getByRole('button', { name: 'Open Figma snapshot…', exact: true })).toBeDisabled();
  await page.getByLabel('Foundry snapshot', { exact: true }).setInputFiles({ name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
  await expect(page.locator('main > output.sr-only')).toContainText('Concept files use shared library tokens');
  expect(await sent(page, 'pull')).toBeUndefined();
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await page.getByRole('button', { name: /sevan.sys.space/u }).click();
  await expect(page.getByRole('button', { name: 'Apply in Figma', exact: true })).toBeDisabled();
});

test('a saved device connection waits for explicit reconnect and can be forgotten without pulling source', async ({ page }) => {
  await openUI(page);
  const source = await bundle(8);
  const id = 'a'.repeat(64);
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + id + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let gets = 0;
  let posts = 0;
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', route => {
    if (route.request().method() === 'POST') {
      posts++;
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ saved: true }) });
    }
    gets++;
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ...source, workspace: { id, document: 'this-file', name: 'Sevan', role: 'library' } }) });
  });
  await openConnect(page, 'Connect with a code');
  await post(page, [{ type: 'document', document: 'this-file', name: 'This file', selection: [] }, { type: 'saved-connection', code, name: 'Sevan', resume: false }]);
  await expect(page.getByLabel('Foundry connection code', { exact: true })).toHaveValue(code);
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeEnabled();
  expect(gets).toBe(0); expect(posts).toBe(0); expect(await sent(page, 'pull')).toBeUndefined();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(() => sent(page, 'pull')).toBeTruthy(); expect(gets).toBe(1);
  expect(await sentPayload(page, 'remember-connection')).toEqual({ type: 'remember-connection', connection: code, name: 'Sevan', concept: false });
  await post(page, [{ type: 'state', bundle: source, local: [], changed: 0 }, { type: 'pulled', revision: source.revision }]);
  await expect.poll(() => posts).toBe(1);
  await page.getByRole('button', { name: 'Forget connection', exact: true }).click();
  await expect.poll(() => sent(page, 'forget-connection')).toBeTruthy();
  await post(page, [{ type: 'connection-forgotten' }]);
  await expect(page.getByLabel('Foundry connection code', { exact: true })).toHaveValue('');
  expect(gets).toBe(1); expect(posts).toBe(1); expect(await sent(page, 'proposal')).toBeUndefined();
});

test('a saved concept connection keeps snapshot import unavailable before reconnecting and releases it only after Forget', async ({ page }) => {
  await openUI(page); const source = await bundle(8);
  const code = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + 'a'.repeat(64) + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  await openConnect(page, 'Offline Figma snapshots and edits');
  await post(page, [{ type: 'saved-connection', code, name: 'Concept', concept: true, resume: false }]);
  await expect(page.getByRole('button', { name: 'Open Figma snapshot…', exact: true })).toBeDisabled();
  await page.getByLabel('Foundry snapshot', { exact: true }).setInputFiles({ name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
  await expect(page.locator('main > output.sr-only')).toContainText('Concept files use shared library tokens'); expect(await sent(page, 'pull')).toBeUndefined();
  await page.getByRole('button', { name: 'Forget connection', exact: true }).click();
  await expect.poll(() => sent(page, 'forget-connection')).toBeTruthy(); await post(page, [{ type: 'connection-forgotten' }]);
  await expect(page.getByRole('button', { name: 'Open Figma snapshot…', exact: true })).toBeEnabled();
});

for (const choice of ['source', 'figma', 'custom', 'alias']) {
  test('plugin UI presents the baseline and both edits and submits ' + choice + ' choices', async ({ page }) => {
    await openUI(page);
    const base = await bundle(8); const incoming = await bundle(10);
    const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
    const rows = [...local].map(([path, value]) => ({ path, value }));
    await post(page, [{ type: 'state', bundle: base, local: rows, changed: 1 },
      { type: 'conflicts', id: 'review-1', conflicts: pullConflicts(base, incoming, local), incoming, local: rows }]);
    const conflict = page.getByRole('region', { name: 'Conflicting changes' });
    await expect(conflict).toContainText('Before'); await expect(conflict).toContainText('Figma'); await expect(conflict).toContainText('Foundry');
    await expect(conflict.getByRole('button', { name: 'Apply choices', exact: true })).toBeDisabled();
    await chooseOption(conflict.getByRole('combobox', { name: 'Keep value for sevan.sys.space', exact: true }), choice);
    if (choice === 'custom') await conflict.getByLabel('Value (px)', { exact: true }).fill('14');
    if (choice === 'alias') {
      await conflict.getByLabel('Target token path', { exact: true }).fill('missing.token');
      await conflict.getByRole('button', { name: 'Apply choices', exact: true }).click();
      await expect(page.locator('main > output.sr-only')).toContainText('compatible alias');
      expect(await sent(page, 'resolve-pull')).toBeUndefined();
    } else {
      await conflict.getByRole('button', { name: 'Apply choices', exact: true }).click();
      await expect.poll(() => sent(page, 'resolve-pull')).toBeTruthy();
      expect(await sentPayload(page, 'resolve-pull')).toEqual({ type: 'resolve-pull', id: 'review-1', choices: [{ path: 'sevan.sys.space', value: choice === 'source' ? 10 : choice === 'figma' ? 12 : 14 }] });
    }
  });
}

for (const choice of ['source', 'figma', 'custom'] as const) test('a refreshed native conflict keeps ' + choice + ' input and requires a current choice', async ({ page }) => {
  await openUI(page);
  const base = await bundle(8); const first = await bundle(10); const incoming = await bundle(11);
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
  const rows = [...local].map(([path, value]) => ({ path, value }));
  await post(page, [{ type: 'state', bundle: base, local: rows, changed: 1 },
    { type: 'conflicts', id: 'review-retained', conflicts: pullConflicts(base, first, local), incoming: first, local: rows }]);
  const conflict = page.getByRole('region', { name: 'Conflicting changes' });
  await chooseOption(conflict.getByRole('combobox'), choice);
  if (choice === 'custom') await conflict.getByLabel('Value (px)', { exact: true }).fill('14');
  await post(page, [{ type: 'conflicts', id: 'review-retained', conflicts: pullConflicts(base, incoming, local), incoming, local: rows }]);
  await expect(conflict).toContainText('11 px');
  await expect(conflict).toContainText('Choose an option after reviewing');
  await expect(conflict.getByRole('button', { name: 'Apply choices', exact: true })).toBeDisabled();
  expect(await sent(page, 'resolve-pull')).toBeUndefined();
  if (choice === 'custom') await expect(conflict.getByLabel('Value (px)', { exact: true })).toHaveValue('14');
  await chooseOption(conflict.getByRole('combobox'), choice);
  await conflict.getByRole('button', { name: 'Apply choices', exact: true }).click();
  await expect.poll(() => sentPayload(page, 'resolve-pull')).toEqual({ type: 'resolve-pull', id: 'review-retained', choices: [{ path: 'sevan.sys.space', value: choice === 'source' ? 11 : choice === 'figma' ? 12 : 14 }] });
});

test('plugin UI cancels a review and exposes recovery without permitting another import or export', async ({ page }) => {
  await openUI(page);
  const base = await bundle(8); const incoming = await bundle(10);
  const local = new Map(base.variables.map(row => [row.path, importedValue(row)])); local.set('sevan.sys.space', 12);
  const rows = [...local].map(([path, value]) => ({ path, value }));
  await post(page, [{ type: 'state', bundle: base, local: rows, changed: 1 },
    { type: 'conflicts', id: 'review-cancel', conflicts: pullConflicts(base, incoming, local), incoming, local: rows }]);
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
  await expect.poll(() => sent(page, 'cancel-pull')).toBeTruthy();
  await post(page, [{ type: 'pull-cancelled' }, { type: 'state', bundle: base, local: rows, changed: 1, recovery: true }]);
  await expect(page.getByRole('region', { name: 'Conflicting changes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download changes', exact: true })).toBeDisabled();
  await openConnect(page, 'Offline Figma snapshots and edits');
  await expect(page.getByRole('button', { name: 'Open Figma snapshot…', exact: true })).toBeDisabled();
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Changes', exact: true }).click();
  await page.getByRole('button', { name: 'Resume interrupted pull', exact: true }).click();
  await expect.poll(() => sent(page, 'resume-pull')).toBeTruthy();
});

test('a successful native refresh replaces a previous export error with the current clean state', async ({ page }) => {
  await openUI(page);
  const source = await bundle(8);
  const rows = source.variables.map(row => ({ path: row.path, value: importedValue(row) }));
  await post(page, [{ type: 'state', bundle: source, local: rows, changed: 1, issue: 'Additional Figma modes require an explicit source mapping.' },
    { type: 'error', message: 'Additional Figma modes require an explicit source mapping before exporting changes.' }]);
  await expect(page.locator('main > output.sr-only')).toContainText('before exporting');
  await page.getByRole('button', { name: 'Refresh Figma', exact: true }).click();
  await post(page, [{ type: 'state', bundle: source, local: rows, changed: 0, recovery: false }]);
  await expect(page.locator('main > output.sr-only')).toHaveText('Figma values up to date.');
});

for (const choice of ['percentage', 'ratio', 'previous']) {
  test('plugin reviews an interrupted number conversion using the ' + choice + ' choice', async ({ page }) => {
    await openUI(page);
    const source = await bundle(8);
    await post(page, [{ type: 'state', bundle: source, local: [], changed: 0, recovery: true,
      unitConflicts: [{ path: 'sevan.sys.opacity', current: 26, before: 0.1, beforeScale: 1, afterScale: 100 }] }]);
    await expect(page.locator('.plugin-sync-status[data-service=figma]')).toHaveAttribute('title', 'Figma\nUnit review');
    await expect(page.getByRole('button', { name: 'Resume interrupted pull', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Download changes', exact: true })).toBeDisabled();
    const label = choice === 'percentage' ? 'Use 26% (Figma percentage)' : choice === 'ratio' ? 'Use 26 (source ratio)' : 'Restore 0.1 (previous value)';
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect.poll(() => sent(page, 'resolve-native-unit')).toBeTruthy();
    expect(await sentPayload(page, 'resolve-native-unit')).toEqual({ type: 'resolve-native-unit', path: 'sevan.sys.opacity', expectedNative: 26, value: choice === 'percentage' ? 0.26 : choice === 'ratio' ? 26 : 0.1 });
    await post(page, [{ type: 'state', bundle: source, local: [], changed: 1, recovery: true, unitConflicts: [] }]);
    await expect(page.getByRole('region', { name: 'Review native units' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume interrupted pull', exact: true })).toBeEnabled();
  });
}

test('selected layer tokens inside Tokens open the token editor directly', async ({ page }) => {
  await openUI(page);
  const source = await bundle(8);
  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  await post(page, [
    { type: 'document', document: 'doc-selection', name: 'Design system', selection: [{ id: 'node-1', name: 'Primary Button', type: 'INSTANCE', tokens: [{ field: 'itemSpacing', path: 'sevan.sys.space', remote: false }] }] },
    { type: 'state', bundle: source, changed: 0, local: [{ path: 'sevan.sys.space', value: 8 }] },
  ]);
  const selection = page.getByRole('region', { name: 'Selection', exact: true });
  await expect(selection).toContainText('Primary Button');
  await selection.getByRole('button', { name: /sevan\.sys\.space/u }).click();
  await expect(page.getByRole('region', { name: 'Edit token', exact: true })).toContainText('sevan.sys.space');
  await page.getByRole('button', { name: 'All tokens', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selection', exact: true })).toBeVisible();
});

test('Changes lists local diffs and reverts a modified token back to source', async ({ page }) => {
  await openUI(page);
  const source = await bundle(8);
  await post(page, [{ type: 'state', bundle: source, changed: 1, local: [{ path: 'sevan.sys.space', value: 12 }] }]);
  const diffs = page.getByRole('region', { name: 'Local changes', exact: true });
  await expect(diffs).toContainText('Local changes (1)');
  await expect(diffs).toContainText('sevan.sys.space');
  await expect(diffs).toContainText('8 px → 12 px');
  await diffs.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect.poll(() => sentPayload(page, 'edit')).toEqual({ type: 'edit', path: 'sevan.sys.space', expected: 12, revision: source.revision, value: 8 });
});

test('Workspace redeems a one-time pairing code with document identity automatically', async ({ page }) => {
  await openUI(page);
  const source = await bundle(8);
  const wsId = 'a'.repeat(64);
  const inviteId = 'd'.repeat(64);
  const inviteSecret = 'e'.repeat(64);
  const inviteCode = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + wsId + '/invites/' + inviteId + '#' + inviteSecret;
  const grantCode = 'https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/' + wsId + '/files/' + 'b'.repeat(64) + '#' + 'c'.repeat(64);
  let redeemedBody: unknown;
  await page.route('https://sevan.tokenfoundry.lindstruct.com/figma/workspaces/**', async route => {
    if (route.request().url().includes('/invites/')) {
      redeemedBody = route.request().postDataJSON();
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ connection: grantCode, role: 'library', expires: Date.now() + 60_000 }) });
    }
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ...source, workspace: { id: wsId, document: 'this-file', name: 'Sevan', role: 'library' } }) });
  });
  await openConnect(page, 'Connect with a code');
  await post(page, [{ type: 'document', document: 'this-file', name: 'My Library File', selection: [] }]);
  await page.getByLabel('Foundry connection code', { exact: true }).fill(inviteCode);
  await page.getByRole('region', { name: 'Manual link and files', exact: true }).getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(() => sent(page, 'pull')).toBeTruthy();
  expect(redeemedBody).toEqual({ document: 'this-file', name: 'My Library File' });
  await expect(page.getByLabel('Foundry connection code', { exact: true })).toHaveValue(grantCode);
});

test('token search combines category and modified filters', async ({ page }) => {
  await openUI(page);
  const source = await figmaBundle(openWorkspace('Sevan', [{
    path: 'tokens/test.tokens.json',
    text: JSON.stringify({
      sevan: {
        ref: { color: { green: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0.4, 0.2] } } } },
        sys: { color: { primary: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0.4, 0.2] } } } },
        comp: { button: { color: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0.4, 0.2] } } } },
      },
    }),
  }]));
  await post(page, [{
    type: 'state',
    bundle: source,
    changed: 1,
    local: [
      { path: 'sevan.ref.color.green', value: { r: 0, g: 0.4, b: 0.2, a: 1 } },
      { path: 'sevan.sys.color.primary', value: { r: 0.1, g: 0.5, b: 0.3, a: 1 } },
      { path: 'sevan.comp.button.color', value: { r: 0, g: 0.4, b: 0.2, a: 1 } },
    ],
  }]);

  await page.getByRole('navigation', { name: 'Plugin views' }).getByRole('button', { name: 'Tokens', exact: true }).click();
  const findToken = page.getByRole('searchbox', { name: 'Find a token', exact: true });
  await expect(findToken).toBeVisible();

  const chipGroup = page.getByRole('group', { name: 'Filter tokens', exact: true });
  await chipGroup.getByRole('button', { name: 'Reference', exact: true }).click();
  await chipGroup.getByRole('button', { name: 'System', exact: true }).click();
  await expect(page.getByText('2 matching tokens', { exact: true })).toBeVisible();

  await chipGroup.getByRole('button', { name: 'Modified (1)', exact: true }).click();
  await expect(page.getByText('1 matching tokens', { exact: true })).toBeVisible();

  await chipGroup.getByRole('button', { name: 'Reference', exact: true }).click();
  await chipGroup.getByRole('button', { name: 'System', exact: true }).click();
  await chipGroup.getByRole('button', { name: 'Modified (1)', exact: true }).click();
  await expect(page.getByText('3 matching tokens', { exact: true })).toBeVisible();

});

