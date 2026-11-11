import { parseJson } from '../../lib/json.ts';
import type { JsonValue } from '../../lib/json.ts';
import { colorHex } from '../../lib/color.ts';
import { isColor, isDimension } from '../../lib/token-types.ts';

const alias = /^\{[^{}]+\}$/u;
const dimension = /^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*([a-z]+)$/iu;
const hex = /^#[0-9a-f]{6}$/iu;
const simpleTypes = new Set(['number', 'fontWeight', 'fontFamily', 'dimension', 'duration']);

export function inputFormat(type: string | undefined, value?: JsonValue): 'hex' | 'text' | 'json' {
  if ((isColor(value) && value.colorSpace === 'srgb') || (type === 'color' && value === undefined)) return 'hex';
  if (type !== undefined && simpleTypes.has(type) && (value == null || typeof value !== 'object' || isDimension(value))) return 'text';
  if (typeof value === 'string' && alias.test(value)) return 'text';
  return 'json';
}

export function displayInput(type: string | undefined, value?: JsonValue): string {
  if (value === undefined) return '';
  const format = inputFormat(type, value);
  if (format === 'hex' && isColor(value)) return colorHex(value);
  if (format === 'text' && isDimension(value)) return value.value + ' ' + value.unit;
  if (format === 'text' && (value === null || typeof value !== 'object')) return String(value);
  return JSON.stringify(value, null, 2);
}

export function readInput(text: string, type: string | undefined, original?: JsonValue): JsonValue {
  const value = text.trim();
  if (!value) throw new Error('Enter a token value.');
  if (alias.test(value)) return value;
  if (type === 'color' && hex.test(value)) return {
    ...(isColor(original) && original.colorSpace === 'srgb' ? original : {}),
    colorSpace: 'srgb',
    components: value.slice(1).match(/../gu)?.map((part) => parseInt(part, 16) / 255) ?? [],
    hex: value.toUpperCase(),
  };
  const match = (type === 'dimension' || type === 'duration') && dimension.exec(value);
  if (match && match[2] && Number.isFinite(Number(match[1]))) {
    return { ...(isDimension(original) ? original : {}), value: Number(match[1]), unit: match[2] };
  }
  if ((type === 'fontFamily' || type === 'fontWeight') && !/^[[{"\d-]/u.test(value)) return value;
  try {
    return parseJson(value);
  } catch {
    throw new Error('Enter a value such as #336699, 8 dp, {color.primary}, or valid JSON.');
  }
}
