import { colorSpace } from './color.ts';
import { isJsonObject } from './json.ts';
import { dtcgTypes } from './token-types.ts';
import type { JsonObject, JsonValue } from './json.ts';

const fontWeights = new Set([
  'thin', 'hairline', 'extra-light', 'ultra-light', 'light', 'normal', 'regular', 'book', 'medium',
  'semi-bold', 'demi-bold', 'bold', 'extra-bold', 'ultra-bold', 'black', 'heavy', 'extra-black', 'ultra-black',
]);
const strokeStyles = new Set(['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'outset', 'inset']);
const lineCaps = new Set(['round', 'butt', 'square']);
const fields: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  border: { color: 'color', width: 'dimension', style: 'strokeStyle' },
  transition: { duration: 'duration', delay: 'duration', timingFunction: 'cubicBezier' },
  shadow: { color: 'color', offsetX: 'dimension', offsetY: 'dimension', blur: 'dimension', spread: 'dimension' },
  gradientStop: { color: 'color', position: 'number' },
  typography: { fontFamily: 'fontFamily', fontSize: 'dimension', fontWeight: 'fontWeight', letterSpacing: 'dimension', lineHeight: 'number' },
};

export function tokenFieldType(type: string | undefined, parts: readonly string[]): string | undefined {
  for (const part of parts) {
    const index = /^(0|[1-9][0-9]*)$/u.test(part);
    switch (type) {
      case undefined: return undefined;
      case 'color':
        type = part === 'components' ? 'colorComponents' : part === 'alpha' ? 'number' :
          part === 'colorSpace' || part === 'hex' ? 'string' : undefined;
        break;
      case 'dimension':
      case 'duration':
        type = part === 'value' ? 'number' : part === 'unit' ? 'string' : undefined;
        break;
      case 'fontFamily': type = index ? 'fontFamily' : undefined; break;
      case 'colorComponents':
      case 'cubicBezier': type = index ? 'number' : undefined; break;
      case 'strokeStyle': type = part === 'dashArray' ? 'dashArray' : part === 'lineCap' ? 'string' : undefined; break;
      case 'dashArray': type = index ? 'dimension' : undefined; break;
      case 'gradient': type = index ? 'gradientStop' : undefined; break;
      case 'shadow':
        type = index ? 'shadowLayer' : part === 'inset' ? 'boolean' : fields['shadow']?.[part];
        break;
      case 'shadowLayer':
        type = part === 'inset' ? 'boolean' : fields['shadow']?.[part];
        break;
      default: type = type && Object.hasOwn(fields, type) ? fields[type]?.[part] : undefined;
    }
  }
  return type;
}

const isNumber = (value: JsonValue | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const inRange = (value: JsonValue | undefined, min: number, max: number) => isNumber(value) && value >= min && value <= max;

function isReferenceValue(candidate: JsonValue | undefined): candidate is `{${string}}` | (JsonObject & { $ref: string }) {
  return typeof candidate === 'string' && /^\{[^{}]+\}$/u.test(candidate) ||
    isJsonObject(candidate) && typeof candidate['$ref'] === 'string';
}

export function validateTokenValue(type: string | undefined, value: JsonValue | undefined, allowReferences = false): string | undefined {
  return tokenValueIssues(type, value, allowReferences).next().value ?? undefined;
}

export function* tokenValueIssues(type: string | undefined, value: JsonValue | undefined, allowReferences = false,
  referenceType?: (candidate: JsonValue, field: string) => string | undefined): Generator<string, void> {
  function* check(expected: string | undefined, candidate: JsonValue | undefined, path: string): Generator<string, void> {
    const invalid = (message: string) => path + ' · ' + message;
    if (allowReferences && isReferenceValue(candidate)) {
      const actual = referenceType?.(candidate, path);
      const targetType = expected === 'shadowLayer' ? 'shadow' : expected === 'gradientStop' ? 'gradient' : expected;
      if (actual && targetType && targetType !== actual && expected !== actual) yield invalid('Expected a ' + targetType + ' reference, found ' + actual + '.');
      return;
    }
    switch (expected) {
      case undefined:
        yield invalid('Declare a type or inherit one from a group or reference.');
        return;
      case 'number':
        if (!isNumber(candidate)) yield invalid('Expected a finite number.');
        return;
      case 'dimension':
      case 'duration': {
        if (!isJsonObject(candidate)) {
          yield invalid('Expected an object with value and unit.');
          return;
        }
        yield* check('number', candidate['value'], path + '/value');
        const unit = candidate['unit'];
        if (allowReferences && isReferenceValue(unit)) {
          yield* check('string', unit, path + '/unit');
          return;
        }
        const units = expected === 'dimension' ? ['px', 'rem', 'dp', 'sp'] : ['ms', 's'];
        if (typeof unit !== 'string' || !units.includes(unit)) yield path + '/unit · Use ' + (expected === 'dimension' ? 'px, rem, dp or sp' : units.join(' or ')) + '.';
        return;
      }
      case 'fontFamily':
        if (Array.isArray(candidate)) {
          for (const [index, name] of candidate.entries()) {
            if (allowReferences && isReferenceValue(name)) yield* check('fontFamily', name, path + '/' + index);
            else if (typeof name !== 'string') yield path + '/' + index + ' · Expected a font name.';
          }
        } else if (typeof candidate !== 'string') yield invalid('Expected a font name or an array of font names.');
        return;
      case 'fontWeight':
        if (!(inRange(candidate, 1, 1000) || typeof candidate === 'string' && fontWeights.has(candidate))) {
          yield invalid('Use a weight from 1 to 1000 or a DTCG weight name.');
        }
        return;
      case 'cubicBezier': {
        if (!Array.isArray(candidate) || candidate.length !== 4) {
          yield invalid('Expected four Bézier coordinates.');
          return;
        }
        for (const [index, item] of candidate.entries()) {
          if (allowReferences && isReferenceValue(item)) {
            yield* check('number', item, path + '/' + index);
            continue;
          }
          if (!(index % 2 === 0 ? inRange(item, 0, 1) : isNumber(item))) {
            yield path + '/' + index + ' · ' + (index % 2 === 0 ? 'Use a coordinate from 0 to 1.' : 'Expected a finite number.');
          }
        }
        return;
      }
      case 'color':
        yield* validateColor(candidate, path, allowReferences, check);
        return;
      case 'strokeStyle': {
        if (typeof candidate === 'string' && strokeStyles.has(candidate)) return;
        if (!isJsonObject(candidate)) {
          yield invalid('Expected a DTCG stroke keyword or dash pattern.');
          return;
        }
        const dash = candidate['dashArray'];
        if (Array.isArray(dash)) {
          for (const [index, item] of dash.entries()) yield* check('dimension', item, path + '/dashArray/' + index);
        } else if (allowReferences && isReferenceValue(dash)) {
          yield* check('dashArray', dash, path + '/dashArray');
        } else {
          yield path + '/dashArray · Expected an array of dimensions.';
        }
        const cap = candidate['lineCap'];
        if (allowReferences && isReferenceValue(cap)) yield* check('string', cap, path + '/lineCap');
        else if (!(typeof cap === 'string' && lineCaps.has(cap))) {
          yield path + '/lineCap · Use round, butt, or square.';
        }
        for (const key of Object.keys(candidate)) {
          if (key !== 'dashArray' && key !== 'lineCap') yield path + '/' + key + ' · Unexpected field.';
        }
        return;
      }
      case 'gradient':
      case 'shadow': {
        if (Array.isArray(candidate)) {
          for (const [index, item] of candidate.entries()) {
            yield* check(expected === 'gradient' ? 'gradientStop' : 'shadowLayer', item, path + '/' + index);
          }
          return;
        }
        if (expected === 'gradient') {
          yield invalid('Expected an array of gradient stops.');
          return;
        }
        break;
      }
    }
    const name = expected === 'shadowLayer' ? 'shadow' : expected;
    const shape = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (!shape || !isJsonObject(candidate)) {
      yield invalid('Expected a ' + expected + ' object.');
      return;
    }
    for (const [key, fieldType] of Object.entries(shape)) yield* check(fieldType, candidate[key], path + '/' + key);
    const shadow = expected === 'shadow' || expected === 'shadowLayer';
    const inset = candidate['inset'];
    if (shadow && inset !== undefined) {
      if (allowReferences && isReferenceValue(inset)) yield* check('boolean', inset, path + '/inset');
      else if (typeof inset !== 'boolean') yield path + '/inset · Expected a boolean.';
    }
    for (const key of Object.keys(candidate)) {
      if (!Object.hasOwn(shape, key) && !(shadow && key === 'inset')) yield path + '/' + key + ' · Unexpected field.';
    }
  }
  if (type !== undefined && !dtcgTypes.some(known => known === type)) {
    yield '$type · Unsupported token type ' + type + '.';
    return;
  }
  yield* check(type, value, '$value');
}

function* validateColor(value: JsonValue | undefined, path: string, allowReferences: boolean,
  check: (type: string, value: JsonValue, path: string) => Generator<string, void>): Generator<string, void> {
  if (!isJsonObject(value)) {
    yield path + ' · Expected a color object.';
    return;
  }
  const space = value['colorSpace'];
  const components = value['components'];
  const alpha = value['alpha'];
  const hex = value['hex'];
  const ranges = colorSpace(typeof space === 'string' ? space : undefined)?.ranges;
  if (allowReferences && isReferenceValue(space)) yield* check('string', space, path + '/colorSpace');
  else if (!ranges) yield path + '/colorSpace · Use a supported DTCG color space.';
  if (!Array.isArray(components) || components.length !== 3) {
    if (allowReferences && isReferenceValue(components)) yield* check('colorComponents', components, path + '/components');
    else yield path + '/components · Expected three components.';
  } else {
    for (const [index, item] of components.entries()) {
      if (item === 'none') continue;
      if (allowReferences && isReferenceValue(item)) {
        yield* check('number', item, path + '/components/' + index);
        continue;
      }
      const range = ranges?.[index];
      if (!isNumber(item) || range && (!inRange(item, range[0] ?? 0, range[1] ?? Infinity) || range[1] === 360 && item === 360)) {
        yield path + '/components/' + index + ' · Component is outside the range for ' + (typeof space === "string" ? space : "the selected color space") + '.';
      }
    }
  }
  if (allowReferences && isReferenceValue(alpha)) yield* check('number', alpha, path + '/alpha');
  else if (alpha !== undefined && !inRange(alpha, 0, 1)) yield path + '/alpha · Use opacity from 0 to 1.';
  if (allowReferences && isReferenceValue(hex)) yield* check('string', hex, path + '/hex');
  else if (hex !== undefined && (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/iu.test(hex))) {
    yield path + '/hex · Use six hex digits, such as #336699.';
  }
}
