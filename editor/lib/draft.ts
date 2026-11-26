import type { JsonValue } from '../../lib/json.ts';
import { isJsonValue, isRecord } from '../../lib/json.ts';

export type EditableColumn = 'name' | 'value' | 'type' | 'description';
export type GridColumn = EditableColumn | 'resolved';
export interface CellPosition { path: string; column: GridColumn }

interface Fields { path: string; name: string; type: string | undefined; value: string; description: string }
export type Draft = (Fields & { create: true; groupOnly: boolean; file: string; original?: never; originalDescription?: never }) |
  (Fields & { create: false; column: EditableColumn; mode: 'inline' | 'details' | 'link' | 'inspector';
    groupOnly?: never; file?: never; original: JsonValue; originalDescription: string });

export const isDraft = (value: unknown): value is Draft => isRecord(value) &&
  ['path', 'name', 'value', 'description'].every(key => typeof value[key] === 'string') && (value['type'] === undefined || typeof value['type'] === 'string') &&
  (value['create'] === true ? typeof value['groupOnly'] === 'boolean' && typeof value['file'] === 'string' : value['create'] === false &&
    typeof value['column'] === 'string' && ['name', 'value', 'type', 'description'].includes(value['column']) &&
    typeof value['mode'] === 'string' && ['inline', 'details', 'link', 'inspector'].includes(value['mode']) &&
    isJsonValue(value['original']) && typeof value['originalDescription'] === 'string');
