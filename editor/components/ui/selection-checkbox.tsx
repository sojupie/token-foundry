import { Checkbox } from 'react-aria-components';

export function SelectionCheckbox({ label, disabled }: { label: string; disabled: boolean }) {
  return <Checkbox slot="selection" aria-label={label} isDisabled={disabled} className="selection-checkbox">
    {({ isIndeterminate, isSelected }) => <span aria-hidden="true">
      {(isIndeterminate || isSelected) && <svg viewBox="0 0 18 18" fill="none">
        <path d={isIndeterminate ? 'M4 9h10' : 'm4 9 3 3 7-7'} stroke="currentColor" strokeWidth="2" />
      </svg>}
    </span>}
  </Checkbox>;
}
