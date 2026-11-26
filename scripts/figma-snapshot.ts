import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { openWorkspace } from '../lib/workspace.ts';
import { figmaBundle } from '../integrations/figma/projection.ts';

const [input, output, name] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/figma-snapshot.ts TOKENS_FOLDER OUTPUT.json [NAME]');
const directory = resolve(input);
const names = (await readdir(directory, { recursive: true })).filter(path => /(?:\.tokens(?:\.json)?|\.resolver\.json|^tokens\.json)$/u.test(path));
const files = await Promise.all(names.map(async path => ({ path: basename(directory) + '/' + path.replaceAll('\\', '/'), text: await readFile(resolve(directory, path), 'utf8') })));
const bundle = await figmaBundle(openWorkspace(name ?? basename(directory), files));
await writeFile(output, JSON.stringify(bundle));
console.log('Exported ' + bundle.variables.length + ' variables; preserved ' + bundle.unsupported.length + ' source values.');
