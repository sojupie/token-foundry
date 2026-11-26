import { isJsonValue, isRecord } from '../../lib/json.ts';
import type { JsonValue } from '../../lib/json.ts';

export type SelectionEdit = 'rename' | 'value' | 'type' | 'description';
export interface BulkDraft {
  field: string; replaceLinks: boolean; value: JsonValue | undefined; type: string; description: string;
  renameMode: string; find: string; name: string; regex: boolean; raw: string | undefined;
}
export const newBulkDraft = (): BulkDraft => ({ field: '', replaceLinks: false, value: undefined, type: '', description: '', renameMode: 'replace', find: '', name: '', regex: false, raw: undefined });
export const isBulkDraft = (value: unknown): value is BulkDraft => isRecord(value) &&
  ['field', 'type', 'description', 'renameMode', 'find', 'name'].every(key => typeof value[key] === 'string') &&
  typeof value['replaceLinks'] === 'boolean' && typeof value['regex'] === 'boolean' &&
  (value['value'] === undefined || isJsonValue(value['value'])) && (value['raw'] === undefined || typeof value['raw'] === 'string');
