import { visit } from 'jsonc-parser';
import { parseJson, requireObject, requireValue } from './json.ts';

export function parseTokenFile(text: string, label: string) {
  const value = requireObject(parseJson(text), label);
  const objects: Set<string>[] = [];
  visit(text, {
    onObjectBegin() { objects.push(new Set()); },
    onObjectProperty(name) {
      const keys = requireValue(objects.at(-1), 'JSON object');
      if (keys.has(name)) throw new Error('Duplicate key ' + name + ' in ' + label);
      keys.add(name);
    },
    onObjectEnd() { objects.pop(); },
  });
  return value;
}
