import type { ReactNode, Ref } from 'react';
import { Menubar } from 'radix-ui';

interface Command {
  label: string;
  run: () => void;
  icon: ReactNode;
  disabled?: boolean;
  title?: string | undefined;
}

export interface Menu {
  label: string;
  sections: readonly (readonly Command[])[];
}

const itemStyle = 'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-disabled:opacity-50 data-highlighted:bg-accent [&>svg]:size-4';

export function CommandMenu({ label, sections, status, triggerRef, onCloseAutoFocus }: Menu & {
  status?: string; triggerRef?: Ref<HTMLButtonElement>; onCloseAutoFocus?: (event: Event) => void;
}) {
  return <Menubar.Menu>
    <Menubar.Trigger ref={triggerRef} title={status || undefined}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 text-sm outline-none hover:bg-accent focus:bg-accent data-[state=open]:bg-accent max-sm:text-xs">
      {label}
      {status !== undefined && <span aria-hidden="true" className={'size-1.5 rounded-full bg-emerald-600 ' + (status ? '' : 'invisible')} />}
    </Menubar.Trigger>
    <Menubar.Portal>
      <Menubar.Content align="start" sideOffset={4} collisionPadding={8} onCloseAutoFocus={onCloseAutoFocus}
        className="z-40 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
        {sections.filter((section) => section.length > 0).map((section, index) => <Menubar.Group key={section[0]?.label}>
          {index > 0 && <Menubar.Separator className="my-1 h-px bg-border" />}
          {section.map((command) => <Menubar.Item key={command.label} disabled={command.disabled ?? false}
            title={command.title} aria-description={command.title} onSelect={command.run} className={itemStyle}>
            {command.icon}{command.label}
          </Menubar.Item>)}
        </Menubar.Group>)}
      </Menubar.Content>
    </Menubar.Portal>
  </Menubar.Menu>;
}

export function CommandBar({ menus, children }: { menus: readonly Menu[]; children?: ReactNode }) {
  return <Menubar.Root aria-label="Workspace commands" className="flex shrink-0 items-center gap-1">
    {menus.map((menu) => <CommandMenu key={menu.label} {...menu} />)}
    {children}
  </Menubar.Root>;
}
