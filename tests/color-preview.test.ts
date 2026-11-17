import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertColor, displayColor } from '../editor/lib/color-preview.ts';
import { colorSpaces } from '../lib/color.ts';
import { validateTokenValue } from '../lib/validate-token.ts';

await test('converts and renders every DTCG color space within its component limits', () => {
  const original = { colorSpace: 'srgb', components: [0.25, 0.5, 0.75], alpha: 0.8 };
  assert.equal(Object.keys(colorSpaces).length, 14);
  for (const colorSpace of Object.keys(colorSpaces)) {
    const converted = convertColor(original, colorSpace);
    assert.ok(converted, colorSpace);
    const value = { colorSpace, components: converted.components, alpha: original.alpha };
    assert.equal(validateTokenValue('color', value), undefined, colorSpace);
    assert.match(displayColor(value)?.css ?? '', /^color\(srgb [^NaN]+ \/ 0\.8\)$/u, colorSpace);
  }
  assert.deepEqual(original, { colorSpace: 'srgb', components: [0.25, 0.5, 0.75], alpha: 0.8 });
});

await test('uses authored fallback only for previews outside the display gamut', () => {
  const value = { colorSpace: 'display-p3', components: [0, 1, 0], alpha: 0.5, hex: '#12AB34' };
  assert.deepEqual(displayColor(value, 'srgb'), { css: '#12AB3480', fallback: 'Using the authored sRGB fallback' });
  assert.equal(displayColor(value, 'p3')?.fallback, undefined);
  assert.equal(convertColor(value, 'srgb')?.clipped, true);
  assert.equal(value.hex, '#12AB34');
});
