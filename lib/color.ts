import type { Color } from './token-types.ts';

export function colorHex(value: Color): string {
  return '#' + value.components.map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
