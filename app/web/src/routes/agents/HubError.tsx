import { ApiError } from '../../lib/api.js';

/** The live Agents tabs need agent-hub, which exists only on the droplet. Say so plainly instead of a raw error. */
export default function HubError({ error }: { error: Error }) {
  if (error instanceof ApiError && error.status === 503) {
    return (
      <p className="p-6 text-sm text-[var(--ink-dim)]">
        The board and Claude chats run on the droplet. Open this page on the server app to use them; the History tab works here.
      </p>
    );
  }
  return <p className="p-6 text-sm">⚠ {error.message}</p>;
}
