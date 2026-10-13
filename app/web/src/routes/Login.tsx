import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password, code);
      setPassword('');
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
      // A code is single-use, so a failed attempt always needs a fresh one.
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const field =
    'w-full rounded border border-[var(--rule)] bg-[var(--paper-sunk)] px-3 py-2 text-base outline-none focus:border-[var(--accent)]';

  return (
    <div className="flex h-full items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Second Brain</h1>

        <label className="block space-y-1">
          <span className="text-xs text-[var(--ink-dim)]">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={field}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-[var(--ink-dim)]">Authenticator code</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={`${field} font-mono tracking-widest`}
          />
        </label>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-[var(--accent)] px-3 py-2 font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Checking…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
