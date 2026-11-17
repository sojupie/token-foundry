import { isJsonObject } from './json.ts';
import type { JsonObject } from './json.ts';
import { dtcgTypes } from './token-types.ts';

export interface DocumentDiagnostic {
  file: string;
  path: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
  target: { kind: 'token' | 'group' | 'source'; path: string };
  offset?: number;
  sourcePath?: readonly string[];
}

export function diagnosticKey({ file, path, field, message }: DocumentDiagnostic): string {
  return JSON.stringify([file, path, field, message]);
}

const metadata = new Set(['$type', '$description', '$deprecated', '$extensions', '$ref']);

export function metadataDiagnostics(node: JsonObject, kind: 'token' | 'group', root: boolean) {
  const issues: Pick<DocumentDiagnostic, 'field' | 'message' | 'severity'>[] = [];
  for (const [field, value] of Object.entries(node)) {
    if (!field.startsWith('$')) continue;
    const allowed = metadata.has(field) || (kind === 'token' ? field === '$value' : field === '$root' || field === '$extends') ||
      root && field === '$schema';
    if (!allowed) {
      const misplaced = ['$value', '$root', '$extends', '$schema'].includes(field);
      issues.push({ field, severity: misplaced ? 'error' : 'warning',
        message: misplaced ? 'Property is not allowed here.' : 'Unrecognized reserved property is preserved.' });
      continue;
    }
    const valid = field === '$type' ? dtcgTypes.some(type => type === value) :
      field === '$description' || field === '$ref' || field === '$schema' ? typeof value === 'string' :
      field === '$deprecated' ? typeof value === 'string' || typeof value === 'boolean' :
      field === '$extensions' ? isJsonObject(value) :
      field === '$extends' ? typeof value === 'string' || isJsonObject(value) && typeof value['$ref'] === 'string' : true;
    if (!valid) issues.push({ field, severity: 'error', message: 'Invalid value for ' + field + '.' });
  }
  if (kind === 'token' && Object.hasOwn(node, '$value') && Object.hasOwn(node, '$ref')) {
    issues.push({ field: '$ref', severity: 'error', message: 'A token cannot have both a value and a top-level reference.' });
  }
  return issues;
}
