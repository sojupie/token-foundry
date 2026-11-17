import type { ComponentProps } from 'react';
import { ChevronDown } from 'lucide-react';

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <div className="md-outlined-select min-w-0 w-full">
    <select className={className} {...props} />
    <span data-slot="trailing-icon" aria-hidden="true"><ChevronDown /></span>
  </div>;
}

export function NativeSelectOption(props: ComponentProps<'option'>) {
  return <option {...props} />;
}
