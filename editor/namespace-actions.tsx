import { useRef } from 'react';
import { ArrowRightLeft, Link2, MoreHorizontal, Trash2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { Button } from '@/components/ui/button';

const item = 'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground [&>svg]:size-4';

export function NamespaceActions({ kind, disabled, tabIndex, move, remove, inspect }: {
  kind: 'group' | 'token';
  disabled: boolean;
  tabIndex?: number;
  move: () => void;
  remove: () => void;
  inspect?: () => void;
}) {
  const openingDialog = useRef(false);
  function choose(action: () => void) {
    openingDialog.current = true;
    action();
  }
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={kind === 'group' ? 'Group actions' : 'Token actions'}
        disabled={disabled} tabIndex={tabIndex} className="shrink-0"><MoreHorizontal aria-hidden="true" /></Button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" sideOffset={4} collisionPadding={8}
        className="z-40 min-w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        onCloseAutoFocus={(event) => {
          if (openingDialog.current) event.preventDefault();
          openingDialog.current = false;
        }}>
        {inspect && <DropdownMenu.Item className={item} onSelect={() => choose(inspect)}><Link2 aria-hidden="true" /> Inspect references</DropdownMenu.Item>}
        <DropdownMenu.Item className={item} onSelect={() => choose(move)}><ArrowRightLeft aria-hidden="true" /> Move {kind}</DropdownMenu.Item>
        <DropdownMenu.Item className={item + ' text-destructive'} onSelect={() => choose(remove)}><Trash2 aria-hidden="true" /> Delete {kind}</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
