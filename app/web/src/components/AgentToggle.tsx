import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type TelegramStatus } from '../lib/api.js';

/**
 * Top-nav switch: the default agent (Claude Code or Hermes) for new chats and tasks, and a dot per Telegram bot.
 * Claude Code answers on its own Telegram bot and Hermes on another, so this
 * never moves Telegram traffic or restarts Hermes. Hidden where there is no agent-hub (the Mac).
 */
export default function AgentToggle() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['telegram'],
    queryFn: api.telegram,
    refetchInterval: 30_000,
    retry: (n, err) => !(err instanceof ApiError && err.status === 503) && n < 2,
  });
  const change = useMutation({
    mutationFn: api.setTelegram,
    onSuccess: (s) => queryClient.setQueryData(['telegram'], s),
  });

  if (status.error instanceof ApiError && status.error.status === 503) return null;
  const s = status.data;
  const busy = change.isPending;

  return (
    <div className="flex items-center gap-2 text-xs" title="Default agent for new chats and tasks">
      <span className="text-[var(--ink-dim)]">Agent</span>
      <div className="flex overflow-hidden rounded border border-[var(--rule)]" role="radiogroup" aria-label="Default agent">
        {(['claude', 'hermes'] as const).map((agent) => (
          <button
            key={agent}
            type="button"
            role="radio"
            aria-checked={s?.default === agent}
            disabled={!s || busy}
            onClick={() => change.mutate({ default: agent })}
            className={`px-2 py-0.5 ${s?.default === agent ? 'text-white' : 'text-[var(--ink-dim)] hover:text-[var(--ink)]'}`}
            style={s?.default === agent ? { background: `var(--${agent})` } : undefined}
          >
            {agent === 'claude' ? 'Claude' : 'Hermes'}
          </button>
        ))}
      </div>
      {s && <BotDots s={s} onClaude={(on) => change.mutate({ claude: on ? 'on' : 'off' })} busy={busy} />}
      {(status.isError || change.isError) && (
        <span className="text-[var(--warn)]" title={(change.error ?? status.error)?.message}>⚠</span>
      )}
    </div>
  );
}

function BotDots({ s, onClaude, busy }: { s: TelegramStatus; onClaude: (on: boolean) => void; busy: boolean }) {
  const dot = (on: boolean) => (
    <span className="inline-block h-2 w-2 rounded-full" style={{ background: on ? 'var(--hermes)' : 'var(--ink-faint)' }} />
  );
  return (
    <span className="flex items-center gap-2 text-[var(--ink-dim)]">
      <button
        type="button"
        disabled={busy || !s.claude_bot_configured}
        onClick={() => {
          if (!s.claude_running || window.confirm('Stop Claude Code on Telegram?')) onClaude(!s.claude_running);
        }}
        className="flex items-center gap-1 hover:text-[var(--ink)]"
        title={s.claude_running ? 'Claude Code is answering on Telegram. Click to stop it.' : 'Claude Code is off on Telegram. Click to start it.'}
      >
        {dot(s.claude_running)} TG Claude
      </button>
      <span className="flex items-center gap-1" title={s.hermes_running ? 'Hermes gateway running' : 'Hermes gateway stopped'}>
        {dot(s.hermes_running)} TG Hermes
      </span>
    </span>
  );
}
