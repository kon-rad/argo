import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query, setDatabaseUrl } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { main } from '../src/cli-org.js';
import { truncateAll } from './helpers.js';

/** Regression for t_edade866: `cli-org breaker --dry-run` as the sb_org role hit "permission denied for table provider_credit_snapshots". */

const ORG = {
  version: 'breaker-role-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    sol: { role: 'Chief of staff', team: 'staff', reports_to: 'owner', capabilities: ['dispatch'] },
  },
  teams: { staff: { name: 'Staff', lead: 'sol' } },
  channels: { 'all-hands': { members: '*' } },
};
const DB = `${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${process.env.SB_TEST_DB ?? 'secondbrain_test'}`;

beforeEach(async () => {
  await truncateAll();
  await importOrg(ORG);
  await query(`INSERT INTO provider_credit_snapshots (provider, origin, status, balance, currency, observed_at) VALUES ('openrouter','api','ok',50,'USD',now())`);
});
afterEach(() => {
  delete process.env.ORG_AGENT;
  delete process.env.SB_ORG_DB_URL;
  setDatabaseUrl(`postgres://${DB}`);
});

describe('credit breaker as the sb_org role', () => {
  it('reads the credit snapshot in a dry run', async () => {
    process.env.ORG_AGENT = 'sol';
    process.env.SB_ORG_DB_URL = `postgres://sb_org@${DB}`;
    const lines: string[] = [];
    expect(await main(['breaker', '--dry-run'], (s) => lines.push(s))).toBe(0);
    expect(lines.join('\n')).toMatch(/breaker/);
  });
});
