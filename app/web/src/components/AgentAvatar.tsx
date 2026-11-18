import { useEffect, useState } from 'react';
import { teamColor } from '../lib/teamColor.js';

/**
 * An org agent's portrait, served from the vault by GET /api/org/avatar/<name>
 * (the `avatar` key of its org file entry). When the agent has none, or the
 * image fails to load, a round chip with the agent's initial in its team colour
 * stands in, so a page never shows a broken image. Pass `avatar: null` when the
 * caller already knows there is no portrait (the org chart says so) to skip the
 * request; leave it undefined to try.
 */
export function AgentAvatar({ name, team = null, avatar, size = 24, className = '' }: {
  name: string;
  team?: string | null;
  avatar?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [name]);
  const style = { width: size, height: size, minWidth: size };
  if (avatar === null || failed) {
    return (
      <span
        aria-hidden
        data-testid="agent-avatar-fallback"
        className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase text-white ${className}`}
        style={{ ...style, background: teamColor(team), fontSize: Math.round(size * 0.45) }}
      >
        {name.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={`/api/org/avatar/${encodeURIComponent(name)}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      data-testid="agent-avatar"
      className={`inline-block shrink-0 rounded-full object-cover ${className}`}
      style={style}
      onError={() => setFailed(true)}
    />
  );
}
