import { useState } from 'react';
import { api } from '../lib/api.js';

// start-reachy.sh waits up to 20s for the daemon, 15s for Zenoh, then 45s for
// the UI — anything short of that gives up on a boot that is still healthy.
const BOOT_TIMEOUT_MS = 90_000;
const POLL_MS = 1500;

/**
 * Navbar button: boots the Friendly robot stack if it is down, then opens its
 * dashboard. The tab is opened synchronously on click — a window.open after an
 * await is a popup the browser blocks — and pointed at the UI once it answers.
 */
export default function FriendlyButton() {
  const [state, setState] = useState<'idle' | 'starting' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function launch(): Promise<void> {
    const tab = window.open('about:blank', '_blank');
    setState('starting');
    setError(null);
    try {
      let { status, port } = await api.friendlyStart();
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      while (status !== 'running') {
        if (status === 'stopped') throw new Error('launch script exited before the UI came up');
        if (Date.now() > deadline) throw new Error('Friendly did not come up in 90s');
        await new Promise((r) => setTimeout(r, POLL_MS));
        ({ status, port } = await api.friendlyStatus());
      }
      const dashboard = `http://localhost:${port}`;
      if (tab) tab.location.href = dashboard;
      else window.open(dashboard, '_blank');
      setState('idle');
    } catch (err) {
      tab?.close();
      setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <button
      type="button"
      disabled={state === 'starting'}
      onClick={() => void launch()}
      title={error ? `${error} — see app/data/friendly-launch.log` : 'Start the Friendly robot and open its dashboard'}
      className="px-2 py-1 rounded text-[var(--accent)] hover:text-[var(--paper)] hover:bg-[var(--accent)] disabled:text-[var(--ink-faint)] disabled:hover:bg-transparent"
    >
      {state === 'starting' ? 'Friendly: starting…' : state === 'error' ? 'Friendly: failed ↻' : 'Friendly'}
    </button>
  );
}
