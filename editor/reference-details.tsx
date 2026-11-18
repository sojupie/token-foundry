import { memo, useDeferredValue, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button, Disclosure, IconButton } from '@token-catalog/forge-react';
import { referenceConsumers, referenceProblems } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import type { RenderData } from './lib/render-data.ts';
import { TokenValue } from './token-value.tsx';
import { tokenDisplayName, valueFieldLabel } from './lib/value-shape.ts';

const pageSize = 24;

function pageItems<T>(items: Iterable<T>, page: number) {
  const result: T[] = [];
  const start = (page - 1) * pageSize;
  let index = 0;
  for (const item of items) {
    if (index++ < start) continue;
    result.push(item);
    if (result.length === pageSize) break;
  }
  return result;
}

interface ReferenceDetailsProps {
  path: string; data: RenderData<DocumentGraph>; jump: (path: string) => void; disabled: boolean;
}

export const ReferenceDetails = memo(function ReferenceDetails({ path, data, jump, disabled }: ReferenceDetailsProps) {
  const deferredPath = useDeferredValue(path, '');
  if (deferredPath !== path) return <output className="copy-small tone-supporting">Finding references…</output>;
  return <References key={path} {...{ path, data, jump, disabled }} />;
});

function References({ path, data, jump, disabled }: ReferenceDetailsProps) {
  const graph = data.value;
  const referenceIssue = graph.issues.get(path);
  const problems = referenceIssue ? referenceProblems(graph, path, referenceIssue) : graph.validation.get(path);
  const links = graph.links.get(path);
  const fieldLabel = (token: string, field: readonly string[]) =>
    valueFieldLabel(field, graph.resolved.get(token) ?? graph.tokens.get(token)?.value, graph.tokens.get(token)?.type);
  const { direct, downstream } = useMemo(() => referenceConsumers(graph, path), [graph, path]);
  const [referencePage, setReferencePage] = useState(1);
  const [directPage, setDirectPage] = useState(1);
  const [indirectPage, setIndirectPage] = useState(1);
  return <section aria-label="Token references" className="token-editor-section grid min-w-0 gap-2">
    <h3 className="token-editor-section-title">Token relationships</h3>
    {problems?.length ? <ul className="grid gap-1 copy-body tone-error">
      {problems.map(issue => <li key={issue} className="wrap-anywhere">{issue}</li>)}
    </ul> : null}
    {links?.size ? <Disclosure compact label="References" summary={links.size + ' linked ' + (links.size === 1 ? 'value' : 'values')} open>
      <ul aria-label="References" className="token-relationship-list">
        {pageItems(links, referencePage).map(([key, link]) => {
          const target = link.target && graph.tokens.has(link.target) ? link.target : undefined;
          return <li key={key}>
            <RelationshipRow path={target} disabled={disabled} jump={jump} detail={fieldLabel(path, link.field) + ' links to'}>
              {target ? tokenDisplayName(target) : link.text}
            </RelationshipRow>
            {link.value !== undefined && <div className="flex flex-wrap items-center gap-x-2">
              <span className="token-editor-support">Resolved value</span>
              <TokenValue value={link.value} swatch wrap />
            </div>}
            {(!target || link.text !== '{' + target + '}') && <Disclosure compact label="Link details" className="mt-2">
              <dl className="token-editor-support grid gap-1">
                <div className="wrap-anywhere"><dt>Authored link</dt><dd><code>{link.text}</code></dd></div>
                {link.parts.length > 0 && <div className="wrap-anywhere"><dt>Target location</dt>
                  <dd><code>{link.file ? link.file + ' · ' : ''}{link.parts.join(' / ')}</code></dd>
                </div>}
              </dl>
            </Disclosure>}
          </li>;
        })}
      </ul>
      <More total={links.size} page={referencePage} setPage={setReferencePage} label="references" />
    </Disclosure> : null}
    {direct.size || downstream.size ? <Disclosure compact label="Used by" open summary={
      [direct.size ? direct.size + ' direct' : '', downstream.size ? downstream.size + ' indirect' : ''].filter(Boolean).join(' · ')
    }>
      {([['Used by', direct, directPage, setDirectPage], ['Indirectly used by', downstream, indirectPage, setIndirectPage]] as const)
        .map(([label, paths, page, setPage]) => paths.size > 0 && <section key={label} className="grid min-w-0 gap-1">
          {label === 'Indirectly used by' && <h4 className="token-editor-label">Indirect uses</h4>}
          <ul aria-label={label} className="token-relationship-list">
            {pageItems(paths, page).map(item => {
              const fields = label === 'Used by' ? [...(graph.links.get(item)?.values() ?? [])]
                .filter(link => link.target === path).map(link => fieldLabel(item, link.field)) : [];
              return <li key={item}>
                <RelationshipRow path={item} disabled={disabled} jump={jump} detail={fields.length ? fields.join(', ') + ' links here' : ''}>
                  {tokenDisplayName(item)}
                </RelationshipRow>
              </li>;
            })}
          </ul>
          <More total={paths.size} {...{ page, setPage }} label={label === 'Used by' ? 'direct uses' : 'indirect uses'} />
        </section>)}
    </Disclosure> : null}
    {!links?.size && !direct.size && !downstream.size &&
      <div className="token-editor-support">No references or uses.</div>}
  </section>;
}

function RelationshipRow({ path, disabled, jump, detail, children }: {
  path: string | undefined; disabled: boolean; jump: (path: string) => void; detail: string; children: string;
}) {
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
    <div className="min-w-0">
      <code className="token-relationship-path wrap-anywhere">{children}</code>
      {detail && <div className="token-editor-support">{detail}</div>}
    </div>
    {path && <IconButton size="xsmall" label={children} title={'Go to ' + children} aria-description={detail || undefined}
      disabled={disabled} onClick={() => jump(path)}><ArrowRight aria-hidden="true" /></IconButton>}
  </div>;
}

function More({ total, page, setPage, label }: { total: number; page: number; setPage: (page: number) => void; label: string }) {
  return total > pageSize && <div className="flex items-center justify-between gap-1 copy-small">
    <Button type="button" size="xsmall" variant="text" disabled={page === 1}
      aria-label={'Previous ' + label} onClick={() => setPage(page - 1)}>Previous</Button>
    <span>{((page - 1) * pageSize + 1).toLocaleString()}–{Math.min(page * pageSize, total).toLocaleString()} of {total.toLocaleString()}</span>
    <Button type="button" size="xsmall" variant="text" disabled={page * pageSize >= total}
      aria-label={'Next ' + label} onClick={() => setPage(page + 1)}>Next</Button>
  </div>;
}
