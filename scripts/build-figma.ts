import { build } from 'esbuild';
import type { Plugin } from 'esbuild';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isRecord } from '../lib/json.ts';
import { resolve } from 'node:path';

const output = new URL('../figma/dist/', import.meta.url);
const manifest: unknown = JSON.parse(await readFile(new URL('../figma/manifest.json', import.meta.url), 'utf8'));
if (!isRecord(manifest) || typeof manifest['id'] !== 'string' || !/^\d+$/u.test(manifest['id'])) {
  throw new Error('Register a development plugin in Figma and put its ID in figma/manifest.json before building.');
}
await mkdir(output, { recursive: true });
const adapter = process.env['FOUNDRY_FIGMA_LIBRARY'];
const plugins: Plugin[] = adapter ? [{ name: 'design-system-library', setup(context) {
  context.onResolve({ filter: /^\.\/library-adapter\.ts$/ }, () => ({ path: resolve(adapter) }));
} }] : [];
await build({ entryPoints: ['figma/code.ts'], bundle: true, format: 'iife', target: 'es2020',
  loader: { '.svg': 'text' },
  plugins,
  outfile: new URL('code.next.js', output).pathname.replace(/^\/(?=[A-Z]:)/u, '') });
const result = await build({ entryPoints: ['figma/ui.tsx'], bundle: true, format: 'iife', target: 'es2022', write: false,
  outdir: 'dist/figma-ui', loader: { '.woff2': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' } });
const script = result.outputFiles.find(file => file.path.endsWith('.js'))?.text;
const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text;
if (!script || !css) throw new Error('The plugin UI build is incomplete.');
await writeFile(new URL('ui.next.html', output), '<!doctype html><html lang="en"><meta charset="utf-8"><style>' + css + '</style><div id="root"></div><script>' + script.replaceAll('</script', '<\\/script') + '</script></html>');
// Diagnostic opt-in for local development; the ordinary build also works
// without private APIs by checking the native collection identity.
await writeFile(new URL('manifest.next.json', output), JSON.stringify(process.env['FOUNDRY_FIGMA_PRIVATE_API'] === '1' ? { ...manifest, enablePrivatePluginApi: true } : manifest, null, 2) + '\n');
await rename(new URL('code.next.js', output), new URL('code.js', output));
await rename(new URL('ui.next.html', output), new URL('ui.html', output));
await rename(new URL('manifest.next.json', output), new URL('manifest.json', output));
console.log('Built ' + output.pathname);
