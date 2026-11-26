import type { VariableRow } from './contract.ts';

export type TokenVariableScope =
  | 'ALL_FILLS'
  | 'STROKE_COLOR'
  | 'FONT_FAMILY'
  | 'FONT_WEIGHT'
  | 'OPACITY'
  | 'LINE_HEIGHT'
  | 'FONT_SIZE'
  | 'LETTER_SPACING'
  | 'CORNER_RADIUS'
  | 'GAP'
  | 'WIDTH_HEIGHT'
  | 'STROKE_FLOAT';

const coreShapes = /^sys\.shape\.corner\.(?:none|extra-small|small|medium|large|extra-large|full)\.(?:topLeft|topRight|bottomLeft|bottomRight)$/u;
const v1CompPrefixes = [
  'comp.plain-tooltip.',
  'comp.rich-tooltip.',
  'comp.button.small.',
  'comp.button.filled.',
  'comp.button.tonal.',
  'comp.button.outlined.',
  'comp.button.text.',
  'comp.button.elevated.',
  'comp.outlined-text-field.',
  'comp.filled-card.',
  'comp.outlined-card.',
  'comp.elevated-card.',
  'comp.dialog.',
  'comp.menu.',
  'comp.list.',
  'comp.snackbar.',
  'comp.badge.',
  'comp.primary-navigation-tab.',
  'comp.secondary-navigation-tab.',
  'comp.filter-chip.',
  'comp.input-chip.',
  'comp.checkbox.',
  'comp.radio-button.',
  'comp.switch.',
  'comp.divider.',
];

export function isCuratedFigmaVariable(path: string): boolean {
  if (/^(?:[^.]+\.)?ref\./u.test(path)) return false;
  if (!path.startsWith('sevan.')) return true;
  const rel = path.slice('sevan.'.length);
  if (rel.startsWith('sys.color.')) {
    return !/(?:-fixed(?:-dim|-variant)?|^sys\.color\.surface-tint(?:-color)?)$/u.test(rel);
  }
  if (rel.startsWith('sys.shape.')) return coreShapes.test(rel) || /^sys\.shape\.corner\.(?:none|full)(?:\.\$root)?$/u.test(rel);
  if (rel.startsWith('sys.typescale.')) return !rel.includes('emphasized');
  if (rel.startsWith('comp.')) {
    if (!v1CompPrefixes.some(prefix => rel.startsWith(prefix))) return false;
    if (/(?:\.dragged\.|\.motion\.|\.spring\.|\.pressed\.(?:shape|container\.corner))/u.test(rel)) return false;
    if (rel.startsWith('comp.button.') && /(?:\.toggle\.|\.(?:un)?selected\.)/u.test(rel)) return false;
    return true;
  }
  return true;
}

export function variableScopes(row: Pick<VariableRow, 'path' | 'type' | 'sourceType'>): TokenVariableScope[] {
  if (!isCuratedFigmaVariable(row.path)) return [];
  if (row.type === 'COLOR') return ['ALL_FILLS', 'STROKE_COLOR'];
  if (row.type === 'STRING') return ['FONT_FAMILY'];
  if (row.type === 'BOOLEAN') return [];
  if (row.type === 'TIMING') return [];
  if (row.sourceType === 'fontWeight') return ['FONT_WEIGHT'];
  if (/(?:^|[.-])opacity(?:\.\$root)?$/u.test(row.path)) return ['OPACITY'];
  if (/line-height/u.test(row.path)) return ['LINE_HEIGHT'];
  if (/font-size|typescale\..+\.size(?:\.\$root)?$|(?:label-text|headline|supporting-text|input-text)\.size(?:\.\$root)?$/u.test(row.path)) return ['FONT_SIZE'];
  if (/tracking|letter-spacing/u.test(row.path)) return ['LETTER_SPACING'];
  if ((/(?:^|\.)shape(?:\.|$)/u.test(row.path) || /corner|radius/u.test(row.path)) && !row.path.endsWith('radius-ratio')) return ['CORNER_RADIUS'];
  if (/outline\.width|border\.width|thickness|stroke/u.test(row.path)) return ['STROKE_FLOAT', 'WIDTH_HEIGHT'];
  if (/spacing|space|gap|padding|margin|inset/u.test(row.path)) return ['GAP', 'WIDTH_HEIGHT'];
  return ['WIDTH_HEIGHT'];
}
