import type { GridColumn } from './draft.ts';

type Listener = () => void;

interface Selection {
  selected: string;
  activeColumn: GridColumn;
  checked: Set<string>;
}

export function createGridSelection() {
  let selection: Selection = { selected: '', activeColumn: 'name', checked: new Set() };
  const listeners = new Set<Listener>();
  const rowListeners = new Map<string, Set<Listener>>();
  const checkedListeners = new Set<Listener>();

  function publish(next: Selection) {
    const previous = selection;
    if (next.selected === previous.selected && next.activeColumn === previous.activeColumn && next.checked === previous.checked) return;
    selection = next;
    const changedRows = new Set<string>();
    if (next.selected !== previous.selected || next.activeColumn !== previous.activeColumn) {
      changedRows.add(previous.selected);
      changedRows.add(next.selected);
    }
    if (next.checked !== previous.checked) {
      for (const path of previous.checked) if (!next.checked.has(path)) changedRows.add(path);
      for (const path of next.checked) if (!previous.checked.has(path)) changedRows.add(path);
      for (const notify of checkedListeners) notify();
    }
    for (const path of changedRows) for (const notify of rowListeners.get(path) ?? []) notify();
    for (const notify of listeners) notify();
  }

  return {
    getSnapshot: () => selection,
    subscribe(this: void, listener: Listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeRow(this: void, path: string, listener: Listener) {
      const subscribed = rowListeners.get(path) ?? new Set<Listener>();
      subscribed.add(listener);
      rowListeners.set(path, subscribed);
      return () => {
        subscribed.delete(listener);
        if (!subscribed.size) rowListeners.delete(path);
      };
    },
    subscribeChecked(this: void, listener: Listener) {
      checkedListeners.add(listener);
      return () => { checkedListeners.delete(listener); };
    },
    setSelected(this: void, selected: string) {
      publish({ ...selection, selected });
    },
    setActiveColumn(this: void, activeColumn: GridColumn) {
      publish({ ...selection, activeColumn });
    },
    setChecked(this: void, update: Set<string> | ((previous: Set<string>) => Set<string>)) {
      const checked = typeof update === 'function' ? update(selection.checked) : update;
      publish({ ...selection, checked });
    },
  };
}

export type GridSelection = ReturnType<typeof createGridSelection>;
