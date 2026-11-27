import { openSaveReview } from './save-review.ts';
import { expect, test } from '@playwright/test';
import { editSource, recoveryCopies } from './recovery-helpers.ts';
import { chooseOption } from './select-field.ts';
import { readFile } from 'node:fs/promises';
import { readRecoveryExport } from '../../editor/lib/recovery.ts';

test('recovers an invalid bulk value form with its exact selection and leaves source unchanged until review', async ({ page }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  const original = '{"small":{"$type":"number","$value":8},"large":{"$type":"number","$value":16}}';
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'bulk.tokens.json', mimeType: 'application/json', buffer: Buffer.from(original) });
  await page.getByRole('checkbox', { name: 'Select all visible tokens', exact: true }).click();
  await page.getByRole('button', { name: 'Change value', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Change value · 2 tokens', exact: true });
  await form.getByRole('button', { name: 'Raw JSON', exact: true }).click();
  await form.getByRole('textbox', { name: 'Replacement value JSON', exact: true }).fill('{ unfinished bulk value');
  await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.bulk?.form.raw).toBe('{ unfinished bulk value');
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Replacement value JSON', exact: true })).toHaveValue('{ unfinished bulk value');
  expect((await recoveryCopies(page))[0]?.files[0]?.text).toBe(original);
  await form.getByRole('textbox', { name: 'Replacement value JSON', exact: true }).fill('20');
  await form.getByRole('button', { name: 'Review edits', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review selected token edits', exact: true });
  await expect(review.getByRole('table', { name: 'Selected token changes' })).toContainText('small');
  await expect(review.getByRole('table', { name: 'Selected token changes' })).toContainText('large');
  await review.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for small', exact: true })).toHaveText('20');
  await expect(page.getByRole('button', { name: 'Value for large', exact: true })).toHaveText('20');
});

for (const action of ['rename', 'type', 'description'] as const) test('recovers unfinished selection ' + action + ' fields without applying them', async ({ page }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/');
  const original = '{"gap":{"$type":"number","$value":8}}';
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'fields.tokens.json', mimeType: 'application/json', buffer: Buffer.from(original) });
  await page.getByRole('checkbox', { name: 'Select all visible tokens', exact: true }).click();
  const label = { rename: 'Rename', type: 'Change type', description: 'Change description' }[action];
  await page.getByRole('button', { name: label, exact: true }).click();
  const form = page.getByRole('dialog', { name: label + ' · 1 token', exact: true });
  if (action === 'rename') {
    await form.getByRole('textbox', { name: 'Find in token name', exact: true }).fill('^(.*)$');
    await form.getByRole('textbox', { name: 'Replace with', exact: true }).fill('$1-renamed');
    await form.getByRole('checkbox', { name: 'Use regular expression', exact: true }).check();
  } else if (action === 'type') {
    await chooseOption(form.getByRole('combobox', { name: 'New token type', exact: true }), 'fontFamily');
    await form.getByRole('button', { name: 'Raw JSON', exact: true }).click();
    await form.getByRole('textbox', { name: 'Replacement value JSON', exact: true }).fill('"retained family"');
  } else await form.getByRole('textbox', { name: 'New description', exact: true }).fill('retained description');
  await expect.poll(async () => {
    const draft = (await recoveryCopies(page))[0]?.editor?.bulk?.form;
    return action === 'rename' ? draft?.regex && draft.name === '$1-renamed' : action === 'type' ? draft?.type === 'fontFamily' && draft.raw === '"retained family"' : draft?.description === 'retained description';
  }).toBe(true);
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  if (action === 'rename') {
    await expect(form.getByRole('textbox', { name: 'Find in token name', exact: true })).toHaveValue('^(.*)$');
    await expect(form.getByRole('textbox', { name: 'Replace with', exact: true })).toHaveValue('$1-renamed');
    await expect(form.getByRole('checkbox', { name: 'Use regular expression', exact: true })).toBeChecked();
  } else if (action === 'type') {
    await expect(form.getByRole('combobox', { name: 'New token type', exact: true })).toHaveAttribute('data-select-value', 'fontFamily');
    await expect(form.getByRole('textbox', { name: 'Replacement value JSON', exact: true })).toHaveValue('"retained family"');
  } else await expect(form.getByRole('textbox', { name: 'New description', exact: true })).toHaveValue('retained description');
  expect((await recoveryCopies(page))[0]?.files[0]?.text).toBe(original);
  await form.getByRole('button', { name: 'Review edits', exact: true }).click();
  await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  if (action === 'rename') await expect(page.getByRole('button', { name: 'Name for gap-renamed', exact: true })).toBeVisible();
  else if (action === 'type') await expect(page.getByRole('button', { name: 'Value for gap', exact: true })).toContainText('retained family');
  else await expect(page.getByRole('button', { name: 'Description for gap', exact: true })).toHaveText('retained description');
});

