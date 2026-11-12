import { ArrowRightLeft, Link2, MoreHorizontal, Trash2 } from 'lucide-react';
import { CommandMenu } from './command-bar.tsx';

export function NamespaceActions({ kind, disabled, move, remove, inspect }: {
  kind: 'group' | 'token';
  disabled: boolean;
  move: () => void;
  remove: () => void;
  inspect?: () => void;
}) {
  return <CommandMenu label={kind === 'group' ? 'Group actions' : 'Token actions'}
    icon={<MoreHorizontal aria-hidden="true" />} disabled={disabled} sections={[[
      ...(inspect ? [{ label: 'Inspect references', icon: <Link2 aria-hidden="true" />, run: inspect }] : []),
      { label: 'Move ' + kind, icon: <ArrowRightLeft aria-hidden="true" />, run: move },
      { label: 'Delete ' + kind, icon: <Trash2 aria-hidden="true" />, run: remove, destructive: true },
    ]]} />;
}
