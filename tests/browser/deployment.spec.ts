import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { recoveryCopies } from './recovery-helpers.ts';

test('an open production editor survives asset replacement and keeps its unapplied form on reload', async ({ page, context }) => {
  test.setTimeout(60000);
  await mkdir('.wrangler', { recursive: true });
  const folder = await mkdtemp(resolve('.wrangler/deployment-check-'));
  await Promise.all(['a', 'b'].map(version => build({ logLevel: 'silent', mode: 'hosted', build: { outDir: join(folder, version),
    rolldownOptions: { output: { entryFileNames: 'assets/' + version + '-[hash].js', assetFileNames: 'assets/' + version + '-[hash][extname]' } } } })));
  let active = resolve(folder, 'a');
  const types = new Map([['.html', 'text/html'], ['.js', 'text/javascript'], ['.css', 'text/css'], ['.woff2', 'font/woff2']]);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const path = resolve(active, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(active + sep)) { response.writeHead(404).end(); return; }
    void readFile(path).then(body => { response.writeHead(200, { 'Content-Type': types.get(extname(path)) ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(body); return undefined; },
      () => { response.writeHead(404).end(); return undefined; });
  });
  await new Promise<void>(done => { server.listen(0, '127.0.0.1', done); });
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing verification server.');
    const origin = 'http://127.0.0.1:' + address.port;
    const errors: string[] = []; const scripts: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    // The inline worker uses a local blob URL; only server requests depend on the deployed asset manifest.
    page.on('request', request => { if (request.resourceType() === 'script' && request.url().startsWith(origin)) scripts.push(request.url()); });
    await page.goto(origin);
    await expect(page.getByRole('banner')).toBeVisible();
    const entry = await page.locator('script[type=module]').getAttribute('src'); expect(entry).toMatch(/\/a-/u);
    active = resolve(folder, 'b');
    expect((await page.request.get(origin + entry)).status()).toBe(404);
    const initialScripts = [...scripts];
    await page.locator('input[type=file][multiple]').setInputFiles({ name: 'deployment.tokens.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ gap: { $type: 'number', $value: 8 }, other: { $type: 'number', $value: 16 },
        ...Object.fromEntries(Array.from({ length: 1005 }, (_, index) => ['item' + String(index).padStart(4, '0'), { $type: 'number', $value: index }])) })) });
    await page.getByRole('button', { name: 'Value for gap', exact: true }).click();
    await page.getByRole('button', { name: 'Change value', exact: true }).click();
    const form = page.getByRole('dialog', { name: /^Change value/u });
    await form.getByRole('textbox', { name: 'Replacement value', exact: true }).fill('13');
    await form.getByRole('button', { name: 'Review edits', exact: true }).click();
    await page.getByRole('button', { name: 'Apply to workspace', exact: true }).click();
    expect(page.workers().length).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Value for gap', exact: true })).toHaveText('13');
    await page.getByRole('button', { name: 'Change value', exact: true }).click();
    await form.getByRole('textbox', { name: 'Replacement value', exact: true }).fill('17');
    await expect.poll(async () => (await recoveryCopies(page))[0]?.editor?.bulk?.form.value).toBe(17);
    expect(scripts).toEqual(initialScripts); expect(errors).toEqual([]);
    const fresh = await context.newPage(); await fresh.goto(origin);
    await expect(fresh.locator('script[type=module]')).toHaveAttribute('src', /\/b-/u); await fresh.close();
    page.on('dialog', dialog => { void dialog.accept(); }); await page.reload();
    await page.getByRole('dialog', { name: 'Recover local work' }).getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(form.getByRole('textbox', { name: 'Replacement value', exact: true })).toHaveValue('17');
    expect((await recoveryCopies(page))[0]?.files[0]?.text).toContain('"$value":13');
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections(); await new Promise<void>((done, reject) => { server.close(error => { if (error) reject(error); else done(); }); });
  }
});
