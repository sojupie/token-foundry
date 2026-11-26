import { isRecord, isUnknownArray } from '../../lib/json.ts';

const kinds = ['EASE_IN', 'EASE_OUT', 'EASE_IN_AND_OUT', 'LINEAR', 'EASE_IN_BACK', 'EASE_OUT_BACK', 'EASE_IN_AND_OUT_BACK',
  'CUSTOM_CUBIC_BEZIER', 'GENTLE', 'QUICK', 'BOUNCY', 'SLOW', 'CUSTOM_SPRING', 'HOLD'] as const;
const knownKinds: ReadonlySet<string> = new Set(kinds);
export const pointNames = ['x1', 'y1', 'x2', 'y2'] as const;
export interface BezierPoints { x1: number; y1: number; x2: number; y2: number }
export interface FigmaEasing {
  type: typeof kinds[number];
  easingFunctionCubicBezier?: BezierPoints;
  easingFunctionSpring?: { bounce: number };
}
export type CubicEasing = FigmaEasing & { type: 'CUSTOM_CUBIC_BEZIER'; easingFunctionCubicBezier: BezierPoints };
const isPoints = (value: unknown): value is BezierPoints => isRecord(value) && pointNames.every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) &&
  typeof value['x1'] === 'number' && value['x1'] >= 0 && value['x1'] <= 1 && typeof value['x2'] === 'number' && value['x2'] >= 0 && value['x2'] <= 1;
export function isFigmaEasing(value: unknown): value is FigmaEasing {
  return isRecord(value) && typeof value['type'] === 'string' && knownKinds.has(value['type']) &&
    (value['type'] !== 'CUSTOM_CUBIC_BEZIER' || isPoints(value['easingFunctionCubicBezier'])) &&
    (value['easingFunctionCubicBezier'] === undefined || isPoints(value['easingFunctionCubicBezier'])) &&
    (value['type'] !== 'CUSTOM_SPRING' || isRecord(value['easingFunctionSpring'])) &&
    (value['easingFunctionSpring'] === undefined || isRecord(value['easingFunctionSpring']) && typeof value['easingFunctionSpring']['bounce'] === 'number' &&
      Number.isFinite(value['easingFunctionSpring']['bounce']) && value['easingFunctionSpring']['bounce'] >= 0 && value['easingFunctionSpring']['bounce'] <= 1);
}
export const isCubicEasing = (value: unknown): value is CubicEasing => isFigmaEasing(value) && value.type === 'CUSTOM_CUBIC_BEZIER' && !!value.easingFunctionCubicBezier;
export function cubicFromPoints(value: unknown): CubicEasing | undefined {
  if (!isUnknownArray(value) || value.length !== 4) return undefined;
  const [x1, y1, x2, y2] = value;
  const points = { x1, y1, x2, y2 };
  return isPoints(points) ? { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: points } : undefined;
}
export const easingPoints = (value: CubicEasing): [number, number, number, number] => {
  const points = value.easingFunctionCubicBezier; return [points.x1, points.y1, points.x2, points.y2];
};
export function parseEasingInput(text: string): CubicEasing {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Enter four control points for the cubic Bézier curve.'); }
  const points = isUnknownArray(value) ? value.map(item => typeof item === 'number' ? item : typeof item === 'string' && item.trim() ? Number(item) : NaN) : undefined;
  const curve = cubicFromPoints(points);
  if (!curve) throw new Error('Enter finite control points. X1 and X2 must be between 0 and 1.');
  return curve;
}
function sourcePoint(current: number, original?: number) {
  if (original !== undefined && (current === original || current === Math.fround(original))) return original;
  if (current === Math.fround(current)) for (let precision = 1; precision <= 17; precision++) {
    const candidate = Number(current.toPrecision(precision)); if (Math.fround(candidate) === current) return candidate;
  }
  return current;
}
export function sourceEasing(value: FigmaEasing, original?: FigmaEasing): FigmaEasing {
  if (!isCubicEasing(value)) return value;
  const before = isCubicEasing(original) ? original.easingFunctionCubicBezier : undefined;
  const points = value.easingFunctionCubicBezier;
  return { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: {
    x1: sourcePoint(points.x1, before?.x1), y1: sourcePoint(points.y1, before?.y1),
    x2: sourcePoint(points.x2, before?.x2), y2: sourcePoint(points.y2, before?.y2),
  } };
}
export function roundedEasing(value: CubicEasing): CubicEasing {
  const points = value.easingFunctionCubicBezier;
  return { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: { x1: Math.fround(points.x1), y1: Math.fround(points.y1), x2: Math.fround(points.x2), y2: Math.fround(points.y2) } };
}
