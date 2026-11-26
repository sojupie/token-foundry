import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceText, textareaText } from '../lib/source-text.ts';

await test('textarea edits retain source BOM, line endings, final newline and untouched mixed lines', () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    const original = '\uFEFF{' + ending + '  "space": 8,' + ending + '  "other": 16' + ending + '}' + ending;
    assert.equal(sourceText(original, textareaText(original)), original);
    assert.equal(sourceText(original, textareaText(original).replace(': 8', ': 10')), original.replace(': 8', ': 10'));
    assert.equal(sourceText(original, textareaText(original).replace('  "other": 16\n', '')), original.replace('  "other": 16' + ending, ''));
    assert.equal(sourceText(original, textareaText(original).replace('}', '  "new": 24\n}')), original.replace('}', '  "new": 24' + ending + '}'));
    assert.equal(sourceText(original, textareaText(original).trimEnd()), original.slice(0, -ending.length));
  }
  const mixed = '{\r\n  "space": 8,\n  "other": 16\r\n}\n';
  assert.equal(sourceText(mixed, textareaText(mixed).replace(': 8', ': 10')), mixed.replace(': 8', ': 10'));
  assert.equal(sourceText(mixed, textareaText(mixed).replace(': 16', ': 24')), mixed.replace(': 16', ': 24'));
  assert.equal(sourceText('', 'first\nsecond'), 'first\nsecond');
  assert.equal(sourceText('single', ''), '');
});
