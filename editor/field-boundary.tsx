import { Component, createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@token-catalog/forge-react';

export const ReloadEditor = createContext<(() => Promise<boolean>) | undefined>(undefined);

function FieldFailure() {
  const reload = useContext(ReloadEditor);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div role="alert" className="grid gap-space100">
    <p className="copy-body">The value editor could not open. Reload to try again. Your current work will be saved in this browser first.</p>
    {failed && <p className="copy-small">Recovery could not be saved. Download a recovery copy before reloading.</p>}
    <Button type="button" variant="outlined" disabled={!reload || busy} onClick={() => {
      if (!reload) return;
      setBusy(true);
      void reload().then(saved => { if (!saved) { setFailed(true); setBusy(false); } return undefined; });
    }}>Reload editor</Button>
  </div>;
}

export class FieldBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <FieldFailure /> : this.props.children; }
}
