import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type VoiceStatus } from '../lib/api.js';

/**
 * Top-nav switch for this Mac: when on, Claude Code says a one-line summary out
 * loud after any task that ran longer than the threshold. The Stop hook
 * (.agents/skills/speak/scripts/claude_stop_speak.py) reads the same settings
 * file this writes, so the change applies to the next task without a restart.
 * The dot shows whether the local voice server is up.
 */
export default function VoiceToggle() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['voice'], queryFn: api.voiceStatus, refetchInterval: 60_000, retry: false });
  const change = useMutation({
    mutationFn: api.setVoiceSettings,
    onSuccess: ({ settings }) =>
      queryClient.setQueryData<VoiceStatus>(['voice'], (old) => (old ? { ...old, settings } : old)),
  });

  // Anything but a real answer (a server deployment, an odd proxy reply) hides the switch.
  const s = status.data?.settings ? status.data : undefined;
  if (status.isError || (status.isSuccess && !s)) return null;
  const on = s?.settings.autoSpeak ?? false;
  const minutes = s ? Math.round(s.settings.minTaskSeconds / 60) : 2;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={!s || change.isPending}
      onClick={() => change.mutate({ autoSpeak: !on })}
      title={
        `Claude Code speaks when a task longer than ${minutes} min finishes on this Mac. ` +
        (s?.server.up ? 'Voice server running.' : 'Voice server is down (launchd com.argo.tts).')
      }
      className="flex items-center gap-1.5 text-xs text-[var(--ink-dim)] hover:text-[var(--ink)]"
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: s?.server.up ? 'var(--hermes)' : 'var(--ink-faint)' }}
      />
      Voice
      <span
        className={`rounded border border-[var(--rule)] px-1.5 py-0.5 ${on ? 'text-white' : ''}`}
        style={on ? { background: 'var(--claude)' } : undefined}
      >
        {on ? 'on' : 'off'}
      </span>
    </button>
  );
}
