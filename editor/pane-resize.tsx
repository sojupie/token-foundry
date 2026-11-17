import { useCallback, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';

export const minPaneWidth = 216;
export const maxPaneWidth = 360;

function clampPaneWidth(width: number) {
  return Math.max(minPaneWidth, Math.min(maxPaneWidth, width));
}

export function WorkspacePanes({ hidden, groups, groupsOpen, inspector, inspectorOpen, grid, children }: {
  hidden: boolean;
  groups: ReactNode;
  groupsOpen: boolean;
  inspector: ReactNode;
  inspectorOpen: boolean;
  grid: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const [groupsWidth, setGroupsWidth] = useState(252);
  const [inspectorWidth, setInspectorWidth] = useState(296);
  const style: CSSProperties & { '--groups-width': string; '--inspector-width': string } = {
    '--groups-width': groupsWidth + 'px',
    '--inspector-width': inspectorWidth + 'px',
  };
  return <div className="workspace-body md-sheet-host" hidden={hidden} style={style}>
    {groups}
    {groupsOpen && <PaneResize pane="groups" label="Resize groups sidebar" width={groupsWidth} resize={setGroupsWidth} grid={grid} />}
    {children}
    {inspectorOpen && <PaneResize pane="token-inspector" label="Resize token details" width={inspectorWidth}
      resize={setInspectorWidth} direction={-1} grid={grid} />}
    {inspector}
  </div>;
}

function PaneResize({ pane, label, width, resize, grid, direction = 1 }: {
  pane: string;
  label: string;
  width: number;
  resize: (width: number) => void;
  grid: RefObject<HTMLDivElement | null>;
  direction?: 1 | -1;
}) {
  const start = useRef({ x: 0, width: 0 });
  const dragFrame = useRef(0);
  const pendingWidth = useRef(width);
  const measuredTable = useRef<HTMLDivElement | null>(null);
  const unfreezeTable = useCallback(() => {
    cancelAnimationFrame(dragFrame.current);
    dragFrame.current = 0;
    if (!measuredTable.current) return;
    measuredTable.current.style.inlineSize = '';
    measuredTable.current = null;
    grid.current?.removeAttribute('data-pane-resizing');
  }, [grid]);
  const cleanupOnDetach = useCallback((handle: HTMLInputElement | null) =>
    handle ? unfreezeTable : undefined, [unfreezeTable]);
  const setWidth = (next: number) => resize(clampPaneWidth(next));
  const widthAt = (x: number) => clampPaneWidth(start.current.width + direction * (x - start.current.x));
  return <input ref={cleanupOnDetach} type="range" min={minPaneWidth} max={maxPaneWidth} value={width}
    aria-label={label} aria-controls={pane} className="workspace-pane-resize"
    onChange={event => setWidth(event.currentTarget.valueAsNumber)}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      // Drag relative to the current width so grabbing the divider never jumps the pane.
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      start.current = { x: event.clientX, width };
      event.currentTarget.dataset['dragging'] = '';
      const table = grid.current?.querySelector<HTMLDivElement>('[data-slot="table-container"]');
      if (table && grid.current) {
        // Resize the panes live while React Aria's observed table width stays fixed.
        table.style.inlineSize = table.getBoundingClientRect().width + 'px';
        grid.current.setAttribute('data-pane-resizing', '');
        measuredTable.current = table;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        pendingWidth.current = widthAt(event.clientX);
        if (!dragFrame.current) dragFrame.current = requestAnimationFrame(() => {
          dragFrame.current = 0;
          resize(pendingWidth.current);
        });
      }
    }}
    onPointerUp={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(widthAt(event.clientX));
    }}
    onLostPointerCapture={event => {
      delete event.currentTarget.dataset['dragging'];
      unfreezeTable();
    }}
    onKeyDown={event => {
      switch (event.key) {
        case 'ArrowLeft': setWidth(width - direction * 16); break;
        case 'ArrowRight': setWidth(width + direction * 16); break;
        case 'Home': setWidth(minPaneWidth); break;
        case 'End': setWidth(maxPaneWidth); break;
        default: return;
      }
      event.preventDefault();
    }} />;
}
