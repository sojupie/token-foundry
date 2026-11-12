import { ArrowRight, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { DocumentGraph } from '../lib/document.ts';

export function ReferenceDetails({ path, graph, close, jump }: {
  path: string; graph: DocumentGraph; close: () => void; jump: (path: string) => void;
}) {
  const issue = graph.issues.get(path);
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="max-h-[85dvh] overflow-auto">
      <DialogHeader>
        <DialogTitle>Token references</DialogTitle>
        <DialogDescription className="font-mono wrap-anywhere">{path}</DialogDescription>
      </DialogHeader>
      {issue && <p className="wrap-anywhere text-sm text-destructive">{issue}</p>}
      {([['References', graph.dependencies.get(path)], ['Used by', graph.usedBy.get(path)]] as const).map(([label, paths]) =>
        <section key={label} className="grid min-w-0 gap-1">
          <h3 className="text-sm font-medium">{label}</h3>
          {paths?.size ? [...paths].map((item) => graph.tokens.has(item) ?
            <Button key={item} size="sm" variant="ghost" className="h-auto justify-start px-2 py-1 font-mono"
              onClick={() => { close(); jump(item); }}><Link2 aria-hidden="true" />
              <span className="min-w-0 text-start whitespace-normal wrap-anywhere">{item}</span><ArrowRight aria-hidden="true" />
            </Button> : <code key={item} className="wrap-anywhere text-xs">{item}</code>) :
            <p className="text-xs text-muted-foreground">None</p>}
        </section>)}
    </DialogContent>
  </Dialog>;
}
