import { useLayoutEffect, useRef } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';

const groupSelector = '[data-roving-buttons], .workspace-rail .md-nav-items';

function buttons(group: Element) {
  return Array.from(group.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
}

function setStop(group: Element, stop: HTMLButtonElement | undefined) {
  for (const button of group.querySelectorAll('button')) button.tabIndex = button === stop ? 0 : -1;
}

function onFocusCapture(event: FocusEvent<HTMLDivElement>) {
  if (!(event.target instanceof HTMLButtonElement)) return;
  const group = event.target.closest(groupSelector);
  if (group) setStop(group, event.target);
}

function onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
    !(event.target instanceof HTMLButtonElement)) return;
  const group = event.target.closest(groupSelector);
  if (!group) return;
  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  const vertical = group.classList.contains('md-nav-items') && (event.key === 'ArrowUp' || event.key === 'ArrowDown');
  if (!horizontal && !vertical && event.key !== 'Home' && event.key !== 'End') return;
  const enabled = buttons(group);
  const index = enabled.indexOf(event.target);
  if (index < 0) return;
  const rtl = getComputedStyle(group).direction === 'rtl';
  const forward = horizontal ? (event.key === 'ArrowRight') !== rtl : event.key === 'ArrowDown';
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 :
    (index + (forward ? 1 : -1) + enabled.length) % enabled.length;
  event.preventDefault();
  enabled[next]?.focus();
}

export function useWorkspaceRovingButtons(view: string, blocked: boolean, hasBulkActions: boolean, canCreate: boolean, desktop: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const visibleGroups = '[data-roving-buttons], .workspace-rail.' + (desktop ? 'md-navigation-rail' : 'md-navigation-bar') + ' .md-nav-items';
    for (const group of ref.current?.querySelectorAll(visibleGroups) ?? []) {
      const toolbar = group.getAttribute('data-roving-buttons');
      if (toolbar !== null && toolbar !== 'commands' && view !== 'tokens') continue;
      const enabled = (blocked && toolbar !== 'commands') || (toolbar === 'bulk' && !hasBulkActions) ? [] :
        buttons(group).filter(button => canCreate || button.dataset['keyTip'] !== 'N');
      const current = enabled.find(button => button.getAttribute('aria-current') === 'page');
      const previous = enabled.find(button => button.tabIndex === 0);
      const focused = enabled.find(button => button === document.activeElement);
      setStop(group, focused ?? current ?? previous ?? enabled[0]);
    }
  }, [view, blocked, hasBulkActions, canCreate, desktop]);
  return { ref, onFocusCapture, onKeyDownCapture };
}
