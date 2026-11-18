import { TextArea } from '@token-catalog/forge-react';
import type { TextAreaProps } from '@token-catalog/forge-react';

export function Textarea(props: TextAreaProps) {
  return <TextArea {...props} containerClassName="w-full" />;
}
