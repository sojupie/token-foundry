import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { isJsonObject, parseJson } from '../lib/json.ts';
import type { JsonObject, JsonValue } from '../lib/json.ts';
import { compileResolver, resolveResolver } from '../lib/resolver.ts';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/build-material-sample.ts <Catalog DTCG export directory>');
const appearanceIndex = parseJson(await readFile(join(directory, 'index.json'), 'utf8'));
ok(Array.isArray(appearanceIndex) && appearanceIndex.length === 6, 'Expected the six Catalog appearance exports.');
const variants = await Promise.all(appearanceIndex.map(async entry => {
  ok(isJsonObject(entry) && typeof entry['file'] === 'string' && typeof entry['theme'] === 'string' &&
    typeof entry['contrast'] === 'string' && typeof entry['name'] === 'string', 'Invalid appearance index entry.');
  const tree = parseJson(await readFile(join(directory, entry['file']), 'utf8'));
  ok(isJsonObject(tree) && isJsonObject(tree['md']), 'Expected a Material token tree.');
  const label = entry['theme'].charAt(0).toUpperCase() + entry['theme'].slice(1) +
    (entry['contrast'] === 'default' ? '' : ' · ' + entry['contrast'] + ' contrast');
  return { label, path: entry['name'] + '.tokens.json', tree };
}));

// Keep identical data in the shared sets. Move differing tokens as whole nodes
// because a Resolver replaces a token, including its metadata, on override.
function partition(values: readonly (JsonValue | undefined)[], key = ''): [JsonValue | undefined, (JsonValue | undefined)[]] {
  const first = values[0];
  if (values.every(value => isDeepStrictEqual(value, first))) return [first, values.map(() => undefined)];
  if ((key.startsWith('$') && key !== '$root') ||
      !values.every((value): value is JsonObject => isJsonObject(value) && !('$value' in value) && !('$ref' in value))) {
    return [undefined, [...values]];
  }
  const shared: [string, JsonValue][] = [];
  const overlays = values.map((): [string, JsonValue][] => []);
  for (const child of new Set(values.flatMap(value => Object.keys(value)))) {
    const [common, differences] = partition(values.map(value => Object.hasOwn(value, child) ? value[child] : undefined), child);
    if (common !== undefined) shared.push([child, common]);
    differences.forEach((difference, index) => {
      if (difference !== undefined) overlays[index]?.push([child, difference]);
    });
  }
  return [shared.length ? Object.fromEntries(shared) : undefined,
    overlays.map(entries => entries.length ? Object.fromEntries(entries) : undefined)];
}

const [shared, differences] = partition(variants.map(variant => variant.tree));
ok(isJsonObject(shared) && isJsonObject(shared['md']), 'Expected shared Material tokens.');
const sharedFiles = Object.entries(shared['md']).map(([group, tree]) => ({
  path: group + '.tokens.json', tree: { md: { [group]: tree } },
}));
const appearanceFiles = variants.map(({ path }, index) => {
  const tree = differences[index] ?? {};
  ok(isJsonObject(tree), 'Expected an appearance token document.');
  return { path, tree };
});
const document = {
  path: 'material-3.resolver.json',
  tree: {
    version: '2025.10',
    name: 'Material 3',
    description: 'Token Catalog Material 3 exports for Web. Each appearance uses the corresponding Catalog theme and contrast.',
    sets: { Shared: { sources: sharedFiles.map(({ path }) => ({ $ref: path })) } },
    modifiers: {
      Appearance: {
        default: 'Light',
        contexts: Object.fromEntries(variants.map(({ label, path }) => [label, [{ $ref: path }]])),
      },
    },
    resolutionOrder: [{ $ref: '#/sets/Shared' }, { $ref: '#/modifiers/Appearance' }],
  },
};
const files = [document, ...sharedFiles, ...appearanceFiles];
const model = compileResolver(document, files);
deepStrictEqual(model.issues, []);
for (const { label, tree } of variants) {
  const resolved = resolveResolver(model, { Appearance: label });
  deepStrictEqual(resolved.errors, []);
  deepStrictEqual(resolved.tree, tree, label);
  strictEqual(resolved.graph.issues.size, 0, label + ' has unresolved aliases.');
  console.log(label + ': ' + resolved.graph.tokens.size + ' tokens');
}

const mtime = new Date(2000, 0, 1);
const packageEntries = files.map(({ path, tree }) => [path, strToU8(JSON.stringify(tree, null, 2) + '\n')] as const);
await writeFile(new URL('../examples/material-3.zip', import.meta.url), zipSync(Object.fromEntries(packageEntries), { mtime }));
