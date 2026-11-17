import { ArrowRight, Link2 } from 'lucide-react';
import { List, ListItemButton } from '@token-catalog/forge-react';
import { referenceConsumers, referenceProblems } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { TokenValue } from './token-value.tsx';

export function ReferenceDetails({ path, graph, jump, disabled }: {
  path: string; graph: DocumentGraph; jump: (path: string) => void; disabled: boolean;
}) {
  const referenceIssue = graph.issues.get(path);
  const problems = referenceIssue ? referenceProblems(graph, path, referenceIssue) : graph.validation.get(path);
  const links = graph.links.get(path);
  const { direct, downstream } = referenceConsumers(graph, path);
  return <section aria-label="Token references" className="grid gap-4">
    {problems?.length ? <ul className="grid gap-1 text-sm text-destructive">
      {problems.map(issue => <li key={issue} className="wrap-anywhere">{issue}</li>)}
    </ul> : null}
    <section className="grid min-w-0 gap-1">
      <h3 className="text-sm font-medium">References</h3>
      {links?.size ? <List aria-label="References" data-variant="segmented" data-surface="transparent">
        {[...links].map(([key, link]) => <li key={key} className="grid gap-1 py-1">
          {link.target && graph.tokens.has(link.target) ?
            <ListItemButton leading={<Link2 />} disabled={disabled}
              trailing={<span className="md-list-trailing-icon"><ArrowRight aria-hidden="true" /></span>}
              onClick={() => { if (link.target) jump(link.target); }}>
              <span className="wrap-anywhere">{link.target}</span>
            </ListItemButton> : null}
          <dl className="grid gap-1 px-2 text-xs">
            <div className="wrap-anywhere"><dt>Source field</dt><dd><code>{link.field.join(' / ')}</code></dd></div>
            <div className="wrap-anywhere"><dt>Authored link</dt><dd><code>{link.text}</code></dd></div>
            {link.parts.length > 0 && <div className="wrap-anywhere"><dt>Target location</dt>
              <dd><code>{link.file ? link.file + ' · ' : ''}{link.parts.join(' / ')}</code></dd>
            </div>}
            {link.value !== undefined && <div><dt>Resolved</dt><dd><TokenValue value={link.value} swatch wrap /></dd></div>}
          </dl>
        </li>)}
      </List> : <p className="text-xs text-muted-foreground">None</p>}
    </section>
    {([['Used by', [...direct]], ['Indirectly used by', [...downstream]]] as const).map(([label, paths]) =>
      <section key={label} className="grid min-w-0 gap-1">
        <h3 className="text-sm font-medium">{label}</h3>
        {paths.length ? <List aria-label={label} data-variant="segmented" data-surface="transparent">
          {paths.map(item => {
            const fields = label === 'Used by' ? [...(graph.links.get(item)?.values() ?? [])]
              .filter(link => link.target === path).map(link => link.field.join(' / ')) : [];
            return <li key={item}><ListItemButton leading={<Link2 />} disabled={disabled}
              trailing={<span className="md-list-trailing-icon"><ArrowRight aria-hidden="true" /></span>}
              onClick={() => jump(item)}>
              <span className="grid min-w-0 gap-1">
                <span className="wrap-anywhere">{item}</span>
                {!!fields.length && <span className="wrap-anywhere text-xs text-muted-foreground">{fields.join(', ')}</span>}
              </span>
            </ListItemButton></li>;
          })}
        </List> : <p className="text-xs text-muted-foreground">None</p>}
      </section>)}
  </section>;
}
