import type { JsonValue } from '../../lib/json.ts';

interface Fields { path: string; type: string | undefined; value: string; description: string }
export type Draft = (Fields & { create: true; groupOnly: boolean; name: string; file: string; original?: never; originalDescription?: never }) |
  (Fields & { create: false; groupOnly?: never; name?: never; file?: never; original: JsonValue; originalDescription: string });
