import { Link2 } from 'lucide-react';
import { colorHex } from '../lib/color.ts';
import { referenceLabel } from '../lib/document.ts';
import { isColor, isDimension, isTypography } from '../lib/token-types.ts';
import type { JsonValue } from '../lib/json.ts';

export function describeTokenValue(value: JsonValue | undefined): string {
  if (value === undefined) return '—';
  if (isDimension(value)) return value.value + ' ' + value.unit;
  if (isTypography(value)) return describeTokenValue(value.fontSize) + ' · ' + value.fontFamily;
  if (isColor(value) && value.colorSpace === 'srgb') return colorHex(value);
  if (Array.isArray(value)) return value.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join(', ');
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function TokenValue({ value, swatch = false, authored = false, containsReferences = false, wrap = false }: {
  value: JsonValue | undefined; swatch?: boolean; authored?: boolean; containsReferences?: boolean; wrap?: boolean;
}) {
  const reference = authored ? referenceLabel(value) : undefined;
  const text = reference ?? describeTokenValue(value);
  const alpha = isColor(value) ? value.alpha ?? 1 : 1;
  return <span className={'flex min-w-0 items-center gap-1.5 font-mono text-xs ' +
    (reference ? 'font-medium text-primary' : '')} title={containsReferences && !reference ? 'Contains references · ' + text : text}>
    {(reference || containsReferences) && <Link2 size={13} className="shrink-0 text-primary" aria-hidden="true" />}
    {swatch && /^#[0-9A-F]{6}$/iu.test(text) && <span aria-hidden="true" className="size-3.5 shrink-0 rounded-sm border"
      style={{ backgroundColor: text, opacity: alpha }} />}
    <span className={wrap ? 'wrap-anywhere whitespace-pre-wrap' : 'truncate'}>{text}{swatch && alpha < 1 ? ' · ' + Math.round(alpha * 100) + '%' : ''}</span>
  </span>;
}
