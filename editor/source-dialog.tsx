import { useRef, useState } from 'react';
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { Button } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '../lib/json.ts';
import type { ResolverEditScope, Review } from '../lib/workspace.ts';
import { sourceText, textareaText } from '../lib/source-text.ts';

export interface SourceLocation {
  file: string;
  path: readonly string[];
  offset?: number;
  resolver?: ResolverEditScope;
}

export function SourceDialog({ location, original, initialText, onDraftChange, reviewing, close, prepare, review }: {
  location: SourceLocation;
  original: string;
  initialText?: string | undefined;
  onDraftChange?: (text: string) => void;
  reviewing: boolean;
  close: () => void;
  prepare: (text: string, signal: AbortSignal) => Promise<Review>;
  review: (next: Review) => void;
}) {
  const [text, setText] = useState(() => sourceText(original, initialText ?? original));
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const pendingReview = useRef<AbortController | null>(null);

  async function prepareReview() {
    if (pendingReview.current) return;
    const controller = new AbortController();
    pendingReview.current = controller;
    setPending(true);
    setError('');
    try {
      const next = await prepare(text, controller.signal);
      if (!controller.signal.aborted) review(next);
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      pendingReview.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }
  function revealField(input: HTMLTextAreaElement) {
    if (text !== original || (!location.path.length && location.offset === undefined)) return;
    let node = parseTree(original);
    for (const part of location.path) {
      if (!node) return;
      node = findNodeAtLocation(node, [node.type === 'array' ? Number(part) : part]);
    }
    const offset = location.offset ?? node?.offset;
    if (offset === undefined) return;
    const before = textareaText(original.slice(0, offset));
    const selected = textareaText(original.slice(offset, offset + (location.offset === undefined ? node?.length ?? 0 : 0)));
    input.setSelectionRange(before.length, before.length + selected.length);
    const lines = before.split('\n');
    const computed = getComputedStyle(input);
    input.scrollTop = (lines.length - 1) * Number.parseFloat(computed.lineHeight) - input.clientHeight / 2;
    const context = document.createElement('canvas').getContext('2d');
    if (context) {
      context.font = computed.font;
      const column = (lines.at(-1) ?? '').replaceAll('\t', ' '.repeat(Number.parseInt(computed.tabSize, 10) || 8));
      input.scrollLeft = context.measureText(column).width - input.clientWidth / 2;
    }
  }

  return <ActionDialog title="Edit token source" description={location.file}
    className="source-dialog" open={!reviewing} onToggle={event => {
      if (event.newState !== 'open') return;
      const input = event.currentTarget.querySelector('textarea');
      if (input) revealField(input);
    }} onOpenChange={open => {
      if (!open && !reviewing) {
        pendingReview.current?.abort();
        close();
      }
    }}>
    <form className="grid min-w-0 gap-space150" onSubmit={event => {
      event.preventDefault();
      void prepareReview();
    }}>
      <Textarea aria-label="Token source JSON" data-initial-focus
        readOnly={pending} spellCheck={false} rows={16} className="min-w-0 resize-y whitespace-pre code-editor scroll-pane-lg-force"
        value={text} onChange={event => { const next = sourceText(original, event.currentTarget.value); setText(next); onDraftChange?.(next); }} />
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex justify-end gap-space100">
        <Button variant="text" data-dialog-close="">Cancel</Button>
        <Button type="submit" disabled={pending || text === original}>{pending ? 'Checking source…' : 'Review source changes'}</Button>
      </div>
    </form>
  </ActionDialog>;
}
