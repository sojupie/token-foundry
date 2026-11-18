import { Checkbox } from '@token-catalog/forge-react';
import { useCallback } from 'react';

export function SelectionCheckbox({ label, disabled, selected, indeterminate, change, rowRef, tabIndex }: {
  label: string;
  disabled: boolean;
  selected: boolean;
  indeterminate?: boolean;
  change: (selected: boolean) => void;
  rowRef?: (label: HTMLLabelElement | null) => void;
  tabIndex?: number;
}) {
  const inputRef = useCallback((input: HTMLInputElement | null) => {
    if (input) input.indeterminate = indeterminate ?? false;
  }, [indeterminate]);

  return <Checkbox labelRef={rowRef} ref={inputRef} aria-label={label} checked={selected} disabled={disabled}
    tabIndex={tabIndex} onChange={event => change(event.target.checked)} />;
}