test('recovers a bulk form in Dark while preserving the Light preview and other source bytes', async ({ page }) => {
  page.on('dialog', dialog => { void dialog.accept(); }); await page.goto('/');
  const files = [
    { name: 'appearance.resolver.json', tree: { version: '2025.10', sets: { Shared: { sources: [{ $ref: 'shared.tokens.json' }] } },
      modifiers: { Appearance: { default: 'Light', contexts: { Light: [{ $ref: 'light.tokens.json' }], Dark: [{ $ref: 'dark.tokens.json' }] } } },
      resolutionOrder: [{ $ref: '#/sets/Shared' }, { $ref: '#/modifiers/Appearance' }] } },
    { name: 'shared.tokens.json', tree: { shared: { $type: 'number', $value: 1 } } },
    { name: 'light.tokens.json', tree: { gap: { $type: 'number', $value: 4 } } },
    { name: 'dark.tokens.json', tree: { gap: { $type: 'number', $value: 8 } } },
  ];
  await page.locator('input[type=file][multiple]').setInputFiles(files.map(file => ({ name: file.name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file.tree)) })));
  await chooseOption(page.getByRole('combobox', { name: 'Editing set', exact: true }), { label: 'Dark' });
  await page.getByRole('button', { name: 'Value for gap', exact: true }).click();
  await page.getByRole('button', { name: 'Change value', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Change value · 1 token', exact: true });
  await form.getByRole('textbox', { name: 'Replacement value', exact: true }).fill('9');
  await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.bulk?.form.value).toBe(9);
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await expect(form).toContainText('Editing definitions in Dark.');
  await expect(form.getByRole('textbox', { name: 'Replacement value', exact: true })).toHaveValue('9');
  await expect(page.getByRole('group', { name: 'Preview' }).getByRole('combobox', { name: 'Appearance', exact: true })).toHaveAttribute('data-select-value', 'Light');
  await form.getByRole('button', { name: 'Review edits', exact: true }).click();
  await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for gap', exact: true })).toHaveText('9');
  await expect.poll(async () => (await recoveryCopies(page))[0]?.files.find(file => file.path === 'dark.tokens.json')?.text).toBe('{"gap":{"$type":"number","$value":9}}');
  const recovered = (await recoveryCopies(page))[0];
  for (const unchanged of files.filter(file => file.name !== 'dark.tokens.json')) expect(recovered?.files.find(source => source.path === unchanged.name)?.text).toBe(JSON.stringify(unchanged.tree));
});

test('recovers a bulk alias edit and keeps the authored reference chain after applying it', async ({ page }) => {
  page.on('dialog', dialog => { void dialog.accept(); }); await page.goto('/');
  const original = '{"small":{"$type":"number","$value":8},"large":{"$type":"number","$value":16},"consumer":{"$type":"number","$value":"{small}"}}';
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'alias.tokens.json', mimeType: 'application/json', buffer: Buffer.from(original) });
  await page.getByRole('button', { name: 'Value for small', exact: true }).click();
  await page.getByRole('button', { name: 'Change value', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Change value · 1 token', exact: true });
  await form.getByRole('button', { name: 'Raw JSON', exact: true }).click();
  await form.getByRole('textbox', { name: 'Replacement value JSON', exact: true }).fill('"{large}"');
  await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.bulk?.form.raw).toBe('"{large}"');
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Replacement value JSON', exact: true })).toHaveValue('"{large}"');
  await form.getByRole('button', { name: 'Review edits', exact: true }).click();
  await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for small', exact: true })).toHaveText('{large}');
  await expect.poll(async () => (await recoveryCopies(page))[0]?.files[0]?.text).toBe(original.replace('"$value":8', '"$value":"{large}"'));
});

test('restores applied source edits and the original baseline after reload', async ({ page }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/');
  await editSource(page, 8, 12);
  await expect.poll(async () => (await recoveryCopies(page))[0]?.files.some(file => file.text.includes('"value": 12'))).toBe(true);
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await openSaveReview(page);
  const review = page.getByRole('dialog', { name: 'Review changes', exact: true });
  await review.getByText('Show file changes', { exact: true }).click();
  await expect(review).toContainText('reference.tokens.json');
  await expect(review).toContainText('12');
  const copies = await recoveryCopies(page);
  expect(copies).toHaveLength(1);
  expect(copies[0]?.baseline.some(file => file.text.includes('"value": 8'))).toBe(true);
});

