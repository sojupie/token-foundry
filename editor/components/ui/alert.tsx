import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Alert({ className, variant, ...props }: ComponentProps<'div'> & { variant?: 'destructive' }) {
  return <div role={variant === 'destructive' ? 'alert' : 'status'}
    className={cn('surface-message', className)} data-tone={variant} {...props} />;
}

export function AlertDescription(props: ComponentProps<'div'>) {
  return <div {...props} />;
}
