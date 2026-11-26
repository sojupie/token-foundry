import { useCallback, useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Button, Card, Snackbar } from '@token-catalog/forge-react';
import { ActionDialog } from './components/ui/dialog.tsx';
import { Alert, AlertDescription } from './components/ui/alert.tsx';
import { errorMessage } from '../lib/json.ts';
import { download } from './lib/sources.ts';
import { deleteRecovery, listRecovery, readRecoveryExport, recoveryExport, saveRecovery } from './lib/recovery.ts';
import type { RecoveryRecord, RecoveryWork } from './lib/recovery.ts';
import { sameSourceValue } from '../integrations/figma/contract.ts';
import { clearActiveRecovery, rememberActiveRecovery } from './lib/workspace-location.ts';

export interface StartupWorkspace { workspace: string; record?: string | undefined; valid: () => boolean; done: () => void; cancel: () => void }

export interface RecoveryStatus { id: string; state: 'saving' | 'saved' | 'failed' }
export interface RecoveryHandle {
  flush: () => Promise<boolean>;
  remove: (targetId: string) => Promise<void>;
  removeShared: (sharedId: string) => Promise<void>;
}
export function WorkspaceRecovery({ ref, id, work, enabled, open, setOpen, resume, canReplace, reportStatus, showOnStart = true, startup, statusNotice = '', clearStatusNotice }: {
  ref?: Ref<RecoveryHandle>;
  id: string; work: RecoveryWork; enabled: boolean; open: boolean; setOpen: (value: boolean) => void;
  resume: (record: RecoveryRecord) => void; canReplace: (proceed: () => void, cancel?: () => void) => void;
  reportStatus: (status: RecoveryStatus) => void;
  showOnStart?: boolean;
  startup?: StartupWorkspace | undefined;
  statusNotice?: string;
  clearStatusNotice?: () => void;
}) {
  const activeId = useRef(id);
  useLayoutEffect(() => { activeId.current = id; }, [id]);
  const startupPending = useRef(false);
  const [initialScope, setInitialScope] = useState<{ workspace: string; record: string }>();
  const versions = useRef(new Map<string, number>());
  const saved = useRef(new Map<string, string>());
  const queue = useRef(Promise.resolve());
  const failed = useRef(new Set<string>());
  const notified = useRef(new Set<string>());
  const upload = useRef<HTMLInputElement>(null);
  const [records, setRecords] = useState<RecoveryRecord[]>([]);
  const [problem, setProblem] = useState<{ id?: string; message: string }>();
  const [notice, setNotice] = useState<{ id: string; message: string }>();
  const [dismissedError, setDismissedError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const error = problem && (problem.id === undefined || problem.id === id) ? problem.message : '';
  const visibleRecords = useMemo(
    () => records.filter(record => !initialScope || record.shared?.id === initialScope.workspace && record.id === initialScope.record),
    [initialScope, records],
  );
  const serialized = useMemo(() => JSON.stringify(work), [work]);
  const initialRecovery = useEffectEvent((values: RecoveryRecord[]) => {
    if (startup && !startup.valid()) { startup.done(); return; }
    const preferred = startup ? values.find(record => record.id === startup.record && record.shared?.id === startup.workspace) : undefined;
    if (preferred && showOnStart) {
      const unfinished = !!preferred.editor || !!preferred.repositoryReview || !sameSourceValue(preferred.files, preferred.shared?.accepted.files);
      if (unfinished && startup) { startupPending.current = true; setInitialScope({ workspace: startup.workspace, record: preferred.id }); setOpen(true); }
      else restore(preferred);
    } else {
      if (!startup && values.length && showOnStart) setOpen(true);
      startup?.done();
    }
  });
  useEffect(() => {
    let active = true;
    void listRecovery().then(values => { if (active) { setRecords(values); initialRecovery(values); } return undefined; }, (failure: unknown) => { if (active) { setProblem({ message: errorMessage(failure) }); startup?.done(); } return undefined; });
    return () => { active = false; };
  }, [setOpen, showOnStart, startup]);
  const persist = useCallback(() => {
    queue.current = queue.current.then(async () => {
      if (failed.current.has(id) || saved.current.get(id) === serialized) return undefined;
      reportStatus({ id, state: 'saving' });
      try {
        const record = await saveRecovery(id, versions.current.get(id) ?? 0, work);
        if (activeId.current === id) rememberActiveRecovery(id);
        versions.current.set(id, record.revision); saved.current.set(id, serialized);
        setRecords(values => [record, ...values.filter(value => value.id !== id)]);
        reportStatus({ id, state: 'saved' });
        if (!notified.current.has(id)) { notified.current.add(id); setNotice({ id, message: 'Local recovery copy saved in this browser.' }); }
      } catch (failure) { failed.current.add(id); setProblem({ id, message: errorMessage(failure) }); reportStatus({ id, state: 'failed' }); }
      return undefined;
    });
    return queue.current.then(() => saved.current.get(id) === serialized && !failed.current.has(id));
  }, [id, reportStatus, serialized, work]);
  useEffect(() => {
    if (enabled || versions.current.has(id)) void persist();
  }, [enabled, id, persist]);
  const eraseRecords = useCallback(async (targetIds: readonly string[]) => {
    const unique = [...new Set(targetIds)];
    if (!unique.length) return undefined;
    await Promise.all(unique.map(targetId => deleteRecovery(targetId)));
    for (const targetId of unique) {
      versions.current.delete(targetId);
      saved.current.delete(targetId);
      failed.current.delete(targetId);
      notified.current.delete(targetId);
      clearActiveRecovery(targetId);
    }
    const drop = new Set(unique);
    setRecords(values => values.filter(value => !drop.has(value.id)));
    return undefined;
  }, []);
  const remove = useCallback((targetId: string) => {
    const operation = queue.current.then(() => eraseRecords([targetId]));
    queue.current = operation.catch(() => undefined);
    return operation;
  }, [eraseRecords]);
  const removeShared = useCallback((sharedId: string) => {
    const operation = queue.current.then(async () => {
      const existing = await listRecovery().catch(() => []);
      return eraseRecords(existing.filter(value => value.shared?.id === sharedId).map(value => value.id));
    });
    queue.current = operation.catch(() => undefined);
    return operation;
  }, [eraseRecords]);
  useImperativeHandle(ref, () => ({ flush: persist, remove, removeShared }), [persist, remove, removeShared]);
  function restore(record: RecoveryRecord, imported = false) {
    canReplace(() => {
      const next = imported ? { ...record, id: crypto.randomUUID(), revision: 0, updated: Date.now() } : record;
      try {
        resume(next);
        rememberActiveRecovery(next.id);
        versions.current.set(next.id, next.revision); failed.current.delete(next.id); setProblem(undefined);
        if (!imported) {
          const signature = JSON.stringify({ name: next.name, files: next.files, baseline: next.baseline, folder: next.folder, ...(next.github ? { github: next.github } : {}), ...(next.editor ? { editor: next.editor } : {}),
            ...(next.repositoryReview ? { repositoryReview: next.repositoryReview } : {}), ...(next.shared ? { shared: next.shared } : {}) });
          saved.current.set(next.id, signature); notified.current.add(next.id); reportStatus({ id: next.id, state: 'saved' });
        }
        setOpen(false);
        startupPending.current = false; setInitialScope(undefined); startup?.done();
      } catch (failure) { setProblem({ id, message: errorMessage(failure) }); if (!startupPending.current) startup?.done(); }
    }, () => { if (startup?.valid()) startup.cancel(); });
  }
  const hasRecoveryError = !!error && dismissedError !== error;
  const hasRecoveryNotice = notice?.id === id;
  const snackbarMessage = hasRecoveryError ? error : statusNotice || (hasRecoveryNotice ? notice.message : '');
  const snackbarOpen = hasRecoveryError || !!statusNotice || hasRecoveryNotice;
  const snackbarPersistent = hasRecoveryError || (!hasRecoveryError && statusNotice.includes('Reopen the original folder'));
  return <>
    <Snackbar open={snackbarOpen} message={snackbarMessage} duration={snackbarPersistent ? 0 : 6000}
      onOpenChange={shown => {
        if (shown) return;
        if (hasRecoveryError) setDismissedError(error);
        else {
          clearStatusNotice?.();
          if (hasRecoveryNotice) setNotice(undefined);
        }
      }}
      action={hasRecoveryError && <Button variant="text" data-snackbar-action="" onClick={() => download('foundry-recovery.json', recoveryExport({ ...work, id, revision: Math.max(1, versions.current.get(id) ?? 0), updated: Date.now() }), 'application/json')}>Download recovery copy</Button>} />
    <ActionDialog open={open} onOpenChange={shown => { setOpen(shown); if (!shown) setConfirmClear(false); if (!shown && startupPending.current) { startupPending.current = false; setInitialScope(undefined); startup?.done(); } }} title="Recover local work"
      description="Resume unsaved source edits and open forms. GitHub merge requests and folder saves are stored separately."
      actions={<Button variant="text" data-dialog-close="">Done</Button>}>
      <div className="stack-lg">
        <div className="flex flex-wrap items-center gap-space100">
          <Button variant="outlined" onClick={() => upload.current?.click()}>Open recovery copy…</Button>
          {visibleRecords.length > 1 && (
            <Button variant="text" onClick={() => setConfirmClear(true)}>Clear all</Button>
          )}
          <input ref={upload} hidden type="file" accept=".json" aria-label="Recovery copy" onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
            if (file.size > 128 * 1024 * 1024) { setProblem({ id, message: 'The recovery copy exceeds the 128 MB limit.' }); return; }
            void file.text().then(text => { restore(readRecoveryExport(text), true); return undefined; }, (failure: unknown) => { setProblem({ id, message: errorMessage(failure) }); return undefined; })
              .catch((failure: unknown) => setProblem({ id, message: errorMessage(failure) }));
          }} />
        </div>
        {confirmClear && (
          <Card variant="outlined" as="section" aria-label="Confirm clearing local work" headline="Clear all saved local work?" headlineAs="h3"
            supporting={`Remove all ${visibleRecords.length} saved drafts from this browser? Active unsaved changes in another open tab are unaffected.`}
            actions={<>
              <Button variant="text" onClick={() => setConfirmClear(false)}>Cancel</Button>
              <Button onClick={() => {
                const targetIds = visibleRecords.map(record => record.id);
                const operation = queue.current.then(() => eraseRecords(targetIds));
                queue.current = operation.catch(() => undefined);
                void operation
                  .then(() => { setConfirmClear(false); setProblem(undefined); return undefined; })
                  .catch((failure: unknown) => setProblem({ id, message: errorMessage(failure) }));
              }}>Clear all local work</Button>
            </>} />
        )}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <ul className="card-group">{visibleRecords.map(record => (
          <li key={record.id}>
            <Card variant="outlined" headline={record.name} headlineAs="h3"
              supporting={`${new Date(record.updated).toLocaleString()} · ${record.files.length} source ${record.files.length === 1 ? 'file' : 'files'}${record.github?.branch ? ' · Merge request draft' : ''}`}
              actions={<>
                <Button onClick={() => restore(record)}>Resume source edits</Button>
                <Button variant="text" onClick={() => download('foundry-recovery.json', recoveryExport(record), 'application/json')}>Download copy</Button>
                <Button variant="text" aria-label={`Remove ${record.name} from ${new Date(record.updated).toLocaleString()}`} onClick={() => {
                  void remove(record.id).catch((failure: unknown) => setProblem({ id, message: errorMessage(failure) }));
                }}>Remove</Button>
              </>}
            />
          </li>
        ))}</ul>
        {!visibleRecords.length && <p className="copy-body tone-supporting">No saved source edits in this browser.</p>}
      </div>
    </ActionDialog>
  </>;
}
