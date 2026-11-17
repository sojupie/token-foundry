import type { ComponentProps } from 'react';

export function FieldRow({ children }: Pick<ComponentProps<'div'>, 'children'>) {
  return <div className="flex min-w-0 flex-wrap items-start gap-3 [&>*]:min-w-[min(100%,9rem)] [&>*]:flex-[1_1_calc(50%_-_0.375rem)]">
    {children}
  </div>;
}
