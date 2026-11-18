import { isValidElement, memo, useCallback, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { CommandMenu } from '@token-catalog/forge-react';
import type { Menu } from '@token-catalog/forge-react';
export { CommandMenu, RowCommandMenu } from '@token-catalog/forge-react';
export type { Menu, RowMenuHandle } from '@token-catalog/forge-react';

function iconType(icon: ReactNode) {
  return isValidElement(icon) ? icon.type : icon;
}

const TopMenu = memo(function TopMenu({ menu, dispatch }: { menu: Menu; dispatch: (menu: string, command: string) => void }) {
  return <CommandMenu label={menu.label} sections={menu.sections.map(section => section.map(command => ({
    ...command, run: () => dispatch(menu.label, command.label),
  })))} />;
}, (before, after) => {
  const first = before.menu;
  const second = after.menu;
  return before.dispatch === after.dispatch && first.label === second.label && first.sections.length === second.sections.length &&
    first.sections.every((section, index) => {
      const nextSection = second.sections[index];
      return nextSection?.length === section.length && section.every((command, position) => {
        const next = nextSection[position];
        return next && command.label === next.label && command.disabled === next.disabled &&
          command.title === next.title && command.destructive === next.destructive && iconType(command.icon) === iconType(next.icon);
      });
    });
});

export function CommandBar({ menus, children }: { menus: readonly Menu[]; children?: ReactNode }) {
  const committedMenus = useRef(menus);
  useLayoutEffect(() => { committedMenus.current = menus; }, [menus]);
  const dispatch = useCallback((menu: string, command: string) => {
    const selected = committedMenus.current.find(item => item.label === menu)?.sections.flat().find(item => item.label === command);
    if (selected && !selected.disabled) selected.run();
  }, []);
  return <div role="toolbar" aria-label="Workspace commands" data-roving-buttons="commands" className="flex shrink-0 items-center gap-1">
    {menus.map(menu => <TopMenu key={menu.label} menu={menu} dispatch={dispatch} />)}
    {children}
  </div>;
}
