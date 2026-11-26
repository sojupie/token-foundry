import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { build } from 'vite';
import { recoveryExport } from '../../editor/lib/recovery.ts';
import { mergeRepositorySources, RepositoryConflicts } from '../../lib/repository-merge.ts';
import { recoveryCopies } from './recovery-helpers.ts';

test('the static build resumes repository choices and exports a patch without using a Git service', async ({ page }, info) => {
  const output = info.outputPath('static-build');
  await build({ mode: 'production', logLevel: 'error', build: { outDir: output, emptyOutDir: true } });
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const target = resolve(output, '.' + (path === '/' ? '/index.html' : path));
    if (!target.startsWith(output + sep)) { response.writeHead(404); response.end(); return; }
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.zip': 'application/zip' };
    void readFile(target).then(body => { response.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream' }); return response.end(body); }, () => { response.writeHead(404); return response.end(); });
  });
  await new Promise<void>(resolveListening => { server.listen(0, '127.0.0.1', resolveListening); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Static preview did not start.');
  try {
    const sources = await Promise.all(['reference.tokens.json', 'system.tokens.json'].map(async path => ({ path, text: await readFile(new URL('../../examples/' + path, import.meta.url), 'utf8') })));
    const draft = sources.map(source => ({ ...source, text: source.text.replace('"value": 8', '"value": 12') }));
    const remote = sources.map(source => ({ ...source, text: source.text.replace('"value": 8', '"value": 10').replace('"value": 16', '"value": 24') }));
    let conflictId = '';
    try { mergeRepositorySources(sources, draft, remote); } catch (cause) { if (!(cause instanceof RepositoryConflicts)) throw cause; conflictId = cause.conflicts[0]?.id ?? ''; }
    const snapshot = { repository: 'example/tokens', revision: 'a'.repeat(40), root: 'tokens', files: sources };
    const copy = recoveryExport({ id: 'static-recovery-fixture', revision: 1, updated: Date.now(), name: snapshot.repository, folder: false,
      files: draft, baseline: sources, github: snapshot, shared: { id: '1'.repeat(64), origin: 'https://sevan.tokenfoundry.lindstruct.com', accepted: { revision: '2'.repeat(64), files: sources } },
      repositoryReview: { snapshot: { ...snapshot, revision: 'b'.repeat(40), files: remote }, choices: [{ id: conflictId, keep: 'draft', text: '12' }] } });
    const gitRequests: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/git/')) gitRequests.push(request.url()); });
    await page.goto('http://127.0.0.1:' + address.port + '/?workspace=' + 'a'.repeat(64));
    await page.getByRole('banner').getByRole('button', { name: 'File', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Recover local work…', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Open recovery copy…', exact: true }).click();
    await (await chooser).setFiles({ name: 'recovery.json', mimeType: 'application/json', buffer: Buffer.from(copy) });
    const dialog = page.getByRole('dialog', { name: 'Reconcile repository changes' });
    await expect(dialog.getByRole('combobox')).toHaveValue('Keep your draft');
    await dialog.getByRole('button', { name: 'Review merged changes', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export patch', exact: true }).click();
    const path = await (await download).path(); if (!path) throw new Error('The patch was not downloaded.');
    const patch = await readFile(path, 'utf8');
    expect(patch).toContain('"value": 10'); expect(patch).toContain('"value": 12'); expect(patch).toContain('"value": 24');
    await expect.poll(async () => (await recoveryCopies(page)).find(record => record.github?.revision === 'b'.repeat(40))?.files.find(source => source.path === 'reference.tokens.json')?.text).toContain('"value": 12');
    expect((await recoveryCopies(page)).find(record => record.github?.revision === 'b'.repeat(40))?.shared?.origin).toBe('https://sevan.tokenfoundry.lindstruct.com');
    expect(gitRequests).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClosing, reject) => { server.close(error => error ? reject(error) : resolveClosing()); });
  }
});
