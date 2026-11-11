import { isJsonObject } from './json.ts';
import type { JsonObject, JsonValue } from './json.ts';

export interface TokenNode extends JsonObject {
  $type?: string;
  $value?: JsonValue;
  $description?: string;
  $ref?: string;
}
export interface TokenChange {
  path: string;
  node: TokenNode;
  create: boolean;
}
export interface TokenFile extends JsonObject { path: string; tree: JsonObject }
export interface Diagnostic { path: string; message: string }
export interface Color extends JsonObject {
  colorSpace: string;
  components: [number, number, number];
  alpha?: number;
  hex?: string;
}
export interface Dimension extends JsonObject { value: number; unit: string }
export interface Typography extends JsonObject {
  fontFamily: string;
  fontSize: Dimension;
  fontWeight: number;
  letterSpacing: Dimension;
  lineHeight: number;
}

export function isTokenNode(value: JsonValue | undefined): value is TokenNode {
  return isJsonObject(value) && (value['$type'] === undefined || typeof value['$type'] === 'string') &&
    (value['$description'] === undefined || typeof value['$description'] === 'string') &&
    (value['$ref'] === undefined || typeof value['$ref'] === 'string');
}

export function isColor(value: JsonValue | undefined): value is Color {
  if (!isJsonObject(value)) return false;
  const { colorSpace, components, alpha, hex } = value;
  return typeof colorSpace === 'string' && Array.isArray(components) && components.length === 3 &&
    components.every((part) => typeof part === 'number' && part >= 0 && part <= 1) &&
    (alpha === undefined || (typeof alpha === 'number' && alpha >= 0 && alpha <= 1)) &&
    (hex === undefined || typeof hex === 'string');
}

export function isDimension(value: JsonValue | undefined): value is Dimension {
  return isJsonObject(value) && typeof value['value'] === 'number' && typeof value['unit'] === 'string';
}

export function isTypography(value: JsonValue | undefined): value is Typography {
  return isJsonObject(value) && typeof value['fontFamily'] === 'string' && isDimension(value['fontSize']) &&
    typeof value['fontWeight'] === 'number' && isDimension(value['letterSpacing']) && typeof value['lineHeight'] === 'number';
}
