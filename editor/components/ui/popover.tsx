import { Dialog, Popover } from 'react-aria-components';
import type { ReactNode, RefObject } from 'react';

export function EditorPopover({ anchor, label, onDismiss, children }: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return <Popover triggerRef={anchor} isOpen onOpenChange={open => { if (!open) onDismiss(); }}
    placement="bottom start" offset={6} containerPadding={12}
    className="editor-popover w-[38rem]" data-component-assets>
    <Dialog aria-label={label} className="outline-none">{children}</Dialog>
  </Popover>;
}
