import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';

function timeAgo(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Header chip: this machine's vault sync (secondbrain-vault sync). "synced 12m ago" when the
 * last run pushed and pulled; the problem in red when it stopped on a conflict, refused a
 * commit or cannot push. Hidden where no sync is installed, so a fresh install shows nothing.
 */
export default function SyncChip() {
  const q = useQuery({ queryKey: ['sync-state'], queryFn: api.syncState, refetchInterval: 60_000, retry: false });
  const s = q.data;
  if (!s || !s.installed) return null;

  let label: string;
  let bad = false;
  switch (s.last_result) {
    case 'conflict':
      label = `sync: conflict (${s.conflict_files.length})`;
      bad = true;
      break;
    case 'refused':
      label = 'sync: refused a commit';
      bad = true;
      break;
    case 'push-failed':
      label = 'sync: cannot push';
      bad = s.push_failures >= 3;
      break;
    case 'error':
      label = 'sync: error';
      bad = true;
      break;
    case 'offline':
      label = s.last_success ? `sync: offline, last ${timeAgo(s.last_success)}` : 'sync: offline';
      break;
    default:
      label = s.last_success ? `synced ${timeAgo(s.last_success)}` : 'sync: never succeeded';
  }
  if (!bad && s.last_result === 'ok' && s.ahead > 0) label += `, ${s.ahead} to push`;

  const title = [
    `${s.machine} (${s.role}, conflicts: ${s.policy})`,
    s.last_run ? `last run: ${new Date(s.last_run).toLocaleString()} (${s.last_result ?? '?'})` : 'never ran',
    s.last_success ? `last success: ${new Date(s.last_success).toLocaleString()}` : 'no successful sync yet',
    `${s.ahead} ahead, ${s.behind} behind`,
    s.last_error ? `problem: ${s.last_error}` : null,
    s.conflict_files.length ? `conflict: ${s.conflict_files.join(', ')}` : null,
    'secondbrain-vault sync status',
  ].filter(Boolean).join('\n');

  return (
    <div
      className={`shrink-0 whitespace-nowrap border-l border-[var(--rule)] pl-3 text-xs ${bad ? 'text-red-600' : 'text-[var(--ink-dim)]'}`}
      title={title}
      aria-label={`Vault sync. ${title}`}
    >
      {label}
    </div>
  );
}
