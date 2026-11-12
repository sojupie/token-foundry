import type { ComponentProps } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <div className="native-select">
    <select className={cn('native-field', className)} {...props} />
    <ChevronDown aria-hidden="true" />
  </div>;
}

export function NativeSelectOption(props: ComponentProps<'option'>) {
  return <option {...props} />;
}