test('recovers an unapplied token form without changing its authored source', async ({ page }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/');
  await page.getByRole('complementary', { name: 'Groups' }).getByRole('button', { name: 'Group actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New group', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New group' });
  await form.getByRole('textbox', { name: 'Group name', exact: true }).fill('recovered-group');
  await chooseOption(form.getByRole('combobox', { name: 'Source file', exact: true }), 'reference.tokens.json');
  await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.draft?.name).toBe('recovered-group');
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Group name', exact: true })).toHaveValue('recovered-group');
  expect((await recoveryCopies(page))[0]?.files.every(file => !file.text.includes('recovered-group'))).toBe(true);
  await form.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review changes', exact: true }).getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Token groups' }).getByRole('button', { name: 'recovered-group', exact: true })).toBeVisible();
});

test('normal token forms retain inline source layout and restore exact source bytes', async ({ page }) => {
  const original = '\uFEFF{\r\n  "gap":{"$type":"dimension","$value":{"value":8,"unit":"px"}},\r\n  "other":{"$type":"number","$value":1e2}\r\n}\r\n';
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'inline.tokens.json', mimeType: 'application/json', buffer: Buffer.from(original) });
  await page.getByRole('button', { name: 'Value for gap', exact: true }).click();
  const change = async (value: string) => {
    await page.getByRole('button', { name: 'Change value', exact: true }).click();
    const form = page.getByRole('dialog', { name: /^Change value/u });
    await form.getByRole('textbox', { name: 'Token value', exact: true }).fill(value);
    await form.getByRole('button', { name: 'Review edits', exact: true }).click();
    await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  };
  await change('13');
  await expect.poll(async () => (await recoveryCopies(page)).find(copy => copy.files.some(file => file.path === 'inline.tokens.json'))?.files.find(file => file.path === 'inline.tokens.json')?.text).toBe(original.replace('"value":8', '"value":13'));
  await change('8');
  await expect.poll(async () => (await recoveryCopies(page)).find(copy => copy.files.some(file => file.path === 'inline.tokens.json'))?.files.find(file => file.path === 'inline.tokens.json')?.text).toBe(original);
});

for (const ending of ['crlf', 'mixed']) {
  test('raw source editing and recovery preserve ' + ending + ' source line endings', async ({ page }) => {
    page.on('dialog', dialog => { void dialog.accept(); });
    const original = '\uFEFF{\r\n  "gap":{"$type":"dimension","$value":{"value":8,"unit":"px"}},' + (ending === 'mixed' ? '\n' : '\r\n') + '  "other":{"$type":"number","$value":16}\r\n}\r\n';
    const edited = original.replace('"value":8', '"value":10');
    await page.goto('/');
    await page.locator('input[type=file][multiple]').setInputFiles({ name: 'inline.tokens.json', mimeType: 'application/json', buffer: Buffer.from(original) });
    await page.getByRole('navigation', { name: 'Foundry' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.getByRole('main', { name: 'Workspace management' }).getByRole('button', { name: 'inline.tokens.json', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit token source' }); const source = dialog.getByRole('textbox', { name: 'Token source JSON', exact: true });
    await source.fill(edited.replaceAll('\r\n', '\n'));
    await expect.poll(async () => (await recoveryCopies(page)).find(copy => copy.files.some(file => file.path === 'inline.tokens.json'))?.editor?.source?.text).toBe(edited);
    await page.reload(); await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
    await expect(source).toHaveValue(edited.replaceAll('\r\n', '\n'));
    await dialog.getByRole('button', { name: 'Review source changes', exact: true }).click();
    await page.getByRole('dialog', { name: 'Review changes', exact: true }).getByRole('button', { name: 'Apply to workspace', exact: true }).click();
    await expect.poll(async () => (await recoveryCopies(page)).find(copy => copy.files.some(file => file.path === 'inline.tokens.json'))?.files.find(file => file.path === 'inline.tokens.json')?.text).toBe(edited);
  });
}

test('recovers invalid unapplied raw source text and keeps the saved file intact until review', async ({ page }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/');
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'broken.tokens.json', mimeType: 'application/json', buffer: Buffer.from('{"broken": }') });
  await page.getByRole('button', { name: 'Issues (1)', exact: true }).click();
  await page.getByRole('dialog', { name: 'Workspace issues' }).getByRole('button', { name: /^broken\.tokens\.json Error/u }).click();
  const source = page.getByRole('dialog', { name: 'Edit token source' }).getByRole('textbox', { name: 'Token source JSON', exact: true });
  await source.fill('{"unfinished":');
  await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.source?.text).toBe('{"unfinished":');
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await expect(source).toHaveValue('{"unfinished":');
  expect((await recoveryCopies(page))[0]?.files[0]?.text).toBe('{"broken": }');
});

test('recovers a contextual edit with its original editing set and preview selection', async ({ page }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/');
  const files = [
    { name: 'appearance.resolver.json', tree: { version: '2025.10', sets: { Shared: { sources: [{ $ref: 'shared.tokens.json' }] } },
      modifiers: { Appearance: { default: 'Light', contexts: { Light: [{ $ref: 'light.tokens.json' }], Dark: [{ $ref: 'dark.tokens.json' }] } } },
      resolutionOrder: [{ $ref: '#/sets/Shared' }, { $ref: '#/modifiers/Appearance' }] } },
    { name: 'shared.tokens.json', tree: { shared: { $type: 'number', $value: 1 } } },
    { name: 'light.tokens.json', tree: { gap: { $type: 'number', $value: 4 } } },
    { name: 'dark.tokens.json', tree: { gap: { $type: 'number', $value: 8 } } },
  ];
  await page.locator('input[type=file][multiple]').setInputFiles(files.map(file => ({ name: file.name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file.tree)) })));
  await chooseOption(page.getByRole('combobox', { name: 'Editing set', exact: true }), { label: 'Dark' });
  await page.getByRole('button', { name: 'Name for gap', exact: true }).click();
  await page.getByRole('button', { name: 'Edit token', exact: true }).click();
  const details = page.getByRole('complementary', { name: 'Token details' });
  await details.getByRole('textbox', { name: 'Token value', exact: true }).fill('9');
  await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.variant?.draft.value).toBe('9');
  await page.reload();
  await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Editing set', exact: true })).toHaveAttribute('data-select-value', JSON.stringify(['Appearance', 'Dark']));
  await expect(details.getByRole('textbox', { name: 'Token value', exact: true })).toHaveValue('9');
  await expect(page.getByRole('group', { name: 'Preview' }).getByRole('combobox', { name: 'Appearance', exact: true })).toHaveAttribute('data-select-value', 'Light');
  await details.getByRole('button', { name: 'Review changes', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review changes', exact: true }).getByRole('button', { name: 'Apply to workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Value for gap', exact: true })).toHaveText('9');
});

