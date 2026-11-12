import type { JsonValue } from '../../lib/json.ts';

export type EditableColumn = 'name' | 'value' | 'type' | 'description';
export type GridColumn = EditableColumn | 'resolved';
export interface CellPosition { path: string; column: GridColumn }

interface Fields { path: string; name: string; type: string | undefined; value: string; description: string }
export type Draft = (Fields & { create: true; groupOnly: boolean; file: string; original?: never; originalDescription?: never }) |
  (Fields & { create: false; column: EditableColumn; mode: 'inline' | 'details' | 'link';
    groupOnly?: never; file?: never; original: JsonValue; originalDescription: string });
