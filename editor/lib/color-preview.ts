import { A98RGB, HSL, HWB, Lab, LCH, OKLab, OKLCH, P3, ProPhoto, REC_2020, sRGB, sRGB_Linear, XYZ_D50, XYZ_D65,
  inGamut, to, toGamut } from 'colorjs.io/fn';
import type { ColorSpace, PlainColorObject } from 'colorjs.io/fn';
import { colorSpace } from '../../lib/color.ts';
import { isJsonObject } from '../../lib/json.ts';
import type { JsonValue } from '../../lib/json.ts';

const spaces: Readonly<Record<string, ColorSpace>> = {
  srgb: sRGB, 'srgb-linear': sRGB_Linear, hsl: HSL, hwb: HWB, lab: Lab, lch: LCH, oklab: OKLab, oklch: OKLCH,
  'display-p3': P3, 'a98-rgb': A98RGB, 'prophoto-rgb': ProPhoto, rec2020: REC_2020, 'xyz-d65': XYZ_D65, 'xyz-d50': XYZ_D50,
};

const readCoordinate = (item: JsonValue | undefined) => typeof item === 'number' && Number.isFinite(item) ? item : item === 'none' ? null : undefined;

function colorCoordinates(value: JsonValue | undefined): PlainColorObject | undefined {
  if (!isJsonObject(value)) return undefined;
  const { colorSpace: name, components, alpha } = value;
  const space = typeof name === 'string' && Object.hasOwn(spaces, name) ? spaces[name] : undefined;
  if (!space || !Array.isArray(components) || components.length !== 3) return undefined;
  const [first, second, third] = components.map(readCoordinate);
  if (first === undefined || second === undefined || third === undefined ||
    alpha !== undefined && (typeof alpha !== 'number' || alpha < 0 || alpha > 1)) return undefined;
  return { space, coords: [first, second, third], alpha: alpha ?? 1 };
}

export function convertColor(value: JsonValue | undefined, name: string): { components: JsonValue[]; clipped: boolean } | undefined {
  const authored = colorCoordinates(value);
  const target = Object.hasOwn(spaces, name) ? spaces[name] : undefined;
  const definition = colorSpace(name);
  if (!authored || !target || !definition) return undefined;
  const converted = to(authored, target);
  let clipped = !inGamut(converted, target);
  if (clipped) toGamut(converted, { space: target, method: 'clip' });
  if (converted.coords.some(coordinate => coordinate !== null && !Number.isFinite(coordinate))) return undefined;
  const components = converted.coords.map((coordinate, index) => {
    if (coordinate === null) return 'none';
    const [min, max] = definition.ranges[index] ?? [-Infinity, Infinity];
    const rounded = Number(coordinate.toFixed(8));
    if (max === 360) return (rounded % max + max) % max;
    const limited = Math.max(min, Math.min(max, rounded));
    if (Math.abs(limited - rounded) > 1e-7) clipped = true;
    return limited;
  });
  return { components, clipped };
}

export function displayColor(value: JsonValue | undefined, gamut: 'srgb' | 'p3' | 'rec2020' = 'srgb') {
  const color = colorCoordinates(value);
  if (!color) return undefined;
  const space = gamut === 'p3' ? P3 : gamut === 'rec2020' ? REC_2020 : sRGB;
  const name = gamut === 'p3' ? 'display-p3' : gamut;
  const outside = !inGamut(color, space);
  const hex = isJsonObject(value) ? value['hex'] : undefined;
  if (outside && typeof hex === 'string' && /^#[0-9a-f]{6}$/iu.test(hex)) {
    const opacity = Math.round((color.alpha ?? 1) * 255).toString(16).padStart(2, '0');
    return { css: hex + opacity, fallback: 'Using the authored sRGB fallback' };
  }
  const preview = to(color, space);
  if (outside) toGamut(preview, { space, method: 'clip' });
  if (preview.coords.some(coordinate => coordinate !== null && !Number.isFinite(coordinate))) return undefined;
  const channels = preview.coords.map(part => part ?? 0).join(' ');
  return { css: 'color(' + name + ' ' + channels + ' / ' + (preview.alpha ?? 1) + ')',
    fallback: outside ? 'Preview mapped to the display gamut' : undefined };
}
