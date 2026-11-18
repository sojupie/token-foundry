import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { flushSync } from 'react-dom';

export interface KeyTipsHandle { show(): void }

type Layer = { kind: 'workspace' } | { kind: 'toolbar'; group: string } | { kind: 'menu'; label: string };
type Target = { key: string; label: string; element: HTMLElement; menu?: string };
type Badge = { key: string; label: string; x: number; y: number; inMenu: boolean };

const rowKeys: Record<string, string> = {
  'Edit token': 'E', References: 'R', 'Copy token': 'C', 'Rename token': 'N', 'Move token': 'M', 'Duplicate token': 'U',
};
const workspace: Layer = { kind: 'workspace' };
const menuKeys: Record<string, string> = { File: 'F', Edit: 'E', View: 'I', Variants: 'A', Help: 'K' };
const commandSelector = '[role="menuitem"]';

function sendMenuKey(element: Element, key: string) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function visible(element: HTMLElement) {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
}

function available(element: HTMLElement) {
  if (!visible(element) || element.matches(':disabled, [aria-disabled="true"], [data-disabled]')) return false;
  const rect = element.getBoundingClientRect();
  return rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
}

function labelOf(element: HTMLElement) {
  return element.getAttribute('aria-label') ?? element.textContent.trim();
}

function openMenu(menuLabel: string) {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'))
    .find(element => element.getAttribute('aria-label') === menuLabel && visible(element));
}

function menuTargets(menuLabel: string): Target[] {
  const menu = openMenu(menuLabel);
  if (!menu) return [];
  const used = new Set<string>();
  const row = menuLabel.startsWith('Token actions for ');
  const targets: Target[] = [];
  for (const element of menu.querySelectorAll<HTMLElement>(commandSelector)) {
    const label = labelOf(element);
    // Prefer word initials, then the remaining letters. Reserve the letters
    // of disabled commands so enabling a command doesn't rename its siblings.
    const initials = label.split(/[^a-z0-9]+/iu).map(word => word.charAt(0)).join('');
    const key = row ? rowKeys[label] : Array.from((initials + label + '1234567890').toUpperCase())
      .find(character => /[A-Z0-9]/u.test(character) && !used.has(character));
    if (!key) continue;
    used.add(key);
    if (!element.matches('[aria-disabled="true"], [data-disabled]')) targets.push({ key, label, element });
  }
  return targets;
}

function targetsFor(layer: Layer): Target[] {
  if (layer.kind === 'menu') return menuTargets(layer.label);
  const selector = layer.kind === 'toolbar'
    ? '[data-key-tip="' + CSS.escape(layer.group) + '"] [data-toolbar-tip]'
    : '[data-key-tip]';
  const targets: Target[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    const key = layer.kind === 'toolbar' ? element.dataset['toolbarTip'] : element.dataset['keyTip'];
    if (!key || !available(element)) continue;
    if (element.hasAttribute('data-roving-buttons') &&
      !Array.from(element.querySelectorAll<HTMLElement>('[data-toolbar-tip]')).some(available)) continue;
    const label = element.dataset['keyTipLabel'] ?? labelOf(element);
    targets.push({ key, label, element, ...(element.hasAttribute('data-key-tip-menu') ? { menu: label } : {}) });
  }
  if (layer.kind === 'workspace') {
    for (const element of document.querySelectorAll<HTMLElement>('[aria-label="Workspace commands"] button[aria-label]')) {
      const label = labelOf(element);
      const key = menuKeys[label];
      if (key && available(element)) targets.push({ key, label, element, menu: label });
    }
  }
  return targets;
}

function commandMenu(element: Element | null) {
  const menu = element?.closest<HTMLElement>('[role="menu"]');
  return menu?.closest('.command-menu') ? menu : undefined;
}

