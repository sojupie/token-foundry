import type { ComponentProps } from 'react';
import { Popover as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Popover = Primitive.Root;
export const PopoverAnchor = Primitive.Anchor;

export function PopoverContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal>
    <Primitive.Content align="start" sideOffset={sideOffset} collisionPadding={12}
      className={cn('z-40 max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-1.5rem)] overflow-auto rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg outline-none', className)}
      {...props} />
  </Primitive.Portal>;
}
