import { CommandMenu } from '../../editor/command-bar.tsx';
import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitPullRequest } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@token-catalog/forge-react';
import { ActionDialog } from '@/components/ui/dialog';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import type { WorkspaceConnection, WorkspaceConnectorProps } from '../../editor/lib/connector.ts';
import { errorMessage, isRecord, isUnknownArray } from '../../lib/json.ts';
import { openWorkspace } from '../../lib/workspace.ts';
import { baseChanged, isSnapshot, repositoryName } from './contract.ts';

const staleRevision = Symbol('stale revision');
const sessionKey = ['github', 'session'] as const;

async function post(action: 'open' | 'propose', data: object): Promise<unknown> {
  const response = await fetch('/git/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    redirect: 'manual',
  });
  if (response.type === 'opaqueredirect' || response.status === 401) throw new Error('Your GitHub session needs to be renewed.');
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('The hosted Git service is unavailable or requires an invitation.');
  const payload: unknown = await response.json();
  if (!response.ok) {
    if (action === 'propose' && response.status === 409 && isRecord(payload) && payload['code'] === baseChanged) return staleRevision;
    throw new Error(isRecord(payload) && typeof payload['message'] === 'string' ? payload['message'] : 'The Git request failed.');
  }
  return payload;
}

async function openConnection(repository: string): Promise<WorkspaceConnection> {
  const response = await post('open', { repository });
  if (!isSnapshot(response) || response.repository !== repository) throw new Error('The repository snapshot could not be read.');
  return {
    workspace: openWorkspace(repository, response.files),
    refresh: () => openConnection(repository),
    submit: async (changes) => {
      const result = await post('propose', { repository, revision: response.revision, changes });
      if (result === staleRevision) return { status: 'stale' };
      if (!isRecord(result) || typeof result['url'] !== 'string') throw new Error('GitHub did not return a pull request.');
      const url = new URL(result['url']);
      const prefix = '/' + repository + '/pull/';
      if (url.origin !== 'https://github.com' || !url.pathname.startsWith(prefix) || !/^\d+$/u.test(url.pathname.slice(prefix.length))) {
        throw new Error('GitHub did not return a pull request.');
      }
      return { status: 'submitted', url: url.href };
    },
  };
}

type Session = { state: 'signed-out' } |
  { state: 'connected'; login: string; repositories: string[] } |
  { state: 'forbidden' };

async function getSession(signal: AbortSignal): Promise<Session> {
  const response = await fetch('/git/session', { redirect: 'manual', signal });
  if (response.type === 'opaqueredirect' || response.status === 401) return { state: 'signed-out' };
  if (response.status === 403) return { state: 'forbidden' };
  if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) {
    throw new Error('The hosted Git service is unavailable or requires an invitation.');
  }
  const data: unknown = await response.json();
  if (!isRecord(data) || typeof data['login'] !== 'string' || !isUnknownArray(data['repositories'])) {
    throw new Error('The GitHub session could not be read.');
  }
  const repositories = data['repositories'].filter((name): name is string => typeof name === 'string' && repositoryName.test(name));
  return { state: 'connected', login: data['login'], repositories };
}

export function OpenGitHub(props: WorkspaceConnectorProps) {
  const [queryClient] = useState(() => new QueryClient());
  return <QueryClientProvider client={queryClient}><GitHubConnector {...props} /></QueryClientProvider>;
}

function GitHubConnector({ disabled, connect, canReplace }: WorkspaceConnectorProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [preferredRepository, setPreferredRepository] = useState('');
  const [checkingSignIn, setCheckingSignIn] = useState(false);
  const signIn = useRef<Window | null>(null);
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  const { data: session, isPending, error: sessionError } = useQuery({
    queryKey: sessionKey,
    queryFn: ({ signal }) => getSession(signal),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { mutate: connectRepository, reset: resetConnection, isPending: busy, error } = useMutation({
    mutationFn: openConnection,
    networkMode: 'always',
  });

  useEffect(() => {
    function refresh(event: Event) {
      if (event.type === 'message' || signIn.current?.closed) {
        signIn.current = null;
        setCheckingSignIn(false);
      }
      void queryClient.cancelQueries({ queryKey: sessionKey }).then(() => queryClient.invalidateQueries({ queryKey: sessionKey }));
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('token-foundry-github');
    channel?.addEventListener('message', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      channel?.close();
      window.removeEventListener('focus', refresh);
    };
  }, [queryClient]);

  const connected = !sessionError && session?.state === 'connected' ? session : undefined;
  const repositories = connected?.repositories ?? [];
  const repository = repositories.includes(preferredRepository) ? preferredRepository : repositories[0] ?? '';
  function openRepository() {
    if (busy || !repository || !canReplace()) return;
    connectRepository(repository, { onSuccess: (connection) => {
      connect(connection);
      setOpen(false);
    } });
  }

  const unavailable = session?.state === 'forbidden' ? 'Your account does not have access to GitHub integration.' :
    connected && !repositories.length ? 'Your account has no repositories available in Token Foundry.' : undefined;
  return <>
    <CommandMenu label="Integrations" triggerRef={setOpener} status={connected ? 'GitHub connected as @' + connected.login : ''}
      sections={[[{ label: 'Open GitHub repository…', icon: <GitPullRequest aria-hidden="true" />, title: unavailable,
        disabled: disabled || Boolean(unavailable), run: () => { resetConnection(); setOpen(true); } }]]} />
    <ActionDialog open={open} busy={busy} opener={opener} onOpenChange={(next) => { if (!busy) setOpen(next); }}
      title="Open GitHub repository" description={connected ? 'Connected as @' + connected.login :
        'Sign in to see the repositories available to you.'}>
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); openRepository(); }}>
        {isPending && <output className="text-sm text-muted-foreground">Checking GitHub session…</output>}
        {sessionError && <Alert variant="destructive"><AlertDescription>{errorMessage(sessionError)}</AlertDescription></Alert>}
        {!sessionError && session?.state === 'signed-out' && <ButtonLink variant="outlined" className="justify-self-start" href="/git/sign-in" target="_blank" rel="noreferrer" onClick={(event) => {
            const popup = window.open('/git/sign-in', 'token-foundry-sign-in', 'popup,width=620,height=720');
            if (popup) {
              event.preventDefault();
              popup.opener = null;
              signIn.current = popup;
              setCheckingSignIn(true);
            }
          }}>{checkingSignIn ? 'Continue in GitHub' : 'Sign in to GitHub'}</ButtonLink>}
        {connected && (repositories.length ? <div className="grid gap-2">
          <label htmlFor="git-repository" className="text-sm font-medium">Repository</label>
          <NativeSelect id="git-repository" value={repository} onChange={(event) => setPreferredRepository(event.target.value)} disabled={busy}>
            {repositories.map((name) => <NativeSelectOption key={name} value={name}>{name}</NativeSelectOption>)}
          </NativeSelect>
        </div> : <p className="text-sm text-muted-foreground">No configured repositories are available to this GitHub account.</p>)}
        {error && <Alert variant="destructive"><AlertDescription>{errorMessage(error)}</AlertDescription></Alert>}
        {connected && repositories.length > 0 && <div className="flex justify-end">
          <Button type="submit" disabled={busy || !repository}>{busy ? 'Opening…' : 'Open repository'}</Button>
        </div>}
      </form>
    </ActionDialog>
  </>;
}
