import type { ReactNode } from 'react';
import type { AssignmentState, Reason } from './api.js';

/** Small shared pieces of the skills pages: status chips, digests, loading/error/empty states. */

export const input = 'min-h-9 rounded border border-[var(--rule)] bg-transparent px-2 py-1 text-sm';
export const button = 'min-h-9 rounded border border-[var(--rule)] px-3 py-1 text-sm hover:bg-[var(--paper-sunk)] disabled:opacity-50';
export const primary = 'min-h-9 rounded bg-[var(--accent)] px-3 py-1 text-sm font-medium text-white disabled:opacity-50';

export function Loading({ what }: { what: string }) {
  return <p role="status" className="p-4 text-sm text-[var(--ink-dim)]">Loading {what}…</p>;
}

export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div role="alert" className="m-4 rounded border border-[var(--warn)] p-3 text-sm">
      <p>Could not load: {error.message}</p>
      {retry && <button type="button" className={`${button} mt-2`} onClick={retry}>Try again</button>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded border border-dashed border-[var(--rule)] p-4 text-sm text-[var(--ink-dim)]">{children}</p>;
}

export function Chip({ children, tone = 'dim', title }: { children: ReactNode; tone?: 'dim' | 'ok' | 'warn' | 'bad' | 'accent'; title?: string }) {
  const colour = {
    dim: 'border-[var(--rule)] text-[var(--ink-dim)]',
    ok: 'border-green-600 text-green-700 dark:text-green-400',
    warn: 'border-amber-500 text-amber-700 dark:text-amber-400',
    bad: 'border-[var(--warn)] text-[var(--warn)]',
    accent: 'border-[var(--accent)] text-[var(--accent)]',
  }[tone];
  return <span title={title} className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${colour}`}>{children}</span>;
}

/** `sha256:abcd…` shortened, the full value on hover and for copy. */
export function Digest({ value }: { value: string | null }) {
  if (!value) return <span className="text-xs text-[var(--ink-faint)]">no digest</span>;
  const hex = value.replace(/^sha256:/, '');
  return <code title={value} className="text-xs">{hex.slice(0, 12)}</code>;
}

export function Revision({ revision, dirty }: { revision: string | null; dirty: boolean | null }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      {revision ? <code title={revision}>{revision.slice(0, 8)}</code> : <span className="text-[var(--ink-faint)]" title="Not in Git, or not committed">no revision</span>}
      {dirty === true && <Chip tone="warn" title="Uncommitted changes in this package">uncommitted</Chip>}
      {dirty === null && <span className="text-[var(--ink-faint)]" title="Git status is not available">(Git unknown)</span>}
    </span>
  );
}

export const STATE_LABEL: Record<AssignmentState, string> = {
  assigned: 'Assigned', denied: 'Denied', 'not-assigned': 'Not assigned', unavailable: 'Assigned but unavailable', legacy: 'Visible (no policy)',
};
export const STATE_GLYPH: Record<AssignmentState, string> = { assigned: '●', denied: '✕', 'not-assigned': '·', unavailable: '!', legacy: '○' };
export const STATE_TONE: Record<AssignmentState, 'ok' | 'bad' | 'dim' | 'warn' | 'accent'> = {
  assigned: 'ok', denied: 'bad', 'not-assigned': 'dim', unavailable: 'warn', legacy: 'accent',
};

export function StateChip({ state }: { state: AssignmentState }) {
  return <Chip tone={STATE_TONE[state]}>{STATE_GLYPH[state]} {STATE_LABEL[state]}</Chip>;
}

export function Reasons({ reasons }: { reasons: Reason[] }) {
  if (!reasons.length) return <span className="text-xs text-[var(--ink-faint)]">No rule names this skill.</span>;
  return (
    <ul className="space-y-0.5 text-xs">
      {reasons.map((r, i) => (
        <li key={i}>
          <span className={r.kind === 'deny' ? 'text-[var(--warn)]' : r.kind === 'grant' ? 'text-green-700 dark:text-green-400' : 'text-[var(--ink-dim)]'}>
            {r.kind === 'grant' ? 'grant' : r.kind === 'deny' ? 'deny' : 'note'}
          </span>{' '}
          <span className="text-[var(--ink-dim)]">({r.level})</span> {r.detail}
        </li>
      ))}
    </ul>
  );
}

export function lifecycleTone(status: string): 'ok' | 'warn' | 'bad' | 'dim' {
  return status === 'active' ? 'ok' : status === 'deprecated' ? 'warn' : status === 'disabled' ? 'bad' : 'dim';
}
