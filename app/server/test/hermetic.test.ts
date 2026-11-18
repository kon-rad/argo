import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';

/**
 * Guards the hermetic setup (the pinned env in vitest.config.ts plus test/hermetic.ts).
 *
 * On a machine whose shell exports BOARD_URL/BOARD_TOKEN (anyone who talks to a
 * board) or DEPLOYMENT=server, config.ts captures them at import: the board CLI
 * then silently uses HttpBoard against a real board instead of the scratch
 * database, and route tests see a login where they expect a 404. This file fails
 * on such a machine before the setup file exists and passes after it. On a clean
 * machine (CI) it passes either way, which is fine - it is a regression guard,
 * not the proof.
 */
describe('hermetic test environment', () => {
  it('does not inherit the developer machine board settings or a server deployment', () => {
    expect(config.boardUrl).toBeUndefined();
    expect(config.boardToken).toBeUndefined();
    expect(config.deployment).toBe('local');
  });
});
