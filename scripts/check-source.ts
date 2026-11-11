import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const generated = new Set(['.git', 'dist', 'node_modules', 'sources/originals']);
const code = /\.(?:[cm]?[jt]s|[jt]sx|astro)$/u;
const suppressed = /(?:\/\/|\/\*|<!--)\s*(?:(?:oxlint|eslint)-disable\b|@ts-(?:ignore|nocheck|expect-error)\b)/u;

async function check(folder: string): Promise<void> {
  const entries = await readdir(folder || '.', { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = join(folder, entry.name);
    if (generated.has(path)) return;
    if (entry.isDirectory()) await check(path);
    else if (entry.isFile() && code.test(path) && suppressed.test(await readFile(path, 'utf8'))) {
      throw new Error('Type or lint suppression is forbidden in ' + path + '.');
    }
  }));
}

await check('');
