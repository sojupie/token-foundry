import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent, RefObject } from 'react';
import type { GridColumn } from './lib/draft.ts';

const desktopMinimum: Record<GridColumn, number> = { name: 144, value: 144, resolved: 120, type: 80, description: 112 };
const weight: Record<GridColumn, number> = { name: 3, value: 2.5, resolved: 1.5, type: 0, description: 2 };
const checkboxWidth = 42;

function minimumWidth(columns: readonly GridColumn[], column: GridColumn) {
  return columns.length === 2 ? 96 : desktopMinimum[column];
}

function measure(columns: readonly GridColumn[], width: number, preferences: Partial<Record<GridColumn, number>>) {
  const flexible = columns.filter(column => column !== 'type');
  const fixed = columns.includes('type') ? preferences.type ?? 100 : 0;
  const base = checkboxWidth + fixed + flexible.reduce((sum, key) => sum + minimumWidth(columns, key), 0);
  const free = Math.max(0, width - base);
  const share = flexible.reduce((sum, key) => sum + (preferences[key] ?? weight[key]), 0);
  return columns.map(key => key === 'type' ? fixed : minimumWidth(columns, key) + (preferences[key] ?? weight[key]) * free / share);
}

export function useGridWidths(columns: readonly GridColumn[], container: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);
  const [preferences, setPreferences] = useState<Partial<Record<GridColumn, number>>>({});
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [container]);

  const widths = measure(columns, width, preferences);
  function resize(index: number, requested: number, initial: readonly number[] = widths) {
    const column = columns[index];
    if (!column) return;
    const actual = initial[index] ?? 0;
    const takeFrom = columns.flatMap((key, offset) => offset !== index && key !== 'type' ? [offset] : []);
    const others = takeFrom.reduce((sum, offset) => {
      const key = columns[offset];
      return sum + (key ? (initial[offset] ?? 0) - minimumWidth(columns, key) : 0);
    }, 0);
    const delta = Math.max(minimumWidth(columns, column) - actual, Math.min(requested - actual, others));
    const next = { ...preferences };
    if (column === 'type') next.type = actual + delta;
    else next[column] = Math.max(0.001, actual + delta - minimumWidth(columns, column));
    for (const offset of takeFrom) {
      const key = columns[offset];
      if (!key) continue;
      const spare = (initial[offset] ?? 0) - minimumWidth(columns, key);
      next[key] = Math.max(0.001, spare - delta * (others > 0 ? spare / others : 1 / takeFrom.length));
    }
    setPreferences(next);
  }
  return { widths, resize, checkboxWidth };
}

export function GridColumnResizer({ label, index, column, columns, widths, resize }: {
  label: string; index: number; column: GridColumn; columns: readonly GridColumn[]; widths: readonly number[];
  resize: (index: number, requested: number, initial?: readonly number[]) => void;
}) {
  const [resizing, setResizing] = useState(false);
  const initial = useRef<{ point: number; direction: number; widths: readonly number[] } | null>(null);
  const width = widths[index] ?? 0;
  const max = widths.reduce((sum, value) => sum + value, 0);
  function finish(event: PointerEvent<HTMLInputElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    initial.current = null;
    setResizing(false);
  }

  return <input type="range" tabIndex={-1} aria-label={'Resize ' + label + ' column'}
    min={minimumWidth(columns, column)} max={Math.round(max)} value={Math.round(width)}
    onChange={event => resize(index, event.currentTarget.valueAsNumber)}
    className="column-resizer" data-resizing={resizing ? '' : undefined}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      const direction = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1;
      initial.current = { point: event.clientX, direction, widths };
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizing(true);
    }}
    onPointerMove={event => {
      const drag = initial.current;
      if (drag) resize(index, (drag.widths[index] ?? 0) + (event.clientX - drag.point) * drag.direction, drag.widths);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { initial.current = null; setResizing(false); }}
    onKeyDown={event => {
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        setResizing(previous => event.key === 'Enter' && !previous);
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
      const step = (event.key === 'ArrowRight') !== rtl ? 8 : -8;
      resize(index, event.key === 'Home' ? minimumWidth(columns, column) : event.key === 'End' ? max : width + step);
    }} />;
}
