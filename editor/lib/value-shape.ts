import { colorSpace } from '../../lib/color.ts';
import { isJsonObject } from '../../lib/json.ts';
import { tokenFieldType } from '../../lib/validate-token.ts';
import type { JsonValue } from '../../lib/json.ts';
import { dtcgTypes } from '../../lib/token-types.ts';

export const shadowFields = [
  ['color', 'Color', 'color'], ['offsetX', 'Horizontal offset', 'dimension'], ['offsetY', 'Vertical offset', 'dimension'],
  ['blur', 'Blur', 'dimension'], ['spread', 'Spread', 'dimension'], ['inset', 'Inset', 'boolean'],
] as const;
export const compositeFields: Readonly<Record<string, readonly (readonly [string, string, string])[]>> = {
  border: [['color', 'Color', 'color'], ['width', 'Width', 'dimension'], ['style', 'Stroke style', 'strokeStyle']],
  transition: [['duration', 'Duration', 'duration'], ['delay', 'Delay', 'duration'], ['timingFunction', 'Timing curve', 'cubicBezier']],
  shadowLayer: shadowFields,
  gradientStop: [['color', 'Color', 'color'], ['position', 'Position', 'number']],
  typography: [['fontFamily', 'Font family', 'fontFamily'], ['fontSize', 'Font size', 'dimension'],
    ['fontWeight', 'Font weight', 'fontWeight'], ['letterSpacing', 'Letter spacing', 'dimension'], ['lineHeight', 'Line height', 'number']],
};

export function defaultValue(type: string): JsonValue {
  switch (type) {
    case 'number': return 0;
    case 'numberOrNone': return 0;
    case 'boolean': return false;
    case 'dimension': return { value: 0, unit: 'px' };
    case 'duration': return { value: 0, unit: 'ms' };
    case 'fontFamily':
    case 'fontName': return 'sans-serif';
    case 'fontWeight': return 400;
    case 'cubicBezier': return [0.2, 0, 0, 1];
    case 'color': return { colorSpace: 'srgb', components: [0, 0, 0] };
    case 'colorComponents': return [0, 0, 0];
    case 'colorSpace': return 'srgb';
    case 'hex': return '#000000';
    case 'dimensionUnit': return 'px';
    case 'durationUnit': return 'ms';
    case 'lineCap': return 'butt';
    case 'strokeStyle': return 'solid';
    case 'dashArray': return [{ value: 2, unit: 'px' }];
    case 'gradient': return [defaultValue('gradientStop'), { color: { colorSpace: 'srgb', components: [1, 1, 1] }, position: 1 }];
    case 'shadow': return defaultValue('shadowLayer');
    default: {
      const members = Object.hasOwn(compositeFields, type) ? compositeFields[type] : undefined;
      return members ? Object.fromEntries(members.filter(([key]) => key !== 'inset').map(([key, , memberType]) =>
        [key, key === 'lineHeight' ? 1.5 : key === 'fontSize' ? { value: 16, unit: 'px' } : defaultValue(memberType)])) : '';
    }
  }
}

export const canEditType = (type: string | undefined): type is typeof dtcgTypes[number] => dtcgTypes.some(known => known === type);


export function tokenDisplayName(path: string) {
  return path.replace(/(^|\.)\$root$/u, '$1Group value');
}

export function valueFieldLabel(parts: readonly string[], value?: JsonValue, type?: string) {
  let parent = value;
  let parentType = type;
  return parts.map((key, index) => {
    if (key === '$value') return 'Value';
    const numeric = /^\d+$/u.test(key);
    const names = parentType === 'cubicBezier' ? ['X1', 'Y1', 'X2', 'Y2'] :
      parts[index - 1] === 'components' && isJsonObject(parent) && typeof parent['colorSpace'] === 'string'
        ? colorSpace(parent['colorSpace'])?.components : undefined;
    const name = numeric ? names?.[Number(key)] ??
      (parentType === 'gradient' ? 'Gradient stop ' : parentType === 'shadow' ? 'Shadow layer ' : 'Item ') + (Number(key) + 1) :
      (parentType ? compositeFields[parentType]?.find(([member]) => member === key)?.[1] : undefined) ??
        key.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/^./u, letter => letter.toUpperCase());
    parentType = tokenFieldType(parentType, [key]);
    // Component names depend on the containing color space.
    if (key !== 'components') parent = Array.isArray(parent) ? parent[Number(key)] : isJsonObject(parent) ? parent[key] : undefined;
    return name;
  }).join(' › ');
}


export function valueFieldEditorType(type: string | undefined, parts: readonly string[]) {
  const parent = tokenFieldType(type, parts.slice(0, -1));
  const field = parts.at(-1);
  if (parent === 'color' && (field === 'hex' || field === 'colorSpace')) return field;
  if (parent === 'dimension' && field === 'unit') return 'dimensionUnit';
  if (parent === 'duration' && field === 'unit') return 'durationUnit';
  if (parent === 'strokeStyle' && field === 'lineCap') return 'lineCap';
  if (parent === 'fontFamily' && field && /^[0-9]+$/u.test(field)) return 'fontName';
  return tokenFieldType(type, parts);
}
