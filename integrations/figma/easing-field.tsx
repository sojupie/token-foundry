import { useRef } from 'react';
import { Button, TextField } from '@token-catalog/forge-react';
import type { FigmaValue } from './contract.ts';
import { isUnknownArray } from '../../lib/json.ts';
import { easingPoints, isCubicEasing, parseEasingInput, pointNames } from './easing.ts';
import './easing-field.css';
const x = (point: number) => 16 + point * 160;

// Text is stored separately from parsed points so an unfinished coordinate
// survives closing the plugin, source updates and conflict review.
export function EasingField({ value, onChange, source, disabled = false, invalid = false, describedBy }: {
  value: string; onChange: (text: string) => void; source?: FigmaValue; disabled?: boolean; invalid?: boolean; describedBy?: string | undefined;
}) {
  const sample = useRef<HTMLSpanElement>(null);
  let fields: (string | number)[] | undefined;
  try { const parsed: unknown = JSON.parse(value); if (isUnknownArray(parsed) && parsed.length === 4 && parsed.every(point => typeof point === 'string' || typeof point === 'number')) fields = parsed; } catch { /* Retain legacy or incomplete raw input below. */ }
  if (!value) fields = ['', '', '', ''];
  let curve: ReturnType<typeof parseEasingInput> | undefined;
  try { curve = parseEasingInput(value); } catch { /* Invalid input remains editable without a misleading preview. */ }
  const points = curve ? easingPoints(curve) : undefined;
  const previewY = points ? [0, 1, points[1], points[3]] : [0, 1];
  const scale = Math.max(...previewY.map(Math.abs));
  const low = Math.min(...previewY.map(point => point / scale)), high = Math.max(...previewY.map(point => point / scale));
  const y = (point: number) => 112 - (point / scale - low) / (high - low) * 96;
  const withinPreviewRange = points?.every(point => Number.isFinite(Math.fround(point))) ?? false;
  return <fieldset className="easing-field" disabled={disabled} aria-describedby={describedBy}>
    <legend className="copy-emphasis copy-body">Cubic Bézier</legend>
    {fields ? <div className="easing-points">{pointNames.map((name, index) => <TextField key={name} label={name.toUpperCase()} inputMode="decimal" invalid={invalid}
      value={String(fields[index] ?? '')} onChange={event => onChange(JSON.stringify(fields.map((point, offset) => offset === index ? event.target.value : point)))} />)}</div>
      : <TextField label="Retained curve input" value={value} invalid={invalid} onChange={event => onChange(event.target.value)} />}
    <p className="copy-small tone-supporting">X1 and X2 range from 0 to 1. Y values can overshoot.</p>
    {points && <div className="easing-preview"><figure aria-label="Cubic Bézier curve preview"><svg viewBox="0 0 192 128" aria-hidden="true">
      <path className="easing-guide" d={`M${x(0)},${y(0)} L${x(1)},${y(1)}`} />
      <path className="easing-handle" d={`M${x(0)},${y(0)} L${x(points[0])},${y(points[1])} M${x(1)},${y(1)} L${x(points[2])},${y(points[3])}`} />
      <path className="easing-curve" d={`M${x(0)},${y(0)} C${x(points[0])},${y(points[1])} ${x(points[2])},${y(points[3])} ${x(1)},${y(1)}`} />
    </svg></figure><div className="easing-playback"><div className="easing-track"><span ref={sample} /></div><Button variant="text" size="small" disabled={!withinPreviewRange} onClick={() => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      sample.current?.getAnimations().forEach(animation => animation.cancel());
      sample.current?.animate([{ left: '0%' }, { left: '100%' }], { duration: 1000, easing: 'cubic-bezier(' + points.join(',') + ')' });
    }}>Play curve</Button></div></div>}
    {points && !withinPreviewRange && <p className="copy-small tone-supporting">Control points exceed the preview range.</p>}
    {isCubicEasing(source) && <Button variant="text" onClick={() => onChange(JSON.stringify(easingPoints(source)))}>Use source control points</Button>}
  </fieldset>;
}
