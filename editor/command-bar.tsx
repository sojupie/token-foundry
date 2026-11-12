import type { ReactNode, Ref } from 'react';
import { Button, Menu as AriaMenu, MenuItem, MenuSection, MenuTrigger, Popover, Separator } from 'react-aria-components';

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

export function CommandMenu({ label, sections, status, triggerRef, icon, disabled }: Menu & {
  status?: string;
  triggerRef?: Ref<HTMLButtonElement>;
  icon?: ReactNode;
  disabled?: boolean;
}) {
  return <MenuTrigger>
    <Button ref={triggerRef} aria-label={label} aria-description={status || undefined} isDisabled={disabled ?? false}
      className={icon ? 'md-icon-button md-standard-icon-button' : 'command-trigger inline-flex shrink-0 items-center gap-1.5'}
      data-size={icon ? 'xsmall' : undefined} data-shape={icon ? 'round' : undefined} data-width={icon ? 'default' : undefined}>
      {icon ?? label}
      {status && <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-600" />}
    </Button>
    <Popover className="command-menu" placement={icon ? 'bottom end' : 'bottom start'} offset={4} containerPadding={8}>
      <AriaMenu aria-label={label}>
        {sections.filter(section => section.length > 0).map((section, index) => <MenuSection key={section[0]?.label}>
          {index > 0 && <Separator className="my-1 h-px bg-border" />}
          {section.map(command => <MenuItem key={command.label} isDisabled={command.disabled ?? false}
            textValue={command.label} aria-description={command.title} onAction={command.run}
            className={'command-menu-item' + (command.destructive ? ' text-destructive' : '')}>
            {command.icon}{command.label}
          </MenuItem>)}
        </MenuSection>)}
      </AriaMenu>
    </Popover>
  </MenuTrigger>;
}

export function CommandBar({ menus, children }: { menus: readonly Menu[]; children?: ReactNode }) {
  return <fieldset aria-label="Workspace commands" className="flex shrink-0 items-center gap-1">
    {menus.map(menu => <CommandMenu key={menu.label} {...menu} />)}
    {children}
  </fieldset>;
}
