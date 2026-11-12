import { isJsonObject, parseJson } from '../../lib/json.ts';
import type { JsonValue } from '../../lib/json.ts';
import { colorHex } from '../../lib/color.ts';
import { isColor, isDimension } from '../../lib/token-types.ts';

const alias = /^\{[^{}]+\}$/u;
const dimension = /^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*([a-z]+)$/iu;
const hex = /^#[0-9a-f]{6}$/iu;
const simpleTypes = new Set(['number', 'fontWeight', 'fontFamily', 'dimension', 'duration', 'strokeStyle']);

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
  if ((type === 'fontFamily' || type === 'fontWeight' || type === 'strokeStyle') && !/^[[{"\d-]/u.test(value)) return value;
  try {
    return parseJson(value);
  } catch {
    throw new Error('Enter a value such as #336699, 8 dp, {color.primary}, or valid JSON.');
  }
}

const compositeFields: Readonly<Record<string, readonly string[] | undefined>> = {
  strokeStyle: ['dashArray', 'lineCap'],
  border: ['color', 'width', 'style'],
  transition: ['duration', 'delay', 'timingFunction'],
  shadow: ['color', 'offsetX', 'offsetY', 'blur', 'spread'],
  gradient: ['color', 'position'],
  typography: ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight'],
};

function isAlias(value: JsonValue | undefined): boolean {
  return typeof value === 'string' && alias.test(value) || isJsonObject(value) && typeof value['$ref'] === 'string';
}

function hasFields(value: JsonValue | undefined, fields: readonly string[]): boolean {
  return isAlias(value) || isJsonObject(value) && fields.every((field) => Object.hasOwn(value, field));
}

export function validateInputValue(type: string | undefined, value: JsonValue | undefined) {
  if (!type || isAlias(value)) return;
  const fields = Object.hasOwn(compositeFields, type) ? compositeFields[type] : undefined;
  const valid = type === 'number' ? typeof value === 'number' :
    type === 'dimension' || type === 'duration' ? isDimension(value) :
    type === 'fontFamily' ? typeof value === 'string' || Array.isArray(value) && value.every((name) => typeof name === 'string') :
    type === 'fontWeight' ? typeof value === 'string' || typeof value === 'number' :
    type === 'color' ? isJsonObject(value) && typeof value['colorSpace'] === 'string' && Array.isArray(value['components']) :
    type === 'cubicBezier' ? Array.isArray(value) && value.length === 4 && value.every((part) => typeof part === 'number') :
    !fields || (type === 'strokeStyle' && typeof value === 'string') ||
      (type === 'gradient' || type === 'shadow' && Array.isArray(value)
        ? Array.isArray(value) && value.every((part) => hasFields(part, fields)) : hasFields(value, fields));
  if (!valid) throw new Error('Enter a value that matches the ' + type + ' type.');
}
