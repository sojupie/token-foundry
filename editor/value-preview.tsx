import { useState, useSyncExternalStore } from 'react';
import { Button } from '@token-catalog/forge-react';
import { isJsonObject } from '../lib/json.ts';
import type { JsonValue } from '../lib/json.ts';
import { clampGradientPosition, isDimension } from '../lib/token-types.ts';
import { validateTokenValue } from '../lib/validate-token.ts';
import { displayColor } from './lib/color-preview.ts';

export const previewTypes = new Set(['color', 'cubicBezier', 'transition', 'shadow', 'gradient', 'typography']);

const gamutQueries = ['(color-gamut: rec2020)', '(color-gamut: p3)'];
function displayGamut() {
  if (matchMedia('(color-gamut: rec2020)').matches) return 'rec2020';
  return matchMedia('(color-gamut: p3)').matches ? 'p3' : 'srgb';
}

function subscribeGamut(notify: () => void) {
  const lists = gamutQueries.map(query => matchMedia(query));
  for (const list of lists) list.addEventListener('change', notify);
  return () => { for (const list of lists) list.removeEventListener('change', notify); };
}

function cssLength(value: JsonValue | undefined): string {
  return isDimension(value) ? value.value + value.unit : '0';
}

function MotionPreview({ curve, duration = '650ms', delay = '0ms' }: {
  curve: JsonValue | undefined; duration?: string; delay?: string;
}) {
  const [end, setEnd] = useState(false);
  if (!Array.isArray(curve) || !curve.every(coordinate => typeof coordinate === 'number')) return null;
  const easing = 'cubic-bezier(' + curve.join(', ') + ')';
  return <div className="grid min-w-0 gap-1" aria-label="Timing preview">
    <div className="relative h-6 rounded-full bg-muted" aria-hidden="true">
      <span className="absolute inset-y-1 aspect-square rounded-full bg-primary motion-reduce:transition-none"
        style={{ left: end ? 'calc(100% - 1.25rem)' : '0.25rem', transitionProperty: 'left',
          transitionDuration: duration, transitionDelay: delay, transitionTimingFunction: easing }} />
    </div>
    <Button size="xsmall" type="button" variant="text" className="justify-self-start" onClick={() => setEnd(!end)}>Play timing preview</Button>
  </div>;
}

const weights: Readonly<Record<string, number>> = {
  thin: 100, hairline: 100, 'extra-light': 200, 'ultra-light': 200, light: 300, normal: 400, regular: 400, book: 400,
  medium: 500, 'semi-bold': 600, 'demi-bold': 600, bold: 700, 'extra-bold': 800, 'ultra-bold': 800,
  black: 900, heavy: 900, 'extra-black': 950, 'ultra-black': 950,
};
const genericFamilies = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'fangsong']);

export function ValuePreview({ type, value }: { type: string; value: JsonValue | undefined }) {
  const gamut = useSyncExternalStore(subscribeGamut, displayGamut);
  if (validateTokenValue(type, value)) return null;
  if (type === 'color') {
    const preview = displayColor(value, gamut);
    return preview && <div className="grid gap-1" aria-label="Color preview">
      <div className="overflow-hidden rounded-lg border bg-white">
        <div className="h-10" style={{ backgroundColor: preview.css }} />
      </div>
      {preview.fallback && <p className="text-xs text-muted-foreground">{preview.fallback}</p>}
    </div>;
  }
  if (type === 'cubicBezier') return <MotionPreview curve={value} />;
  if (type === 'transition' && isJsonObject(value)) return <MotionPreview curve={value['timingFunction']}
    duration={cssLength(value['duration'])} delay={cssLength(value['delay'])} />;
  if (type === 'shadow') {
    const layers = Array.isArray(value) ? value : [value];
    const css = layers.filter(isJsonObject).map(layer => [
      layer['inset'] === true ? 'inset' : '', cssLength(layer['offsetX']), cssLength(layer['offsetY']),
      cssLength(layer['blur']), cssLength(layer['spread']), displayColor(layer['color'], gamut)?.css ?? 'transparent',
    ].filter(Boolean).join(' ')).join(', ');
    return <div className="grid min-h-24 place-items-center rounded-lg border p-5" aria-label="Shadow preview">
      <div className="h-12 w-24 rounded-lg bg-background" style={{ boxShadow: css }} />
    </div>;
  }
  if (type === 'gradient' && Array.isArray(value)) {
    const stops = value.filter(isJsonObject).map(stop =>
      (displayColor(stop['color'], gamut)?.css ?? 'transparent') + ' ' + clampGradientPosition(Number(stop['position'])) * 100 + '%');
    if (!stops[0]) return null;
    const background = 'linear-gradient(90deg, ' + (stops.length > 1 ? stops.join(', ') : stops[0] + ', ' + stops[0]) + ')';
    return <div className="h-12 rounded-lg border" style={{ background }} aria-label="Gradient preview" />;
  }
  if (type === 'typography' && isJsonObject(value)) {
    const { fontFamily, fontWeight, fontSize, letterSpacing, lineHeight } = value;
    const family = Array.isArray(fontFamily) ? fontFamily : [fontFamily];
    const names = family.filter((name): name is string => typeof name === 'string');
    const style = { fontFamily: names.map(name => genericFamilies.has(name.toLowerCase()) ? name : JSON.stringify(name)).join(', '),
      fontSize: cssLength(fontSize), letterSpacing: cssLength(letterSpacing),
      fontWeight: typeof fontWeight === 'number' ? fontWeight : typeof fontWeight === 'string' ? weights[fontWeight] : undefined,
      lineHeight: typeof lineHeight === 'number' ? lineHeight : undefined };
    return <div className="max-h-48 overflow-auto rounded-lg border p-3" aria-label="Typography preview">
      <p className="wrap-anywhere" style={style}>The quick brown fox jumps over the lazy dog.</p>
    </div>;
  }
  return null;
}
