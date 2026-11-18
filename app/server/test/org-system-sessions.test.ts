import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { truncateAll } from './helpers.js';

/** `org import` seeds the service lanes that act on the board without being roster bots, and never retires them. */

const ORG = {
  version: 'system-sessions-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', model: 'opus' },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' } },
  channels: { 'all-hands': { members: '*' } },
};

const live = async () =>
  (await query<{ name: string; runtime: string; retired_at: Date | null }>(
    `SELECT name, runtime, retired_at FROM org_agents WHERE name IN ('claude-telegram','cc-dispatcher','m4') ORDER BY name`,
  )).rows;

beforeEach(truncateAll);

describe('system session identities', () => {
  it('are created by an import and stay live through the next one', async () => {
    await importOrg(ORG);
    expect((await live()).map((r) => [r.name, r.runtime, r.retired_at])).toEqual([
      ['cc-dispatcher', 'session', null], ['claude-telegram', 'session', null], ['m4', 'session', null],
    ]);
    await query(`UPDATE org_agents SET retired_at = now() WHERE name = 'cc-dispatcher'`);
    await importOrg({ ...ORG, version: 'system-sessions-2' });
    expect((await live()).every((r) => r.retired_at === null)).toBe(true);
  });
});
