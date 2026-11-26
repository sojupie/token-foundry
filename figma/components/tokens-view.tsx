import { useState } from 'react';
import { Button, Card, Disclosure, FilterChip, IconButton, List, ListItemButton, Select, SelectOption, TextField } from '@token-catalog/forge-react';
import { ArrowLeft, RefreshCw, Search, X } from 'lucide-react';
import type { FigmaBundle, VariableRow } from '../../integrations/figma/contract.ts';
import { isFigmaValue } from '../../integrations/figma/contract.ts';
import { EasingField } from '../../integrations/figma/easing-field.tsx';
import type { TokenForm } from '../forms.ts';
import { deriveTokenGroups, displayValue, hex, mergeHexWithAlpha, parseColor, rgbHex, type FileContext, type PluginWorkspace } from '../ui-types.ts';

function ReferencePicker({ rows, selected, value, choose }: {
  rows: readonly VariableRow[];
  selected: VariableRow;
  value: string;
  choose: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const matching = rows.filter(
    row => row.type === selected.type && row.path !== selected.path && row.path.toLowerCase().includes(query.toLowerCase()),
  );
  return <section className="plugin-stack" aria-label="Reference token">
    <p className="copy-small tone-supporting">{value ? `Reference: ${value}` : 'Choose a compatible token'}</p>
    <TextField
      type="search"
      label="Find reference token"
      containerClassName="plugin-search-field"
      leading={<Search aria-hidden="true" />}
      trailing={query ? (
        <IconButton size="xsmall" label="Clear reference search" onClick={() => setQuery('')}>
          <X aria-hidden="true" />
        </IconButton>
      ) : undefined}
      value={query}
      onChange={event => setQuery(event.target.value)}
    />
    <List className="plugin-token-list">
      {matching.slice(0, 40).map(row => (
        <li key={row.path}>
          <ListItemButton aria-current={value === row.path ? 'true' : undefined} onClick={() => choose(row.path)}>
            {row.path}
          </ListItemButton>
        </li>
      ))}
    </List>
    {matching.length > 40 && (
      <p className="copy-small tone-supporting">Showing 40 of {matching.length}. Refine search to narrow results.</p>
    )}
  </section>;
}

function safeRgbHex(value: string, fallback: unknown): string {
  try {
    return rgbHex(parseColor(value));
  } catch {
    return rgbHex(fallback);
  }
}

export function TokensView({
  bundle, local, workspace, fileContext, modifiedPaths,
  forms, formPaths, formAlternatives, formsReady, formStatus, formError,
  selected, value, kind, editProblem, editProblemAction, busy,
  query, filters, page, onQueryChange, onToggleFilter, onPageChange,
  onSelectRow, onBackToList, onRevertToken, onRefreshSelection,
  onRetainForm, onApplyEdit, onReviewBaseline, onDiscardForm,
  onRetrySaveForms, onDownloadForms, onResolveFormAlternative,
  onOpenWorkspace, onGoToConnect,
}: {
  bundle?: FigmaBundle | undefined;
  local: ReadonlyMap<string, unknown>;
  workspace?: PluginWorkspace | undefined;
  fileContext: FileContext;
  modifiedPaths: ReadonlySet<string>;
  forms: readonly TokenForm[];
  formPaths: readonly string[];
  formAlternatives: readonly TokenForm[];
  formsReady: boolean;
  formStatus: string;
  formError: boolean;
  selected?: VariableRow | undefined;
  value: string;
  kind: 'value' | 'alias';
  editProblem: string;
  editProblemAction: 'current' | 'foundry';
  busy: boolean;
  query: string;
  filters: readonly string[];
  page: number;
  onQueryChange: (next: string) => void;
  onToggleFilter: (key: string) => void;
  onPageChange: (next: number) => void;
  onSelectRow: (row: VariableRow) => void;
  onBackToList: () => void;
  onRevertToken: (row: VariableRow) => void;
  onRefreshSelection: () => void;
  onRetainForm: (text: string, kind?: 'value' | 'alias') => void;
  onApplyEdit: () => void;
  onReviewBaseline: () => void;
  onDiscardForm: (path: string) => void;
  onRetrySaveForms: () => void;
  onDownloadForms: () => void;
  onResolveFormAlternative: (form: TokenForm) => void;
  onOpenWorkspace: () => void;
  onGoToConnect: () => void;
}) {
  const rowByPath = new Map(bundle?.variables.map(row => [row.path, row] as const) ?? []);
  const groups = bundle ? deriveTokenGroups(bundle.variables) : [];
  const segmentIndex = groups[0]?.segmentIndex ?? 0;
  const validKeys = new Set(groups.map(group => group.key));
  const activeGroups = filters.filter(key => validKeys.has(key));
  const modifiedCount = new Set([...modifiedPaths, ...formPaths]).size;
  const modifiedOnly = filters.includes('__modified__') && modifiedCount > 0;
  const matching = bundle?.variables.filter(row => {
    if (modifiedOnly && !modifiedPaths.has(row.path) && !formPaths.includes(row.path)) return false;
    if (activeGroups.length > 0 && !activeGroups.includes(row.path.split('.')[segmentIndex] ?? '')) return false;
    return row.path.toLowerCase().includes(query.toLowerCase());
  }) ?? [];

  const selectionWithBindings = fileContext.selection.filter(node => node.tokens.length > 0);

  return <section className={bundle && !selected ? 'plugin-section plugin-tokens-browse' : 'plugin-section'} aria-label="Tokens">
    {!!formAlternatives.length && (
      <section className="plugin-group" aria-label="Conflicting unfinished edits">
        <h3 className="plugin-section-heading">Choose an unfinished edit</h3>
        <p className="copy-small tone-supporting">More than one unsaved draft exists for this token.</p>
        <div className="plugin-card-group">
          {formAlternatives.map((form, index) => (
            <Card
              as="section"
              key={`${form.row.path}:${form.revision}:${form.kind}:${String(index)}`}
              variant="outlined"
              headline={form.row.path}
              supporting={`${form.kind === 'alias' ? 'Reference' : 'Value' + (form.row.unit ? ` (${form.row.unit})` : '')} · Before ${displayValue(form.before)}`}
              actions={<Button variant="outlined" onClick={() => onResolveFormAlternative(form)}>Resume this edit</Button>}
            >
              <pre className="code-text copy-small">{form.text}</pre>
            </Card>
          ))}
        </div>
      </section>
    )}

    {formError && !selected && <p role="alert" className="copy-small tone-error">{formStatus}</p>}

    {!bundle && selected && (
      <Card
        as="section"
        variant="outlined"
        aria-label="Saved token edit"
        headline={selected.path}
        supporting="Connect or open a snapshot to apply this saved edit."
        actions={<>
          <Button variant="outlined" data-snackbar-avoid="" onClick={onDownloadForms}>Download token edits</Button>
          <Button variant="text" data-snackbar-avoid="" onClick={() => onDiscardForm(selected.path)}>Cancel edit</Button>
        </>}
      >
        <TextField label="Saved input" value={value} readOnly />
        {formError && <p role="alert" className="copy-small tone-error">{formStatus}</p>}
      </Card>
    )}

    {!bundle && !selected && (
      <Card
        variant="outlined"
        headline="No source loaded"
        supporting="Connect to a Foundry workspace or open a snapshot in Workspace to browse tokens."
        actions={<Button variant="tonal" onClick={onGoToConnect}>Go to Workspace</Button>}
      />
    )}

    {bundle && selected && <>
      <div className="plugin-back-row">
        <Button variant="text" size="small" onClick={onBackToList}>
          <ArrowLeft aria-hidden="true" />
          <span>All tokens</span>
        </Button>
      </div>

      <Card
        as="section"
        variant="outlined"
        aria-label="Edit token"
        headline={selected.path}
        supporting={selected.description || undefined}
        actions={<>
          <Button data-snackbar-avoid="" disabled={busy || !selected.editable || workspace?.role === 'concept'} onClick={onApplyEdit}>Apply in Figma</Button>
          {editProblem && editProblemAction === 'current' && (
            <Button variant="outlined" data-snackbar-avoid="" disabled={busy || workspace?.role === 'concept'} onClick={onReviewBaseline}>Review current value</Button>
          )}
          {editProblem && editProblemAction === 'foundry' && workspace && (
            <Button variant="outlined" data-snackbar-avoid="" onClick={onOpenWorkspace}>Open workspace in Foundry</Button>
          )}
          {modifiedPaths.has(selected.path) && selected.editable && workspace?.role !== 'concept' && (
            <Button variant="outlined" data-snackbar-avoid="" disabled={busy} onClick={() => onRevertToken(selected)}>Revert to source</Button>
          )}
          <Button variant="text" data-snackbar-avoid="" onClick={() => onDiscardForm(selected.path)}>Cancel edit</Button>
        </>}
      >
        <p className="copy-small tone-supporting">
          Current value: {selected.type === 'COLOR' && isFigmaValue(local.get(selected.path)) ? hex(local.get(selected.path)) : displayValue(local.get(selected.path))}
        </p>
        <div className="plugin-stack" data-snackbar-avoid="">
          <Select
            label="Value kind"
            value={kind}
            onChange={event => onRetainForm('', event.target.value === 'alias' ? 'alias' : 'value')}
          >
            <SelectOption value="value">Value{selected.unit ? ` (${selected.unit})` : ''}</SelectOption>
            <SelectOption value="alias">Reference to another token</SelectOption>
          </Select>

          {kind === 'alias' ? (
            <ReferencePicker rows={bundle.variables} selected={selected} value={value} choose={next => onRetainForm(next)} />
          ) : selected.type === 'EASING' ? (
            <EasingField
              value={value}
              onChange={next => onRetainForm(next)}
              source={selected.value}
              invalid={!!editProblem}
              describedBy={editProblem ? 'token-edit-problem' : undefined}
            />
          ) : selected.type === 'BOOLEAN' ? (
            <Select label="Value" value={value} onChange={event => onRetainForm(event.target.value)}>
              <SelectOption value="true">True</SelectOption>
              <SelectOption value="false">False</SelectOption>
            </Select>
          ) : selected.type === 'COLOR' ? (
            <div className="plugin-color-input-row">
              <input
                type="color"
                className="plugin-color-picker"
                aria-label="Pick color"
                value={safeRgbHex(value, local.get(selected.path))}
                onChange={event => onRetainForm(mergeHexWithAlpha(event.target.value, value))}
              />
              <TextField
                invalid={!!editProblem}
                aria-describedby={editProblem ? 'token-edit-problem' : undefined}
                label="Color (#RRGGBBAA)"
                value={value}
                onChange={event => onRetainForm(event.target.value)}
              />
            </div>
          ) : (
            <TextField
              invalid={!!editProblem}
              aria-describedby={editProblem ? 'token-edit-problem' : undefined}
              label={'Value' + (selected.unit ? ` (${selected.unit})` : '')}
              value={value}
              onChange={event => onRetainForm(event.target.value)}
            />
          )}
        </div>

        <p className="copy-small tone-supporting" aria-live="polite">
          {formPaths.length ? formStatus || 'Draft saved on this device.' : 'No unsaved edits.'}
        </p>

        {formError && (
          <div className="plugin-actions">
            <Button variant="text" onClick={onRetrySaveForms}>Retry saving edits</Button>
            <Button variant="text" onClick={onDownloadForms}>Download edits</Button>
          </div>
        )}

        {editProblem && <p id="token-edit-problem" role="alert" className="copy-small tone-error">{editProblem}</p>}
        {!selected.editable && (
          <p className="copy-small tone-supporting">This token uses inheritance or a field reference. Edit it in Foundry.</p>
        )}
      </Card>
    </>}

    {bundle && !selected && <>
      {fileContext.selection.length > 0 && (
        <Card
          as="section"
          variant="outlined"
          aria-label="Selection"
          headline={selectionWithBindings.length ? 'Selected layer tokens' : `Selected: ${fileContext.selection.map(node => node.name).join(', ')}`}
          supporting={selectionWithBindings.length
            ? (workspace?.role === 'concept' ? 'Concept files consume library tokens. Definitions stay read-only here.' : 'Select a bound token to view or edit it.')
            : 'No bound variables on this selection.'}
          actions={
            <IconButton size="small" label="Refresh selection" title="Refresh selection" disabled={busy} onClick={onRefreshSelection}>
              <RefreshCw aria-hidden="true" />
            </IconButton>
          }
        >
          {selectionWithBindings.map(node => (
            <div key={node.id} className="plugin-selection-node">
              <p className="copy-small copy-emphasis">{node.name} <span className="tone-supporting">· {node.type.toLowerCase()}</span></p>
              <List>
                {node.tokens.map(token => {
                  const row = rowByPath.get(token.path);
                  return (
                    <li key={node.id + ':' + token.field + ':' + token.path}>
                      <ListItemButton
                        disabled={!row || !formsReady}
                        supporting={`${token.field}${token.remote ? ' · Library' : ''}`}
                        onClick={() => { if (row) onSelectRow(row); }}
                      >
                        <span className="code-text token-name">{token.path}</span>
                      </ListItemButton>
                    </li>
                  );
                })}
              </List>
            </div>
          ))}
        </Card>
      )}

      <div className="plugin-filters">
        <TextField
          type="search"
          label="Find a token"
          containerClassName="plugin-search-field"
          leading={<Search aria-hidden="true" />}
          trailing={query ? (
            <IconButton size="xsmall" label="Clear token search" onClick={() => { onQueryChange(''); onPageChange(0); }}>
              <X aria-hidden="true" />
            </IconButton>
          ) : undefined}
          value={query}
          onChange={event => { onQueryChange(event.target.value); onPageChange(0); }}
        />
        {(groups.length > 1 || modifiedCount > 0) && (
          <fieldset className="plugin-filter-chips" aria-label="Filter tokens">
            {modifiedCount > 0 && (
              <FilterChip selected={modifiedOnly} onClick={() => onToggleFilter('__modified__')}>
                Modified ({modifiedCount})
              </FilterChip>
            )}
            {groups.map(group => (
              <FilterChip key={group.key} selected={activeGroups.includes(group.key)} onClick={() => onToggleFilter(group.key)}>
                {group.label}
              </FilterChip>
            ))}
          </fieldset>
        )}
      </div>

      <List className="plugin-token-list">
        {matching.slice(page * 40, page * 40 + 40).map(row => {
          const current = local.get(row.path);
          const hasDraft = formPaths.includes(row.path);
          const isModified = modifiedPaths.has(row.path);
          return (
            <li key={row.path}>
              <ListItemButton
                disabled={!formsReady}
                supporting={
                  <>
                    {row.type === 'COLOR' && isFigmaValue(current)
                      ? <span className="token-color-value"><span className="token-swatch" style={{ backgroundColor: hex(current) }} aria-hidden="true" />{hex(current)}</span>
                      : displayValue(current) + (row.unit && typeof current === 'number' ? ' ' + row.unit : '')}
                    {hasDraft ? ' · Unfinished edit' : isModified ? ' · Modified' : ''}
                  </>
                }
                onClick={() => onSelectRow(row)}
              >
                <span className="token-name">{row.path}</span>
              </ListItemButton>
            </li>
          );
        })}
      </List>

      <div className="plugin-pagination">
        <Button variant="text" size="xsmall" disabled={!page} onClick={() => onPageChange(page - 1)}>Previous</Button>
        <span className="copy-small tone-supporting">{matching.length} matching tokens</span>
        <Button variant="text" size="xsmall" disabled={(page + 1) * 40 >= matching.length} onClick={() => onPageChange(page + 1)}>Next</Button>
      </div>

      {!!bundle.unsupported.length && (
        <Disclosure label="Preserved in source" summary={`${bundle.unsupported.length} source-only definitions`}>
          <div className="plugin-stack">
            <p className="copy-small tone-supporting">These values stay in source files and are not overwritten by Figma.</p>
            <ul className="plugin-plain-list copy-small">
              {bundle.unsupported.slice(0, 100).map(row => <li key={row.path} className="code-text">{row.path}: {row.reason}</li>)}
            </ul>
          </div>
        </Disclosure>
      )}
    </>}
    {forms.length > 0 && bundle && !selected && !formAlternatives.length && (
      <p className="copy-small tone-supporting">{forms.length} unfinished token {forms.length === 1 ? 'edit' : 'edits'} saved on this device.</p>
    )}
  </section>;
}
