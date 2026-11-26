import { Button, Card, Disclosure, List, ListItemButton } from '@token-catalog/forge-react';
import { ConflictReview } from '../../integrations/figma/conflict-review.tsx';
import { isFigmaColor, type FigmaBundle, type TokenProposal } from '../../integrations/figma/contract.ts';
import type { LocalValue, PullChoice, PullConflict } from '../../integrations/figma/merge.ts';
import type { ConflictDraft } from '../../integrations/figma/recovery.ts';
import type { NativeUnitConflict } from '../native-values.ts';
import { isRecord } from '../../lib/json.ts';
import { displayValue, hex, type PluginWorkspace, type PullReviewState, type ServerConflictReview, type SourceConnectionPrompt } from '../ui-types.ts';

type LocalChangeItem = TokenProposal['changes'][number];

function formatChangeValue(value: unknown): string {
  if (isFigmaColor(value)) return hex(value);
  if (isRecord(value) && typeof value['value'] === 'number' && typeof value['unit'] === 'string') return `${value['value']} ${value['unit']}`;
  return displayValue(value);
}

export function ChangesView({
  bundle, workspace, connected, busy, offline, recovery, nativeIssue, changed, localChanges,
  sourceReviewNeeded, sourceConnection, serverReview, pullReview, conflicts, pullDrafts,
  reviewNative, unitConflicts, formPaths, exported,
  onOpenWorkspace, onDownloadChanges, onResumePull,
  onResolveNativeUnit, onConfirmSourceConnection, onCancelSourceConnection, onReviewSourceUpdates,
  onServerDraftsChange, onApplyServerChoices, onCancelServerReview, onResumeEarlierInput,
  onPullDraftsChange, onApplyPullChoices, onCancelPullReview, onReviewUnfinishedEdits,
  onOpenToken, onRevertToken,
}: {
  bundle?: FigmaBundle | undefined;
  workspace?: PluginWorkspace | undefined;
  connected: boolean;
  busy: boolean;
  offline: boolean;
  recovery: boolean;
  nativeIssue: string;
  changed: number;
  localChanges: readonly LocalChangeItem[];
  sourceReviewNeeded: boolean;
  sourceConnection?: SourceConnectionPrompt | undefined;
  serverReview?: ServerConflictReview | undefined;
  pullReview?: PullReviewState | undefined;
  conflicts: readonly PullConflict[];
  pullDrafts: readonly ConflictDraft[];
  reviewNative: { rows: FigmaBundle['variables']; values: ReadonlyMap<string, LocalValue> };
  unitConflicts: readonly NativeUnitConflict[];
  formPaths: readonly string[];
  exported?: TokenProposal | undefined;
  onOpenWorkspace: () => void;
  onDownloadChanges: () => void;
  onResumePull: () => void;
  onResolveNativeUnit: (path: string, expectedNative: number, value: number) => void;
  onConfirmSourceConnection: () => void;
  onCancelSourceConnection: () => void;
  onReviewSourceUpdates: () => void;
  onServerDraftsChange: (drafts: ConflictDraft[]) => void;
  onApplyServerChoices: (choices: PullChoice[]) => void;
  onCancelServerReview: () => void;
  onResumeEarlierInput: (draft: ConflictDraft) => (() => void) | undefined;
  onPullDraftsChange: (drafts: ConflictDraft[]) => void;
  onApplyPullChoices: (choices: PullChoice[]) => void;
  onCancelPullReview: () => void;
  onReviewUnfinishedEdits: () => void;
  onOpenToken: (path: string) => void;
  onRevertToken: (path: string) => void;
}) {
  const statusCopy = serverReview
    ? 'The same tokens changed in Figma and Foundry. Choose which values to keep.'
    : recovery
      ? 'Finish the interrupted pull before syncing changes.'
      : nativeIssue
        ? `Sync paused: ${nativeIssue}`
        : sourceReviewNeeded
          ? 'Review source updates before syncing local changes.'
          : offline
            ? 'Offline. Changes will sync when reconnected.'
            : busy
              ? 'Syncing changes…'
              : !connected || !workspace
                ? 'Local Figma snapshot. Connect a workspace to save and share edits.'
                : changed
                  ? `${changed} local ${changed === 1 ? 'change' : 'changes'} waiting to sync.`
                  : 'All local changes are saved to the workspace.';

  const repoLine = workspace?.repository
    ? `${workspace.repository} · ${
      workspace.dirty === true
        ? 'Uncommitted draft changes'
        : workspace.dirty === false
          ? 'Matches repository checkpoint'
          : 'Checkpoint pending'
    }${workspace.pullRequest ? ` · Merge request #${workspace.pullRequest.split('/').at(-1) ?? ''}` : ''}`
    : undefined;

  return <section className="plugin-section plugin-card-group" aria-label="Workspace changes">
    {recovery && (
      <Card
        as="section"
        variant="outlined"
        aria-label="Interrupted pull"
        headline="Finish interrupted pull"
        supporting="A previous snapshot update stopped mid-way. Resume it to apply the saved baseline; newer Figma edits stay safe for review."
        actions={
          <Button disabled={busy || !!pullReview || !!unitConflicts.length} onClick={onResumePull}>
            Resume interrupted pull
          </Button>
        }
      />
    )}

    {unitConflicts.map(conflict => (
      <Card
        as="section"
        key={conflict.path}
        variant="outlined"
        aria-label="Review native units"
        headline="Choose how to interpret this value"
        supporting={`${conflict.path} · Currently ${conflict.current} in Figma; previously ${conflict.before} in source units.`}
      >
        <List>
          {[
            { label: `Use ${conflict.current}% (Figma percentage)`, value: conflict.current / conflict.afterScale },
            { label: `Use ${conflict.current} (source ratio)`, value: conflict.current },
            { label: `Restore ${conflict.before} (previous value)`, value: conflict.before },
          ].map(choice => (
            <li key={choice.label}>
              <ListItemButton disabled={busy} onClick={() => onResolveNativeUnit(conflict.path, conflict.current, choice.value)}>
                {choice.label}
              </ListItemButton>
            </li>
          ))}
        </List>
      </Card>
    ))}

    {sourceReviewNeeded && (
      <Card
        as="section"
        variant="outlined"
        aria-label="Review current source"
        headline="Review source updates"
        supporting="The workspace source moved ahead. Review the updated baseline before syncing local edits."
        actions={<Button disabled={busy || !connected} onClick={onReviewSourceUpdates}>Review source updates</Button>}
      />
    )}

    {sourceConnection && (
      <Card
        as="section"
        variant="outlined"
        aria-label="Review source connection"
        headline="Switch source for this file?"
        supporting={`Current snapshot: ${bundle?.name ?? 'Local'} (${bundle?.variables.length ?? 0} tokens). New workspace: ${sourceConnection.name} (${sourceConnection.count} tokens).`}
        actions={<>
          <Button disabled={busy} onClick={onConfirmSourceConnection}>Connect this source</Button>
          <Button variant="text" onClick={onCancelSourceConnection}>Keep current source</Button>
        </>}
      />
    )}

    {serverReview && (
      <ConflictReview
        submitted
        native={reviewNative}
        resumeInput={onResumeEarlierInput}
        updated={serverReview.updated}
        drafts={serverReview.drafts}
        onDraftsChange={onServerDraftsChange}
        conflicts={serverReview.conflicts}
        rows={serverReview.current.variables}
        busy={busy}
        cancel={onCancelServerReview}
        apply={onApplyServerChoices}
      />
    )}

    {!!conflicts.length && pullReview && (
      <ConflictReview
        key={pullReview.id}
        drafts={pullDrafts}
        onDraftsChange={onPullDraftsChange}
        conflicts={conflicts}
        rows={pullReview.incoming.variables}
        busy={busy}
        cancel={onCancelPullReview}
        apply={onApplyPullChoices}
      />
    )}

    {!serverReview && !pullReview && !!formPaths.length && (
      <Card
        as="section"
        variant="outlined"
        aria-label="Unfinished token edits"
        headline="Unfinished token edits"
        supporting={`${formPaths.length} draft ${formPaths.length === 1 ? 'edit' : 'edits'} saved locally in Tokens.`}
        actions={<Button variant="outlined" disabled={busy} onClick={onReviewUnfinishedEdits}>Review unfinished edits</Button>}
      />
    )}

    {!serverReview && !pullReview && !!localChanges.length && (
      <Card
        as="section"
        variant="outlined"
        aria-label="Local changes"
        headline={`Local changes (${localChanges.length})`}
        supporting={connected && workspace ? 'Waiting to sync to Foundry.' : 'Modified locally against the current snapshot.'}
      >
        <List>
          {localChanges.slice(0, 40).map(change => (
            <li key={change.path}>
              <ListItemButton
                disabled={busy}
                supporting={`${formatChangeValue(change.before)} → ${formatChangeValue(change.after)}`}
                onClick={() => onOpenToken(change.path)}
                actions={workspace?.role !== 'concept' ? (
                  <Button
                    variant="text"
                    size="xsmall"
                    disabled={busy || recovery || !!unitConflicts.length}
                    onClick={event => {
                      event.stopPropagation();
                      onRevertToken(change.path);
                    }}
                  >
                    Revert
                  </Button>
                ) : undefined}
              >
                <span className="code-text token-name">{change.path}</span>
              </ListItemButton>
            </li>
          ))}
        </List>
        {localChanges.length > 40 && (
          <p className="copy-small tone-supporting">Showing 40 of {localChanges.length} local changes.</p>
        )}
      </Card>
    )}

    <Card
      as="section"
      variant="outlined"
      headline="Sync status"
      supporting={statusCopy}
      actions={<>
        {workspace && <Button variant="tonal" onClick={onOpenWorkspace}>Open workspace in Foundry</Button>}
        {bundle && (
          <Button
            variant="text"
            disabled={busy || recovery || !!pullReview || !changed || !!nativeIssue || workspace?.role === 'concept'}
            onClick={onDownloadChanges}
          >
            Download changes
          </Button>
        )}
      </>}
    >
      {repoLine && <p className="copy-small tone-supporting">{repoLine}</p>}
    </Card>

    {exported && (
      <Disclosure label={`Last exported changes (${exported.changes.length})`}>
        <pre className="code-text copy-small">{JSON.stringify(exported, null, 2)}</pre>
      </Disclosure>
    )}
  </section>;
}
