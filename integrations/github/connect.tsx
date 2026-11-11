import { useState } from 'react';
import { GitPullRequest } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { WorkspaceConnectorProps } from '../../editor/lib/connector.ts';
import { errorMessage, isRecord } from '../../lib/json.ts';
import { openWorkspace } from '../../lib/workspace.ts';
import { isSnapshot, repositoryName } from './contract.ts';

async function post(action: 'open' | 'propose', data: object): Promise<unknown> {
  const response = await fetch('/git/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    redirect: 'manual',
  });
  if (response.type === 'opaqueredirect' || response.status === 401) throw new Error('Sign in to GitHub in the new tab, then try again.');
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('The hosted Git service is unavailable or requires an invitation.');
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(isRecord(payload) && typeof payload['message'] === 'string' ? payload['message'] : 'The Git request failed.');
  }
  return payload;
}

export function OpenGitHub({ disabled, connect, canReplace }: WorkspaceConnectorProps) {
  const [open, setOpen] = useState(false);
  const [repository, setRepository] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function openRepository() {
    if (busy || !canReplace()) return;
    setError('');
    const name = repository.trim();
    if (!repositoryName.test(name)) {
      setError('Enter the repository as owner/name.');
      return;
    }
    setBusy(true);
    try {
      const response = await post('open', { repository: name });
      if (!isSnapshot(response) || response.repository !== name) throw new Error('The repository snapshot could not be read.');
      const workspace = openWorkspace(response.repository, response.files);
      connect(workspace, async (changes) => {
        const result = await post('propose', { repository: response.repository, revision: response.revision, changes });
        if (!isRecord(result) || typeof result['url'] !== 'string') throw new Error('GitHub did not return a pull request.');
        const url = new URL(result['url']);
        const prefix = '/' + response.repository + '/pull/';
        if (url.origin !== 'https://github.com' || !url.pathname.startsWith(prefix) || !/^\d+$/u.test(url.pathname.slice(prefix.length))) {
          throw new Error('GitHub did not return a pull request.');
        }
        return url.href;
      });
      setOpen(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open={open} onOpenChange={(next) => {
    if (!busy) {
      setError('');
      setOpen(next);
    }
  }}>
    <DialogTrigger asChild>
      <Button type="button" size="sm" variant="ghost" disabled={disabled}><GitPullRequest aria-hidden="true" /> GitHub</Button>
    </DialogTrigger>
    <DialogContent showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>Open GitHub repository</DialogTitle>
        <DialogDescription>Hosted Git is available by invitation. Sign in before opening a connected repository.</DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void openRepository(); }}>
        <Button asChild variant="outline" className="justify-self-start">
          <a href="/git/sign-in" target="_blank" rel="noreferrer">Sign in to GitHub (new tab)</a>
        </Button>
        <div className="grid gap-2">
          <Label htmlFor="git-repository">Repository</Label>
          <Input id="git-repository" value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="owner/name" disabled={busy} required />
        </div>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter><Button type="submit" disabled={busy}>{busy ? 'Opening…' : 'Open repository'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
