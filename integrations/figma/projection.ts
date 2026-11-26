import { openWorkspace, reviewProposal } from '../../lib/workspace.ts';
import type { Review, Workspace } from '../../lib/workspace.ts';
import { isJsonObject, requireValue } from '../../lib/json.ts';
import type { JsonValue } from '../../lib/json.ts';
import { isResolverFile } from '../../lib/resolver.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { maximumBytes, sameSourceValue, sourceSnapshot } from './contract.ts';
import type { FigmaBundle, FigmaValue, TokenProposal, VariableRow } from './contract.ts';
import { cubicFromPoints } from './easing.ts';

export async function sourceRevision(files: FigmaBundle['files']): Promise<string> {
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Source file paths must be unique before computing a revision.');
  const bytes = new TextEncoder().encode(JSON.stringify(files.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  return [...sha256(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function project(type: string, value: JsonValue): { type: VariableRow['type']; value: FigmaValue; unit?: string } | undefined {
  if (type === 'color' && isJsonObject(value) && value['colorSpace'] === 'srgb') {
    const components = value['components'];
    if (Array.isArray(components) && components.length === 3 && components.every(c => typeof c === 'number' && c >= 0 && c <= 1)) {
      const [r, g, b] = components;
      const a = value['alpha'] ?? 1;
      if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number' && typeof a === 'number' && a >= 0 && a <= 1) return { type: 'COLOR', value: { r, g, b, a } };
    }
  }
  if (['number', 'fontWeight'].includes(type) && typeof value === 'number' && Number.isFinite(value)) return { type: 'FLOAT', value };
  if (type === 'dimension' && isJsonObject(value) && typeof value['value'] === 'number' && Number.isFinite(value['value']) &&
    typeof value['unit'] === 'string' && ['px', 'dp', 'sp'].includes(value['unit'])) return { type: 'FLOAT', value: value['value'], unit: value['unit'] };
  if (type === 'duration' && isJsonObject(value) && typeof value['value'] === 'number' && Number.isFinite(value['value']) && value['value'] >= 0 &&
    typeof value['unit'] === 'string' && ['ms', 's'].includes(value['unit'])) return { type: 'TIMING', value: value['value'], unit: value['unit'] };
  if (type === 'fontFamily' && typeof value === 'string') return { type: 'STRING', value };
  if (type === 'cubicBezier') { const curve = cubicFromPoints(value); if (curve) return { type: 'EASING', value: curve }; }
  // Other units, color spaces and composites stay in the source snapshot. No lossy conversion.
  return undefined;
}

export async function figmaBundle(workspace: Workspace): Promise<FigmaBundle> {
  if (workspace.files.some(file => file.parseIssue)) throw new Error('Fix source parsing errors before connecting Figma.');
  if (workspace.files.some(isResolverFile)) throw new Error('Resolver contexts need explicit Figma mode mappings. Export editable sources instead; contexts will not be flattened.');
  const files = workspace.files.map(({ path, text }) => ({ path, text }));
  if (new TextEncoder().encode(JSON.stringify(files)).length > maximumBytes) throw new Error('The token workspace exceeds the Figma sync size limit.');
  const variables: VariableRow[] = [];
  const unsupported: FigmaBundle['unsupported'] = [];
  const names = new Set<string>();
  for (const [path, token] of workspace.graph.tokens) {
    const resolved = workspace.graph.resolved.get(path);
    const reason = workspace.graph.issues.get(path) ?? workspace.graph.validation.get(path)?.join('; ');
    const projected = token.type && resolved !== undefined && !reason ? project(token.type, resolved) : undefined;
    if (!projected) {
      unsupported.push({ path, reason: reason || 'Preserved in source. The plugin does not yet project ' + (token.type ?? 'this type') + ' into editable Figma values.' });
      continue;
    }
    const name = path.split('.').map(part => part === '$root' ? 'root-value' : part).join('/');
    if (names.has(name)) throw new Error('Figma variable name collision: ' + name);
    names.add(name);
    const alias = typeof token.value === 'string' ? /^\{([^{}]+)\}$/u.exec(token.value)?.[1] : undefined;
    const direct = token.node.$ref === undefined && !token.inheritedFrom && !token.overrides;
    variables.push({ path, name, file: token.file, description: token.node.$description ?? '', sourceType: token.type ?? '',
      before: token.value, ...projected, ...(alias ? { alias } : {}), editable: direct });
  }
  const byPath = new Map(variables.map(row => [row.path, row]));
  for (const row of variables) {
    if (row.alias && byPath.get(row.alias)?.type !== row.type) throw new Error('Figma cannot preserve the alias ' + row.path + ' → ' + row.alias + '.');
    if (typeof row.before === 'object' && row.before !== null && '$ref' in row.before) row.editable = false;
  }
  return { format: 'token-foundry/figma', version: 1, name: workspace.name, revision: await sourceRevision(files), files, variables, unsupported };
}

export async function readBundle(text: string): Promise<FigmaBundle> {
  if (new TextEncoder().encode(text).length > maximumBytes * 2) throw new Error('The Figma snapshot is too large.');
  const value: unknown = JSON.parse(text);
  if (!sourceSnapshot(value)) throw new Error('Choose a Foundry Figma snapshot with original source files.');
  // Never trust the flattened projection in an imported bundle. Derive it from the original sources.
  return figmaBundle(openWorkspace(value.name, value.files));
}

export function proposalReview(workspace: Workspace, bundle: FigmaBundle, proposal: TokenProposal): Review {
  if (proposal.schemaVersion !== 1 || proposal.sourceRevision !== bundle.revision || !proposal.changes.length) {
    throw new Error('The Figma changes belong to a different source revision. Pull the matching snapshot before syncing.');
  }
  const rows = new Map(bundle.variables.map(row => [row.path, row]));
  for (const change of proposal.changes) {
    const row = requireValue(rows.get(change.path), 'Figma token ' + change.path);
    if (!row.editable || !sameSourceValue(row.before, change.before)) throw new Error('The source mapping changed for ' + change.path + '.');
  }
  return reviewProposal(workspace, JSON.stringify(proposal));
}
