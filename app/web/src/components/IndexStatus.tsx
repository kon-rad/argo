import { useVaultScan } from '../lib/useVaultScan.js';

function timeAgo(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Navbar chip: age of the vault index, with a one-click rescan. */
export default function IndexStatus() {
  const { vault, running, busy, rescan } = useVaultScan();

  if (!vault) return null;

  const lastOk = vault.last_run?.status === 'ok' ? vault.last_run.finished_at : null;
  const label = running
    ? 'scanning…'
    : vault.last_run?.status === 'error'
      ? 'last scan failed'
      : lastOk
        ? `index ${timeAgo(lastOk)}`
        : 'never scanned';

  return (
    <div
      className="flex items-center gap-1.5 whitespace-nowrap text-[var(--ink-dim)]"
      title={lastOk ? `last successful scan: ${new Date(lastOk).toLocaleString()}` : undefined}
    >
      <span>{label}</span>
      <button
        type="button"
        disabled={busy}
        onClick={rescan}
        title="Rescan the vault now"
        aria-label="Rescan the vault now"
        className="rounded border border-[var(--rule)] px-1.5 py-0.5 hover:bg-[var(--paper-sunk)] disabled:text-[var(--ink-faint)]"
      >
        ↻
      </button>
    </div>
  );
}
