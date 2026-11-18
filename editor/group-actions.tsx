import { ArrowRightLeft, ClipboardPaste, Copy, Ellipsis, FolderPlus, Settings2, TextCursorInput, Trash2 } from 'lucide-react';
import { CommandMenu } from './command-bar.tsx';

export function GroupActions({ path, disabled, authored, variant, addGroupValue, metadata, create, rename, move, duplicate, copy, paste, remove }: {
  path: string;
  disabled: boolean;
  authored: boolean;
  variant: boolean;
  addGroupValue: (() => void) | undefined;
  metadata: () => void;
  create: () => void;
  rename: () => void;
  move: () => void;
  duplicate: () => void;
  copy: () => void;
  paste: () => void;
  remove: () => void;
}) {
  return <CommandMenu label={path ? 'Actions for ' + path.split('.').join(' / ') : 'Group actions'} heading={path ? path.split('.').join(' / ') : 'All tokens'} icon={<Ellipsis aria-hidden="true" />}
    triggerRef={button => { if (button) { button.dataset['keyTip'] = 'H'; button.dataset['keyTipMenu'] = ''; } }}
    disabled={disabled} sections={[
      [{ label: 'New group', icon: <FolderPlus aria-hidden="true" />, disabled: !authored, run: create },
        ...(addGroupValue ? [{ label: 'Add group value', icon: <FolderPlus aria-hidden="true" />, run: addGroupValue }] : []),
        ...(!variant ? [{ label: 'Edit group metadata', icon: <Settings2 aria-hidden="true" />, run: metadata }] : [])],
      variant ? [] : [
        { label: 'Rename group', icon: <TextCursorInput aria-hidden="true" />, disabled: !path || !authored, run: rename },
        { label: 'Move group', icon: <ArrowRightLeft aria-hidden="true" />, disabled: !path || !authored, run: move },
        { label: 'Copy group', icon: <Copy aria-hidden="true" />, disabled: !path, run: copy },
        { label: 'Paste into group…', icon: <ClipboardPaste aria-hidden="true" />, disabled: !authored, run: paste },
        { label: 'Duplicate group', icon: <Copy aria-hidden="true" />, disabled: !path, run: duplicate },
        { label: 'Delete group', icon: <Trash2 aria-hidden="true" />, disabled: !path || !authored, run: remove, destructive: true },
      ],
    ]} />;
}
