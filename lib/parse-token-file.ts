import { parseTree, visit } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { errorMessage, parseJson, requireObject, requireValue } from './json.ts';

export class TokenFileError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

export function parseTokenFile(text: string, label: string) {
  let value: ReturnType<typeof requireObject>;
  try {
    value = requireObject(parseJson(text.replace(/^\uFEFF/u, '')), label);
  } catch (failure) {
    const errors: ParseError[] = [];
    parseTree(text, errors, { disallowComments: true });
    throw new TokenFileError(errorMessage(failure), errors[0]?.offset ?? 0);
  }
  const objects: Set<string>[] = [];
  visit(text, {
    onObjectBegin() { objects.push(new Set()); },
    onObjectProperty(name, offset) {
      const keys = requireValue(objects.at(-1), 'JSON object');
      if (keys.has(name)) throw new TokenFileError('Duplicate key ' + name + ' in ' + label, offset);
      keys.add(name);
    },
    onObjectEnd() { objects.pop(); },
  });
  return value;
}