function menuReturnTarget(menu: HTMLElement) {
  const triggerId = menu.getAttribute('aria-labelledby');
  if (triggerId) return document.getElementById(triggerId);
  const label = menu.getAttribute('aria-label');
  return Array.from(document.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"][aria-expanded="true"]'))
    .find(button => button.getAttribute('aria-label') === label)
    ?.closest('[data-token-row]')?.querySelector<HTMLElement>('[tabindex="0"]');
}

export function KeyTips({ ref, blocked, jump }: {
  ref: Ref<KeyTipsHandle>;
  blocked: boolean;
  jump: (key: string) => boolean;
}) {
  const [layer, setLayer] = useState<Layer | null>(null);
  const [menuLabel, setMenuLabel] = useState<string>();
  const displayLayer = layer ?? (menuLabel ? { kind: 'menu' as const, label: menuLabel } : null);
  const [badges, setBadges] = useState<Badge[]>([]);
  const origin = useRef<HTMLElement | null>(null);
  const altTap = useRef(false);
  const menuFrame = useRef(0);

  function dismiss(restore: boolean) {
    cancelAnimationFrame(menuFrame.current);
    setLayer(null);
    if (restore && origin.current?.isConnected) origin.current.focus({ preventScroll: true });
    origin.current = null;
  }

  useImperativeHandle(ref, () => ({
    show() {
      if (blocked) return;
      // The Help menu returns focus to its trigger after the command runs.
      cancelAnimationFrame(menuFrame.current);
      menuFrame.current = requestAnimationFrame(() => {
        origin.current = document.querySelector<HTMLElement>('[aria-label="Workspace commands"] button[aria-label="Help"]');
        setLayer(workspace);
      });
    },
  }), [blocked]);

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    // Events sent to Forge to open or close a menu are outside the key-tip sequence.
    if (!event.isTrusted) return;
    const isAlt = event.key === 'Alt' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.getModifierState('AltGraph');
    const tab = event.key === 'Tab' && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (!isAlt) altTap.current = false;
    if (!displayLayer && !isAlt && !tab) return;
    if (tab) {
      const active = document.activeElement;
      const menu = commandMenu(active);
      const trigger = menu && menuReturnTarget(menu);
      if (active && trigger) {
        // Close through Forge before the browser advances to the next tab stop.
        flushSync(() => {
          sendMenuKey(active, 'Escape');
          if (layer) dismiss(false);
        });
        trigger.focus({ preventScroll: true });
      } else if (layer) {
        dismiss(false);
      }
      return;
    }
    const modalOpen = !!document.querySelector('dialog:modal');
    if (blocked || modalOpen) { if (layer) dismiss(false); return; }
    const menu = commandMenu(document.activeElement);
    if (isAlt) {
      if (blocked || modalOpen || document.activeElement?.closest('[role="listbox"], [role="combobox"][aria-expanded="true"]')) return;
      event.preventDefault();
      if (!event.repeat) altTap.current = true;
      return;
    }
    if (!displayLayer || event.isComposing) return;
    if (event.key === 'Escape') {
      if (!layer) return;
      if (layer.kind === 'menu' && menu) {
        // Escape belongs to Forge's menu. Leave it free to close and restore focus.
        setLayer(workspace);
      } else {
        event.preventDefault();
        event.stopPropagation();
        if (layer.kind === 'workspace') dismiss(true);
        else setLayer(workspace);
      }
      return;
    }
    if (['Shift', 'Control', 'Meta'].includes(event.key)) return;
    const key = event.key.toUpperCase();
    const letter = !event.altKey && !event.ctrlKey && !event.metaKey && /^[A-Z0-9]$/u.test(key);
    const target = letter ? targetsFor(displayLayer).find(item => item.key === key) : undefined;
    if (!target) {
      dismiss(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (displayLayer.kind === 'workspace' && target.element.hasAttribute('data-roving-buttons')) {
      setLayer({ kind: 'toolbar', group: key });
      return;
    }
    if (target.menu) {
      target.element.focus({ preventScroll: true });
      // Use Forge’s keyboard opener so the first enabled item owns focus.
      sendMenuKey(target.element, 'ArrowDown');
      setLayer({ kind: 'menu', label: target.menu });
      return;
    }
    const root = displayLayer.kind === 'workspace';
    dismiss(false);
    if (root && jump(target.key)) return;
    target.element.focus({ preventScroll: true });
    target.element.click();
  });

  const onKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Alt' || !altTap.current) return;
    altTap.current = false;
    event.preventDefault();
    event.stopPropagation();
    if (blocked || document.querySelector('dialog:modal')) return;
    if (layer) { dismiss(layer.kind !== 'menu'); return; }
    const active = document.activeElement;
    const menu = commandMenu(active);
    const activeLabel = menu?.getAttribute('aria-label');
    const triggerId = menu?.getAttribute('aria-labelledby');
    origin.current = triggerId ? document.getElementById(triggerId) : active instanceof HTMLElement ? active : null;
    setLayer(activeLabel ? { kind: 'menu', label: activeLabel } : workspace);
  });

  const onExit = useEffectEvent(() => {
    altTap.current = false;
    if (layer) dismiss(false);
  });

  useEffect(() => {
    const down = (event: KeyboardEvent) => onKeyDown(event);
    const up = (event: KeyboardEvent) => onKeyUp(event);
    const exit = () => onExit();
    const focus = (event: FocusEvent) => setMenuLabel(
      event.target instanceof Element ? commandMenu(event.target)?.getAttribute('aria-label') ?? undefined : undefined,
    );
    window.addEventListener('focusin', focus);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('pointerdown', exit, true);
    window.addEventListener('blur', exit);
    return () => {
      window.removeEventListener('focusin', focus);
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('pointerdown', exit, true);
      window.removeEventListener('blur', exit);
      cancelAnimationFrame(menuFrame.current);
    };
  }, []);

  const kind = displayLayer?.kind;
  const scope = displayLayer?.kind === 'menu' ? displayLayer.label : displayLayer?.kind === 'toolbar' ? displayLayer.group : '';
  useLayoutEffect(() => {
    const measuredLayer = kind === 'menu' ? { kind, label: scope } as const :
      kind === 'toolbar' ? { kind, group: scope } as const : kind === 'workspace' ? workspace : null;
    if (!measuredLayer) return undefined;
    let frame = 0;
    const decorated = new Set<HTMLElement>();
    function measure() {
      if (!measuredLayer) return;
      setBadges(targetsFor(measuredLayer).map(({ key, label, element }) => {
        const inMenu = measuredLayer.kind === 'menu';
        if (inMenu) {
          element.dataset['menuKey'] = key;
          element.setAttribute('aria-keyshortcuts', key);
          decorated.add(element);
          return { key, label, x: 0, y: 0, inMenu };
        }
        const rect = element.getBoundingClientRect();
        const inWorkspace = measuredLayer.kind === 'workspace';
        const groupsLabel = inWorkspace && key === 'G' && element.tagName === 'SPAN';
        const right = element.closest('.workspace-rail') || inWorkspace && (key === 'S' || key === 'G');
        const actionGroup = inWorkspace && element.hasAttribute('data-roving-buttons');
        const x = actionGroup ? rect.left + rect.width / 2 :
          groupsLabel ? rect.right + 12 : right ? rect.right - 12 : rect.left + Math.min(20, rect.width / 2);
        const y = actionGroup ? rect.top - 6 : right ? rect.top + rect.height / 2 : rect.bottom;
        return { key, label, inMenu, x: Math.max(12, Math.min(x, innerWidth - 12)),
          y: Math.max(12, Math.min(y, innerHeight - 12)) };
      }));
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    // Forge mounts menu content in a portal after the trigger activates.
    measure();
    schedule();
    const menu = measuredLayer.kind === 'menu' ? openMenu(measuredLayer.label) : undefined;
    const observer = menu && new MutationObserver(() => {
      if (!menu.isConnected) setMenuLabel(label => label === scope ? undefined : label);
    });
    const portal = menu?.closest('.command-menu')?.parentElement;
    if (portal && observer) observer.observe(portal, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      for (const item of decorated) {
        delete item.dataset['menuKey'];
        item.removeAttribute('aria-keyshortcuts');
      }
      observer?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [kind, scope]);

  return <>
    <output className="sr-only">{displayLayer && badges.length > 0 ?
      'Key tips. ' + badges.map(({ key, label }) => key + ' for ' + label).join('. ') : ''}</output>
    {layer && layer.kind !== 'menu' && <div className="workspace-key-tips" aria-hidden="true">{badges.filter(badge => !badge.inMenu).map(({ key, x, y }) =>
      <kbd className="workspace-key-tip" key={key} style={{ left: x, top: y }}>{key}</kbd>)}</div>}
  </>;
}