test('a storage-quota failure leaves work editable and exports a recovery copy that opens in a fresh browser context', async ({ page, browser }) => {
  await page.addInitScript(() => {
    Object.defineProperty(IDBObjectStore.prototype, 'put', { value: () => { throw new DOMException('Storage full', 'QuotaExceededError'); } });
  });
  await page.goto('/'); await editSource(page, 8, 12);
  const backup = page.getByRole('button', { name: 'Download recovery copy', exact: true });
  await expect(backup).toBeVisible();
  const download = page.waitForEvent('download'); await backup.click();
  const path = await (await download).path();
  if (!path) throw new Error('The recovery download was not written.');
  const text = await readFile(path, 'utf8');
  const record = readRecoveryExport(text);
  expect(record.files.some(file => file.text.includes('"value": 12'))).toBe(true);
  const fresh = await browser.newPage();
  await fresh.goto(page.url());
  await fresh.getByRole('banner').getByRole('button', { name: 'File', exact: true }).click();
  await fresh.getByRole('menuitem', { name: 'Recover local work…', exact: true }).click();
  const chooser = fresh.waitForEvent('filechooser');
  await fresh.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Open recovery copy…', exact: true }).click();
  await (await chooser).setFiles({ name: 'foundry-recovery.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await openSaveReview(fresh);
  const review = fresh.getByRole('dialog', { name: 'Review changes', exact: true });
  await review.getByText('Show file changes', { exact: true }).click(); await expect(review).toContainText('12');
  await fresh.close();
});

test('two resumed tabs cannot overwrite each other’s recovery copy', async ({ page, context }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/'); await editSource(page, 8, 12);
  await expect.poll(async () => (await recoveryCopies(page))[0]?.files.some(file => file.text.includes('"value": 12'))).toBe(true);
  const second = await context.newPage();
  await second.goto('/');
  await second.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume source edits', exact: true }).click();
  await editSource(page, 12, 16);
  await expect.poll(async () => (await recoveryCopies(page))[0]?.files.some(file => file.text.includes('"value": 16'))).toBe(true);
  await editSource(second, 12, 20);
  await expect(second.getByRole('status').filter({ hasText: 'This recovery copy changed in another tab.' })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Download recovery copy', exact: true })).toBeVisible();
  const copies = await recoveryCopies(second);
  expect(copies[0]?.files.some(file => file.text.includes('"value": 16'))).toBe(true);
  await openSaveReview(second);
  const review = second.getByRole('dialog', { name: 'Review changes', exact: true });
  await review.getByText('Show file changes', { exact: true }).click();
  await expect(review).toContainText('20');
  await review.getByRole('button', { name: 'Back to edit', exact: true }).click();
  second.on('dialog', dialog => { void dialog.accept(); });
  await second.getByRole('banner').getByRole('button', { name: 'File', exact: true }).click();
  await second.getByRole('menuitem', { name: 'Open example', exact: true }).click();
  await second.getByRole('dialog', { name: 'Leave this workspace?', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(second.getByRole('status').filter({ hasText: 'This recovery copy changed in another tab.' })).toHaveCount(0);
});
