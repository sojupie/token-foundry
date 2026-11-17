import { useImperativeHandle, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { Button, Header, Menu as AriaMenu, MenuItem, MenuSection, MenuTrigger, Popover, Separator } from 'react-aria-components';

interface Command {
  label: string;
  run: () => void;
  icon: ReactNode;
  disabled?: boolean;
  title?: string | undefined;
  destructive?: boolean;
}

export interface Menu {
  label: string;
  sections: readonly (readonly Command[])[];
}

export function CommandMenu({ label, sections, status, triggerRef, icon, disabled, heading, triggerClassName }: Menu & {
  status?: string;
  triggerRef?: Ref<HTMLButtonElement>;
  icon?: ReactNode;
  disabled?: boolean;
  heading?: string;
  triggerClassName?: string;
}) {
  return <MenuTrigger>
    <Button ref={triggerRef} aria-label={label} aria-description={status || undefined} isDisabled={disabled ?? false}
      className={(icon ? 'md-icon-button md-standard-icon-button' : 'command-trigger inline-flex shrink-0 items-center gap-1.5') + (triggerClassName ? ' ' + triggerClassName : '')}
      data-size={icon ? 'xsmall' : undefined} data-shape={icon ? 'round' : undefined} data-width={icon ? 'default' : undefined}>
      {icon ?? label}
      {status && <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-600" />}
    </Button>
    <Popover className="command-menu" placement={icon ? 'bottom end' : 'bottom start'} offset={4} containerPadding={8}>
      <MenuContents {...{ label, sections, heading }} />
    </Popover>
  </MenuTrigger>;
}

function MenuContents({ label, sections, heading, close }: Menu & {
  heading?: string | undefined; close?: () => void;
}) {
  return <AriaMenu aria-label={label} {...(close ? { autoFocus: 'first' as const } : {})}>
    {sections.filter(section => section.length > 0).map((section, index) => <MenuSection key={section[0]?.label}>
      {index === 0 && heading && <Header className="command-menu-heading">{heading}</Header>}
      {index > 0 && <Separator className="my-1 h-px bg-border" />}
      {section.map(command => <MenuItem key={command.label} isDisabled={command.disabled ?? false}
        textValue={command.label} aria-description={command.title} onAction={() => { close?.(); command.run(); }}
        className={'command-menu-item' + (command.destructive ? ' text-destructive' : '')}>
        {command.icon}{command.label}
      </MenuItem>)}
    </MenuSection>)}
  </AriaMenu>;
}

interface RowMenu extends Menu {
  heading: string;
  restore: () => void;
}

export interface RowMenuHandle {
  open: (button: HTMLButtonElement, menu: RowMenu) => void;
}

export function RowCommandMenu({ ref }: { ref: Ref<RowMenuHandle> }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<RowMenu>();
  useImperativeHandle(ref, () => ({
    open(button, next) {
      trigger.current?.setAttribute('aria-expanded', 'false');
      trigger.current = button;
      button.setAttribute('aria-expanded', 'true');
      setMenu(next);
    },
  }), []);
  if (!menu) return null;
  function close(restore: boolean) {
    trigger.current?.setAttribute('aria-expanded', 'false');
    setMenu(undefined);
    if (restore) requestAnimationFrame(() => menu?.restore());
  }
  return <Popover isOpen trigger="MenuTrigger" triggerRef={trigger} shouldSkipAnimation className="command-menu"
    placement="bottom end" offset={4} containerPadding={8} aria-label={menu.label}
    onOpenChange={open => { if (!open) close(true); }}>
    <MenuContents {...menu} close={() => close(false)} />
  </Popover>;
}

export function CommandBar({ menus, children }: { menus: readonly Menu[]; children?: ReactNode }) {
  return <fieldset aria-label="Workspace commands" className="flex shrink-0 items-center gap-1">
    {menus.map(menu => <CommandMenu key={menu.label} {...menu} />)}
    {children}
  </fieldset>;
}
