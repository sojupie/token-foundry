import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeScale, sourceNumber, writeNative } from '../figma/native-values.ts';
import type { FigmaValue, VariableRow } from '../integrations/figma/contract.ts';

await test('native seconds recover readable milliseconds without collapsing adjacent native float values', () => {
  const app = fixture('TIMING'); const row: VariableRow = { path: 'time', name: 'time', file: 'timing.json', description: '', type: 'TIMING', sourceType: 'duration', before: { value: 300, unit: 'ms' }, value: 300, unit: 'ms', editable: true };
  writeNative(app.variable, 'source', 300, 0.001); assert.equal(sourceNumber(app.variable, 'source', row), 300);
  app.variable.valuesByMode.source = Math.fround(0.4); assert.equal(sourceNumber(app.variable, 'source', row), 400);
  const current = new Float32Array([0.4]); const bits = new Uint32Array(current.buffer); bits[0] = (bits[0] ?? 0) + 1;
  app.variable.valuesByMode.source = current[0] ?? 0;
  const adjacent = sourceNumber(app.variable, 'source', row); assert(adjacent !== undefined); assert.notEqual(adjacent, 400);
  assert.equal(Math.fround(adjacent * 0.001), app.variable.valuesByMode.source);
});

await test('every interrupted native seconds conversion remains readable and can finish without changing its authored duration', () => {
  const row: VariableRow = { path: 'time', name: 'time', file: 'timing.json', description: '', type: 'TIMING', sourceType: 'duration', before: { value: 300, unit: 'ms' }, value: 300, unit: 'ms', editable: true };
  for (const point of [1, 2, 3]) {
    const app = fixture('TIMING'); app.variable.valuesByMode.source = 0; app.fail(point);
    assert.throws(() => { writeNative(app.variable, 'source', 300, 0.001); }, /Interrupted native write/u);
    assert([0, 300].includes(sourceNumber(app.variable, 'source', row) ?? -1));
    app.fail(0); writeNative(app.variable, 'source', 300, 0.001);
    assert.equal(sourceNumber(app.variable, 'source', row), 300); assert.equal(nativeScale(app.variable, 'source'), 0.001);
  }
});

function fixture(type = 'FLOAT') {
  const data = new Map<string, string>();
  let failAt = 0;
  let operation = 0;
  const check = () => { if (++operation === failAt) throw new Error('Interrupted native write'); };
  const variable = { resolvedType: type, valuesByMode: { source: 0.196 }, getPluginData: (key: string) => data.get(key) ?? '',
    setPluginData: (key: string, value: string) => { check(); data.set(key, value); },
    setValueForMode: (_mode: string, value: FigmaValue | { type: 'VARIABLE_ALIAS'; id: string } | { r: number; g: number; b: number }) => {
      check(); assert.equal(typeof value, 'number'); if (typeof value === 'number') variable.valuesByMode.source = Math.fround(value);
    } };
  return { variable, fail: (at: number) => { failAt = at; operation = 0; } };
}
const row: VariableRow = { path: 'opacity', name: 'opacity', type: 'FLOAT', sourceType: 'number', value: 0.196, before: 0.196, file: 'test.json', description: '', editable: true };

await test('every interrupted percentage migration write retains a readable source value and can resume', () => {
  for (const operation of [1, 2, 3, 4]) {
    const app = fixture(); app.fail(operation);
    assert.throws(() => { writeNative(app.variable, 'source', 0.196, 100); }, /Interrupted/u);
    assert.equal(sourceNumber(app.variable, 'source', row), 0.196);
    app.fail(0); writeNative(app.variable, 'source', 0.196, 100);
    assert.equal(nativeScale(app.variable, 'source'), 100);
    assert.equal(sourceNumber(app.variable, 'source', row), 0.196);
    assert.equal(app.variable.getPluginData('foundry-value-scale-pending'), '');
    assert.equal(app.variable.valuesByMode.source, Math.fround(19.6));
  }
});

await test('a later native edit during an ambiguous unit migration is preserved and blocks silent conversion', () => {
  const app = fixture(); app.fail(3);
  assert.throws(() => { writeNative(app.variable, 'source', 0.196, 100); });
  app.variable.valuesByMode.source = 26;
  app.fail(0);
  assert.throws(() => { writeNative(app.variable, 'source', 0.196, 100); }, /value has been retained/u);
  assert.equal(app.variable.valuesByMode.source, 26);
});
