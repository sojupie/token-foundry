import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Scanner } from '@tailwindcss/oxide';
import { __unstable__loadDesignSystem } from 'tailwindcss';

const generated = new Set(['.git', 'dist', 'node_modules', 'sources/originals']);
const code = /\.(?:[cm]?[jt]s|[jt]sx|astro)$/u;
const suppressed = /(?:\/\/|\/\*|<!--)\s*(?:(?:oxlint|eslint)-disable\b|@ts-(?:ignore|nocheck|expect-error)\b)/u;
const uiSource = /^(?:(?:editor|integrations)\/.*\.(?:[cm]?[jt]sx?|css)|index\.html)$/u;
const colorProperty = /^(?:color|[\w-]+-color|background|border|outline|fill|stroke|--tw-gradient-(?:from|via|to)|--color-[\w-]+)$/u;
const typographyProperty = /^(?:font(?:-[\w-]+)?|-(?:webkit|moz-osx)-font-smoothing|line-height|letter-spacing|word-spacing|text-(?:transform|shadow|indent|rendering|underline-offset|box-[\w-]+|decoration(?:-[\w-]+)?|emphasis(?:-[\w-]+)?)|--(?:font|leading|tracking|text)-[\w-]+)$/u;

const theme = await readFile(new URL(import.meta.resolve('tailwindcss/theme.css')), 'utf8');
const workspace = await readFile('editor/workspace.css', 'utf8');
// Resolve candidates with the same theme as the app so variants, arbitrary
// values, and project aliases follow the same rule as built-in utilities.
const design = await __unstable__loadDesignSystem(theme + workspace.replace(/@(?:import|apply)\b[^;]*;/gu, ''));
const candidates = new Map<string, Set<string>>();
const scanner = new Scanner({});

function record(value: string, path: string, line: number) {
  for (const utility of value.trim().split(/\s+/u)) {
    if (!utility) continue;
    const locations = candidates.get(utility) ?? new Set<string>();
    locations.add(path + ':' + line);
    candidates.set(utility, locations);
  }
}

function checkStyles(path: string, contents: string) {
  if (path.endsWith('.css')) {
    for (const match of contents.matchAll(/@apply\s+([^;]+);/gu)) {
      record(match[1] ?? '', path, contents.slice(0, match.index).split('\n').length);
    }
    return;
  }
  const bytes = Buffer.from(contents);
  for (const { candidate, position } of scanner.getCandidatesWithPositions({ content: contents, extension: extname(path).slice(1) })) {
    record(candidate, path, bytes.subarray(0, position).toString().split('\n').length);
  }
}

async function check(folder: string): Promise<void> {
  const entries = await readdir(folder || '.', { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = join(folder, entry.name);
    if (generated.has(path)) return;
    if (entry.isDirectory()) await check(path);
    else if (entry.isFile() && (code.test(path) || uiSource.test(path))) {
      const contents = await readFile(path, 'utf8');
      if (code.test(path) && suppressed.test(contents)) {
        throw new Error('Type or lint suppression is forbidden in ' + path + '.');
      }
      if (uiSource.test(path)) checkStyles(path, contents);
    }
  }));
}

await check('');

const utilities = [...candidates.keys()];
const violations: string[] = [];
design.candidatesToCss(utilities).forEach((css, index) => {
  const utility = utilities[index];
  if (!css || !utility) return;
  const forbidden = [...css.matchAll(/^\s*([\w-]+):\s*([^;]+);/gmu)].some(([, property, value]) =>
    !!property && (colorProperty.test(property) || typographyProperty.test(property) ||
      property === 'background-image' && !!value?.includes('gradient(') && !value.includes('--tw-gradient-stops')));
  if (!forbidden) return;
  for (const location of candidates.get(utility) ?? []) violations.push(location + '  ' + utility);
});
if (violations.length) {
  process.stderr.write('Use Forge components or token-backed CSS for color and typography.\n' + violations.toSorted().join('\n') + '\n');
  process.exitCode = 1;
}
