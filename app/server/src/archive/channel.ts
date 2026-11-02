/**
 * Where a session's prompts came from, when not a keyboard: the `channel` label on
 * archive_sessions.meta (vault: telegram-sessions-on-usage-plan.md). Claude Code's channel
 * plugins wrap each incoming message in a `<channel source="plugin:telegram:telegram" …>` tag;
 * Hermes and zen-agent say it in their own metadata. Pure: no database, no IO.
 *
 * The label keeps the channel name and the sender's handle. Chat ids, user ids and message
 * ids stay out of it (privacy.md): they identify a person's account, not where the chat ran.
 */
export type Channel = 'telegram' | 'web' | 'remote-control';

export interface ChannelTag { channel: Channel; handle: string | null }

/** Session meta keys the channel label uses, written by every collector the same way. */
export interface ChannelMeta { channel: Channel; channel_handle?: string | null; channel_bot?: string | null }

const TAG_RE = /^\s*<channel\s([^>]*)>\s*\n?/;
const CLOSE_RE = /\s*<\/channel>\s*$/;

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([a-z_]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/** The channel a Claude Code prompt's text came through, from its leading `<channel …>` tag; null when it was typed. */
export function parseChannelTag(text: string): ChannelTag | null {
  const m = TAG_RE.exec(text);
  if (!m) return null;
  const a = attrs(m[1]!);
  const source = (a.source ?? '').split(':');
  // plugin:<plugin name>:<channel name>; the plugin name is enough when the two match.
  const name = source[2] ?? source[1] ?? '';
  if (name !== 'telegram') return null;
  return { channel: 'telegram', handle: a.user ? `@${a.user.replace(/^@/, '')}` : null };
}

/** The prompt as the person wrote it: the `<channel …>` wrapper removed. */
export function stripChannelTag(text: string): string {
  if (!TAG_RE.test(text)) return text;
  return text.replace(TAG_RE, '').replace(CLOSE_RE, '');
}

/**
 * A user record Claude Code writes for a slash command run at the keyboard (`/clear`, `/compact`)
 * or the note about one, not something the person asked. They start the daily session of a bot
 * that is cleared every night, so they must not become its title.
 */
export function isLocalCommandText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<command-name>') || t.startsWith('<local-command-caveat>') || t.startsWith('<local-command-stdout>')
    || t.startsWith('<command-message>');
}

/** The channel of a zen-agent run from its trace's dispatch labels (`--meta channel=telegram`) or a `telegram` wake reason. */
export function zenChannel(dispatch: Record<string, unknown>, reasons: Array<{ reason: string | null }>): Channel | null {
  const c = dispatch.channel;
  if (c === 'telegram' || c === 'web' || c === 'remote-control') return c;
  return reasons.some((r) => r.reason === 'telegram') ? 'telegram' : null;
}

/** The channel of a Hermes session from its `sessions.source` column. */
export function hermesChannel(source: unknown): Channel | null {
  if (source === 'telegram') return 'telegram';
  if (source === 'api_server') return 'web';
  return null;
}
