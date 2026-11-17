import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonObject, JsonValue } from '../lib/json.ts';
import { dtcgTypes } from '../lib/token-types.ts';
import { openWorkspace, reviewBulkEdit, reviewEdit, reviewPaste, reviewProposal, reviewSource } from '../lib/workspace.ts';
import { copyEntries } from '../lib/structure.ts';

const px = { value: 4, unit: 'px' };
const ms = { value: -4, unit: 'ms' };
const color = { colorSpace: 'srgb', components: [0.2, 0.4, 0.6], alpha: 0.5, hex: '#336699' };
const curve = [0.3, -1.2, 0.8, 1.7];
const stroke = { dashArray: [px, { value: 1, unit: 'rem' }], lineCap: 'round' };
const shadow = { color, offsetX: px, offsetY: px, blur: px, spread: { value: -1, unit: 'px' }, inset: true };

function workspace(tree: JsonObject) {
  return openWorkspace('Format examples', [{ path: 'tokens.json', text: JSON.stringify(tree) }]);
}

// Fixtures based on the Format module's type rules in sections 8–9.
const values = {
  color,
  dimension: px,
  fontFamily: ['Foundry Sans', 'serif'],
  fontWeight: 'extra-bold',
  duration: ms,
  cubicBezier: curve,
  number: -1.75,
  strokeStyle: stroke,
  border: { color, width: px, style: stroke },
  transition: { duration: ms, delay: { value: 0, unit: 's' }, timingFunction: curve },
  shadow: [shadow],
  gradient: [{ color, position: -0.1 }, { color, position: 1.3 }],
  typography: { fontFamily: ['Foundry Sans', 'serif'], fontSize: px, fontWeight: 500, letterSpacing: px, lineHeight: 1.2 },
} satisfies Record<typeof dtcgTypes[number], JsonValue>;

await test('accepts all Format types, root tokens, scoped pointers, and effective type precedence', () => {
  const tokens = Object.fromEntries(dtcgTypes.map(type => [type, { $type: type, $value: values[type] }]));
  const data = workspace({
    ...tokens,
    'brand / färger': {
      $type: 'color',
      $root: { $value: color },
      component: { $value: { $ref: '#/brand%20~1%20f%C3%A4rger/$root/$value/components/0' } },
      described: { $value: '{brand / färger.$root}', $description: 'Primary swatch' },
    },
  });
  assert.deepEqual(data.graph.documentDiagnostics, []);
  assert.equal(data.graph.issues.size, 0);
  assert.equal(data.graph.validation.size, 0);
  assert.equal(data.graph.tokens.get('brand / färger.component')?.type, 'number');
  assert.equal(data.graph.resolved.get('brand / färger.component'), 0.2);
  assert.deepEqual(data.graph.resolved.get('brand / färger.described'), color);
});

await test('diagnoses every Format value type at the failing field or array index', () => {
  const invalid: Record<typeof dtcgTypes[number], { value: JsonValue; field: string }> = {
    color: { value: { ...color, components: [0, 2, 0] }, field: '/components/1' },
    dimension: { value: { ...px, unit: 'em' }, field: '/unit' },
    fontFamily: { value: ['Foundry Sans', 1], field: '/1' },
    fontWeight: { value: 1001, field: '' },
    duration: { value: { ...ms, unit: 'min' }, field: '/unit' },
    cubicBezier: { value: [-1, 0, 1, 1], field: '/0' },
    number: { value: '1', field: '' },
    strokeStyle: { value: { ...stroke, dashArray: [{ ...px, unit: 'em' }] }, field: '/dashArray/0/unit' },
    border: { value: { ...values.border, width: { ...px, value: 'wide' } }, field: '/width/value' },
    transition: { value: { ...values.transition, timingFunction: [0, 'slow', 1, 1] }, field: '/timingFunction/1' },
    shadow: { value: [{ ...shadow, inset: 'true' }], field: '/0/inset' },
    gradient: { value: [{ color, position: '0%' }], field: '/0/position' },
    typography: { value: { ...values.typography, lineHeight: px }, field: '/lineHeight' },
  };
  const data = workspace(Object.fromEntries(dtcgTypes.map(type => [type, { $type: type, $value: invalid[type].value }])));
  for (const type of dtcgTypes) {
    const expected = '$value' + invalid[type].field + ' · ';
    assert.ok(data.graph.validation.get(type)?.some(issue => issue.startsWith(expected)), type + ' at ' + expected);
  }
});

await test('uses the same field validation for source, editor, paste, bulk, and proposal imports', () => {
  const data = workspace({ gap: { $type: 'dimension', $value: px } });
  const invalid = { ...px, unit: 'em' };
  const expected = /\$value\/unit · Use px or rem/u;
  assert.throws(() => reviewEdit(data, 'tokens.json', { path: 'gap', create: false, node: { $value: invalid } }), expected);
  assert.throws(() => reviewProposal(data, JSON.stringify({ schemaVersion: 1, changes: [{ path: 'gap', before: px, after: invalid }] })), expected);
  assert.match(reviewSource(data, 'tokens.json', JSON.stringify({ gap: { $type: 'dimension', $value: invalid } }), true).validationErrors?.join('\n') ?? '', expected);
  assert.match(reviewBulkEdit(data, ['gap'], { kind: 'value', value: invalid }).validationErrors?.join('\n') ?? '', expected);
  const entry = copyEntries(workspace({ gap: { $type: 'dimension', $value: invalid } }), ['gap']);
  assert.match(reviewPaste(data, entry, [{ path: 'gap', to: 'gap-copy', file: 'tokens.json' }]).validationErrors?.join('\n') ?? '', expected);
});

await test('resolves gradient stop references without flattening and retains unclamped authored positions', () => {
  const stop = { color, position: 2 };
  const data = workspace({
    endpoint: { $type: 'gradient', $value: [stop] },
    multi: { $type: 'gradient', $value: [{ color, position: 0.2 }, { color, position: 0.8 }] },
    number: { $type: 'number', $value: -3 },
    mix: { $type: 'gradient', $value: [{ color, position: '{number}' }, '{endpoint}'] },
    position: { $value: { $ref: '#/mix/$value/1/position' } },
    invalid: { $type: 'gradient', $value: ['{multi}'] },
  });
  assert.deepEqual(data.graph.resolved.get('mix'), [{ color, position: 0 }, { color, position: 1 }]);
  assert.equal(data.graph.resolved.get('position'), 1);
  assert.deepEqual(data.graph.tokens.get('endpoint')?.value, [stop]);
  assert.deepEqual(data.graph.tokens.get('mix')?.value, [{ color, position: '{number}' }, '{endpoint}']);
  assert.equal(data.graph.resolved.get('number'), -3);
  assert.equal(data.graph.validation.has('mix'), false);
  assert.match(data.graph.validation.get('invalid')?.join('\n') ?? '', /\$value\/0 · Expected a gradientStop object/u);
});
