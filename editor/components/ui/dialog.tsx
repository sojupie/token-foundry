import { X } from 'lucide-react';
import { Dialog, IconButton } from '@token-catalog/forge-react';
import type { DialogProps } from '@token-catalog/forge-react';

export function ActionDialog({ busy, className = '', ...props }: Omit<DialogProps, 'headerAction'> & { busy?: boolean }) {
  return <Dialog {...props} className={`action-dialog ${className}`.trim()}
    onToggle={(event) => {
      props.onToggle?.(event);
      if (event.newState === 'open') event.currentTarget.querySelector<HTMLElement>('[data-initial-focus]')?.focus({ preventScroll: true });
    }}
    headerAction={<IconButton label="Close" size="xsmall" disabled={busy} data-dialog-close="">
      <X aria-hidden="true" />
    </IconButton>} />;
}
