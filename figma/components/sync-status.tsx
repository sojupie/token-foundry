import type { ReactNode } from 'react';
import { DesktopCloud } from '../../editor/icons.tsx';
import { FigmaIcon } from '../../editor/service-icons.tsx';

function Indicator({ service, label, message, state, icon }: {
  service: string; label: string; message: string; state: 'good' | 'pending' | 'bad'; icon: ReactNode;
}) {
  return <span className="plugin-sync-status" data-service={service} data-status={state} title={`${label}\n${message}`}>
    {icon}<span className="plugin-status-light" aria-hidden="true" />
    <span className="sr-only">{label}. {message}</span>
  </span>;
}

export function SyncStatus({ hasFigma, hasSnapshot, connected, offline, busy, changed, forms, nativeAttention, sourceAttention }: {
  hasFigma: boolean; hasSnapshot: boolean; connected: boolean; offline: boolean; busy: boolean; changed: number; forms: number;
  nativeAttention: string; sourceAttention: boolean;
}) {
  const local = changed ? `${changed} local ${changed === 1 ? 'change' : 'changes'}` : forms ? 'Unfinished edits' : '';
  const nativeMessage = !hasFigma ? 'Waiting for Figma' : nativeAttention || (busy ? 'Syncing…' : local || (hasSnapshot ? 'Up to date' : 'Connected'));
  const nativeState = !hasFigma ? 'bad' : nativeAttention || busy || local ? 'pending' : 'good';
  const remoteMessage = offline ? 'Offline' : !connected ? busy ? 'Connecting…' : 'Not connected' :
    nativeAttention || sourceAttention ? 'Changes need review' : busy ? 'Syncing…' : local ? 'Changes waiting to sync' : 'Up to date';
  const remoteState = offline || !connected ? 'bad' : nativeAttention || sourceAttention || busy || local ? 'pending' : 'good';
  return <output className="plugin-sync-indicators" aria-live="polite">
    <Indicator service="figma" label="Figma" message={nativeMessage} state={nativeState} icon={<FigmaIcon filled />} />
    <Indicator service="workspace" label="Workspace" message={remoteMessage} state={remoteState} icon={<DesktopCloud aria-hidden="true" />} />
  </output>;
}
