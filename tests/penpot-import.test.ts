import assert from 'node:assert/strict';
import { test } from 'node:test';
import { penpotSets, reviewPenpot } from '../lib/penpot-import.ts';
import { openWorkspace, workspaceChanges } from '../lib/workspace.ts';

const source = { sevan: { ref: { radius: { $type: 'dimension', $value: { value: 20, unit: 'dp' } },
  ink: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0, 0], hex: '#000000' } } },
comp: { button: { shape: { $type: 'dimension', $value: '{sevan.ref.radius}' },
  type: { $type: 'typography', $value: { fontFamily: 'Example', fontSize: { value: 14, unit: 'sp' },
    fontWeight: 500, lineHeight: 1.4, letterSpacing: { value: 0, unit: 'sp' } } } } } } };
const snapshot = { Sevan: { sevan: { ref: {
  radius: { $type: 'dimension', $value: '20px' }, ink: { $type: 'color', $value: '#000000' } },
comp: { button: { shape: { $type: 'borderRadius', $value: '{sevan.ref.radius}' },
  type: { $type: 'typography', $value: { fontFamilies: ['Example'], fontSizes: '14px', fontWeights: '500',
    lineHeights: '1.4', letterSpacing: '0px', textCase: 'none', textDecoration: 'none' } } } } } }, $themes: [] };
const open = () => openWorkspace('Test', [{ path: 'tokens.json', text: JSON.stringify(source) }]);

await test('reviews Penpot edits without changing unchanged references or units', () => {
  const text = JSON.stringify(snapshot);
  assert.deepEqual(penpotSets(text), ['Sevan']);
  assert.throws(() => reviewPenpot(open(), text, 'Sevan'), /No token values changed/u);
  const edited = structuredClone(snapshot);
  edited.Sevan.sevan.comp.button.shape.$value = '12';
  edited.Sevan.sevan.ref.ink.$value = '#336699';
  edited.Sevan.sevan.comp.button.type.$value.fontSizes = '16px';
  const original = open();
  const review = reviewPenpot(original, JSON.stringify(edited), 'Sevan');
  assert.equal(original.graph.tokens.get('sevan.comp.button.shape')?.value, '{sevan.ref.radius}');
  assert.deepEqual(review.next.graph.tokens.get('sevan.comp.button.shape')?.value, { value: 12, unit: 'dp' });
  assert.deepEqual(review.next.graph.tokens.get('sevan.comp.button.type')?.value, {
    ...source.sevan.comp.button.type.$value, fontSize: { value: 16, unit: 'sp' },
  });
  assert.deepEqual(review.next.graph.tokens.get('sevan.ref.ink')?.value, { colorSpace: 'srgb', components: [0.2, 0.4, 0.6], hex: '#336699' });
  assert.equal(workspaceChanges(review.next).length, 1);
  assert.equal(review.importedValues?.length, 3);
});

await test('rejects unknown tokens, incompatible types, and unsupported typography', () => {
  const unknown = structuredClone(snapshot);
  Object.assign(unknown.Sevan.sevan.ref, { extra: { $type: 'number', $value: '1' } });
  assert.throws(() => reviewPenpot(open(), JSON.stringify(unknown), 'Sevan'), /not open.*sevan\.ref\.extra/u);
  const wrongType = structuredClone(snapshot);
  wrongType.Sevan.sevan.comp.button.shape.$type = 'color';
  assert.throws(() => reviewPenpot(open(), JSON.stringify(wrongType), 'Sevan'), /Token type differs/u);
  const typography = structuredClone(snapshot);
  typography.Sevan.sevan.comp.button.type.$value.textCase = 'uppercase';
  assert.throws(() => reviewPenpot(open(), JSON.stringify(typography), 'Sevan'), /Text case and decoration/u);
});
