import { settings, type TelegramBotSetting } from '../settings.js';
import type { Channel, ChannelMeta, ChannelTag } from './channel.js';
import type { ClaudeChunk } from './claude.js';

type Agent = 'claude-code' | 'hermes' | 'zen-agent';

/** The configured bot (secondbrain.json `telegram.bots`) a session on `agent` belongs to; `hint` is a bot name or a Hermes profile. */
export function telegramBot(agent: Agent, hint: string | null | undefined): TelegramBotSetting | null {
  const mine = settings().telegram.bots.filter(b => b.agent === agent);
  if (hint) {
    const matches = mine.filter(b => b.name === hint || b.username?.replace(/^@/, '') === hint.replace(/^@/, '')
      || agent === 'hermes' && b.profile === hint);
    return matches.length === 1 ? matches[0]! : null;
  }
  return mine.length === 1 ? mine[0]! : null;
}

export function telegramBotName(agent: Agent, hint: string | null | undefined): string | null {
  return telegramBot(agent, hint)?.name ?? null;
}

/**
 * The session-meta keys for a channel label, the same from every collector: `channel`, the sender's
 * handle when the harness gives one, and the configured bot's name. `{}` when the session was typed.
 */
export function channelMeta(tag: ChannelTag | Channel | null, agent: Agent, hint?: string | null): Record<string, unknown> {
  if (!tag) return {};
  const channel = typeof tag === 'string' ? tag : tag.channel;
  const handle = typeof tag === 'string' ? null : tag.handle;
  const out: ChannelMeta = { channel };
  if (handle) out.channel_handle = handle;
  if (channel === 'telegram') {
    const bot = telegramBot(agent, hint ?? (typeof tag === 'string' ? null : tag.bot));
    // Explicit nulls clear stale guesses during incremental metadata merges.
    out.channel_bot = bot?.name ?? null;
    // The persona the bot runs, when its config names one (zen-agent bridges); otherwise left out, never guessed.
    out.channel_persona = bot?.persona ?? null;
  }
  return { ...out };
}

/** Session meta from one Claude Code transcript chunk: the channel label and how Claude Code was started. Merged per chunk. */
export function claudeSessionMeta(chunk: Pick<ClaudeChunk, 'channel' | 'entrypoint'>): Record<string, unknown> {
  return { ...channelMeta(chunk.channel, 'claude-code'), ...(chunk.entrypoint ? { entrypoint: chunk.entrypoint } : {}) };
}
