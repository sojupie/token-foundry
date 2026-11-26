import { AnchoredDialog } from '@token-catalog/forge-react';
import type { ComponentProps } from 'react';

export function EditorPopover(props: ComponentProps<typeof AnchoredDialog>) {
  return <AnchoredDialog {...props} className="popover-wide" />;
}
