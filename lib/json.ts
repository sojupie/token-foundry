export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue | undefined }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isRecord(value);
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (isUnknownArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function parseJson(text: string): JsonValue {
  const value: unknown = JSON.parse(text);
  if (!isJsonValue(value)) throw new Error('Expected finite JSON data.');
  return value;
}

export function requireObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error('Expected an object for ' + label + '.');
  return value;
}

export function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error('Missing ' + label + '.');
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.';
}
