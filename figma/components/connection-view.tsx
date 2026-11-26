import { useState } from 'react';
import { Button, Card, Disclosure, Divider, TextField } from '@token-catalog/forge-react';
import type { FileContext, PluginWorkspace } from '../ui-types.ts';

export function ConnectionView({
  fileContext, workspace, connected, savedConnection, connectionText, pairing,
  foundryOrigin, onFoundryOriginChange,
  busy, nativeBusy, recovery, unitConflictCount, savedConcept, formsReady, formCount,
  hasBundle, library, libraryCompatible, nativeIssue,
  onStartPairing, onCancelPairing, onConnectionCodeChange, onPullRemote, onForgetConnection,
  onOpenSnapshot, onOpenTokenForms, onDownloadForms, onOpenWorkspace, onBuildLibrary,
}: {
  fileContext: FileContext;
  workspace?: PluginWorkspace | undefined;
  connected: boolean;
  savedConnection: string;
  connectionText: string;
  pairing: boolean;
  foundryOrigin: string;
  onFoundryOriginChange: (origin: string) => void;
  busy: boolean;
  nativeBusy: boolean;
  recovery: boolean;
  unitConflictCount: number;
  savedConcept: boolean;
  formsReady: boolean;
  formCount: number;
  hasBundle: boolean;
  library: string;
  libraryCompatible: boolean;
  nativeIssue: string;
  onStartPairing: () => void;
  onCancelPairing: () => void;
  onConnectionCodeChange: (code: string) => void;
  onPullRemote: () => void;
  onForgetConnection: () => void;
  onOpenSnapshot: () => void;
  onOpenTokenForms: () => void;
  onDownloadForms: () => void;
  onOpenWorkspace: () => void;
  onBuildLibrary: () => void;
}) {
  const [originDraft, setOriginDraft] = useState(foundryOrigin);
  const canOpenSnapshot = !busy && !recovery && !unitConflictCount && !savedConcept && workspace?.role !== 'concept';

  return <section className="plugin-section" aria-label="Workspace">
    <Card
      as="section"
      aria-label="Workspace connection"
      variant="outlined"
      headline={workspace ? 'Connected workspace' : 'Connect to Foundry'}
      supporting={
        workspace
          ? `${workspace.name} · ${workspace.role === 'library' ? 'Library' : 'Concept'} · ${connected ? 'Connected' : 'Paused'}`
          : savedConnection
            ? `Saved link to ${savedConnection}. Reconnect to resume syncing.`
            : 'Link this Figma file to a Foundry workspace to sync token edits.'
      }
      actions={<>
        {!connected && (
          pairing
            ? <Button variant="text" onClick={onCancelPairing}>Cancel pairing</Button>
            : <Button disabled={!fileContext.id || nativeBusy} onClick={onStartPairing}>Connect workspace</Button>
        )}
        {workspace && <Button variant="outlined" onClick={onOpenWorkspace}>Open workspace in Foundry</Button>}
        {savedConnection && (
          <Button variant="text" disabled={nativeBusy} onClick={onForgetConnection}>Forget connection</Button>
        )}
      </>}
    >
      {pairing && <p className="copy-small tone-supporting">Approve the pairing request in Foundry to finish connecting.</p>}
    </Card>

    <section className="plugin-group" aria-label="Manual link and files">
      <h3 className="plugin-section-heading">Manual link and files</h3>
      <div className="plugin-card-group">
        <Disclosure label="Connect with a code">
          <div className="plugin-stack">
            <TextField
              label="Foundry connection code"
              disabled={nativeBusy}
              value={connectionText}
              onChange={event => onConnectionCodeChange(event.target.value)}
              supporting="Paste a pairing or connection code from Foundry → Figma → Manual connection."
            />
            <TextField
              label="Foundry URL"
              disabled={pairing || nativeBusy}
              value={originDraft}
              onChange={event => {
                setOriginDraft(event.target.value);
                onFoundryOriginChange(event.target.value);
              }}
              supporting="Origin opened by Connect workspace."
            />
            <div className="plugin-actions">
              <Button
                disabled={nativeBusy || recovery || !!unitConflictCount || !connectionText}
                onClick={onPullRemote}
              >
                {connected ? 'Pull source changes' : savedConnection ? 'Reconnect' : 'Connect'}
              </Button>
            </div>
            <Divider />
            <p className="copy-small tone-supporting code-text">Document ID: {fileContext.id || 'Unavailable'}</p>
            {fileContext.fileKey && <p className="copy-small tone-supporting code-text">File key: {fileContext.fileKey}</p>}
          </div>
        </Disclosure>

        <Disclosure label="Offline Figma snapshots and edits">
          <div className="plugin-stack">
            <p className="copy-small tone-supporting">Use Figma snapshot and edit files when working without a live connection.</p>
            <div className="plugin-actions">
              <Button variant="outlined" disabled={!canOpenSnapshot} onClick={onOpenSnapshot}>Open Figma snapshot…</Button>
              <Button variant="text" disabled={!formsReady} onClick={onOpenTokenForms}>Open token edit copy…</Button>
              {formCount > 0 && <Button variant="text" onClick={onDownloadForms}>Download token edits</Button>}
            </div>
          </div>
        </Disclosure>
      </div>
    </section>

    {hasBundle && library && workspace?.role !== 'concept' && (
      <Disclosure label="Library maintenance">
        <div className="plugin-stack">
          <p className="copy-small tone-supporting">
            {libraryCompatible ? 'Syncs Brand and Tone modes, Elevation effect styles, and Roboto preview text styles without modifying components.' : `Open the ${library} snapshot to sync library foundations.`}
          </p>
          <div className="plugin-actions">
            <Button
              variant="outlined"
              disabled={busy || recovery || !!unitConflictCount || !libraryCompatible || !!nativeIssue}
              onClick={onBuildLibrary}
            >
              Sync foundations
            </Button>
          </div>
        </div>
      </Disclosure>
    )}
  </section>;
}
