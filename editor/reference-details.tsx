import { ArrowRight, Link2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import type { DocumentGraph } from '../lib/document.ts';

export function ReferenceDetails({ path, graph, close, jump }: {
  path: string; graph: DocumentGraph; close: () => void; jump: (path: string) => void;
}) {
  const issue = graph.issues.get(path);
  const [open, setOpen] = useState(true);
  const destination = useRef<string | null>(null);
  return <ActionDialog open={open} onOpenChange={setOpen} title="Token references"
    description={<code className="wrap-anywhere">{path}</code>} onAfterClose={() => {
      close();
      if (destination.current) jump(destination.current);
    }}>
      {issue && <p className="wrap-anywhere text-sm text-destructive">{issue}</p>}
      {([['References', graph.dependencies.get(path)], ['Used by', graph.usedBy.get(path)]] as const).map(([label, paths]) =>
        <section key={label} className="grid min-w-0 gap-1">
          <h3 className="text-sm font-medium">{label}</h3>
          {paths?.size ? [...paths].map((item) => graph.tokens.has(item) ?
            <Button key={item} size="xsmall" variant="text" className="reference-choice"
              onClick={() => { destination.current = item; setOpen(false); }}><Link2 aria-hidden="true" />
              <span className="min-w-0 text-start whitespace-normal wrap-anywhere">{item}</span><ArrowRight aria-hidden="true" />
            </Button> : <code key={item} className="wrap-anywhere text-xs">{item}</code>) :
            <p className="text-xs text-muted-foreground">None</p>}
        </section>)}
  </ActionDialog>;
}
