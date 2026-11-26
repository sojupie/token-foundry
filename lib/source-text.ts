import { diffLines } from 'diff';

export const textareaText = (text: string): string => text.replaceAll(/\r\n?/gu, '\n');

/** Textareas normalize newlines. Keep source line endings and use the file's
 * first line ending for additional lines. */
export function sourceText(original: string, input: string): string {
  const normalized = textareaText(input);
  if (normalized === textareaText(original)) return original;
  const ending = /\r\n|\r|\n/u.exec(original)?.[0] ?? '\n';
  const lines = original.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)?.filter(Boolean) ?? [];
  let offset = 0;
  let replaced: string[] = [];
  return diffLines(textareaText(original), normalized).map(change => {
    if (change.added) {
      const added = change.value.match(/[^\n]*(?:\n|$)/gu)?.filter(Boolean) ?? [];
      const text = added.map((line, index) => line.endsWith('\n') ? line.slice(0, -1) + (/\r\n|\r|\n/u.exec(replaced[index] ?? '')?.[0] ?? ending) : line).join('');
      replaced = [];
      return text;
    }
    const count = change.count ?? 0;
    const retained = lines.slice(offset, offset + count);
    offset += count;
    replaced = change.removed ? retained : [];
    return change.removed ? '' : retained.join('');
  }).join('');
}
