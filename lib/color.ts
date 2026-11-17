import type { Color } from './token-types.ts';

export function colorHex(value: Color): string {
  return '#' + value.components.map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

const rgb = ['Red', 'Green', 'Blue'] as const;
const xyz = ['X', 'Y', 'Z'] as const;
const scale = [0, 1] as const;
const percent = [0, 100] as const;
const hue = [0, 360] as const;
const unbounded = [-Infinity, Infinity] as const;
const chroma = [0, Infinity] as const;

export const colorSpaces: Readonly<Record<string, {
  name: string;
  components: readonly [string, string, string];
  ranges: readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
}>> = {
  srgb: { name: 'sRGB', components: rgb, ranges: [scale, scale, scale] },
  'srgb-linear': { name: 'Linear sRGB', components: rgb, ranges: [scale, scale, scale] },
  hsl: { name: 'HSL', components: ['Hue', 'Saturation', 'Lightness'], ranges: [hue, percent, percent] },
  hwb: { name: 'HWB', components: ['Hue', 'Whiteness', 'Blackness'], ranges: [hue, percent, percent] },
  lab: { name: 'CIELAB', components: ['Lightness', 'A', 'B'], ranges: [percent, unbounded, unbounded] },
  lch: { name: 'LCH', components: ['Lightness', 'Chroma', 'Hue'], ranges: [percent, chroma, hue] },
  oklab: { name: 'OKLab', components: ['Lightness', 'A', 'B'], ranges: [scale, unbounded, unbounded] },
  oklch: { name: 'OKLCH', components: ['Lightness', 'Chroma', 'Hue'], ranges: [scale, chroma, hue] },
  'display-p3': { name: 'Display P3', components: rgb, ranges: [scale, scale, scale] },
  'a98-rgb': { name: 'A98 RGB', components: rgb, ranges: [scale, scale, scale] },
  'prophoto-rgb': { name: 'ProPhoto RGB', components: rgb, ranges: [scale, scale, scale] },
  rec2020: { name: 'Rec. 2020', components: rgb, ranges: [scale, scale, scale] },
  'xyz-d65': { name: 'XYZ D65', components: xyz, ranges: [scale, scale, scale] },
  'xyz-d50': { name: 'XYZ D50', components: xyz, ranges: [scale, scale, scale] },
};

export function colorSpace(name: string | undefined) {
  return name && Object.hasOwn(colorSpaces, name) ? colorSpaces[name] : undefined;
}
