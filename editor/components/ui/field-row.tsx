import type { ComponentProps } from 'react';

export function FieldRow({ children }: Pick<ComponentProps<'div'>, 'children'>) {
  return <div className="field-row flex min-w-0 flex-wrap items-start gap-space150 [&>*]:flex-[1_1_calc(50%_-_0.375rem)]">
    {children}
  </div>;
}
