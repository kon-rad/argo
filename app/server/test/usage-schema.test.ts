import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { truncateAll } from './helpers.js';

beforeEach(truncateAll);

describe('usage schema', () => {
  it('has the ledger tables', async () => {
    const { rows } = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE ANY($1)
       ORDER BY 1`, [['usage_%', 'plan_usage_%', 'hermes_usage_%']]);
    expect(rows.map((r) => r.table_name)).toEqual(
      ['hermes_usage_snapshots', 'plan_usage_snapshots', 'usage_calls', 'usage_facts', 'usage_files', 'usage_hosts', 'usage_runs']);
  });

  it('counts one call once per source, host and call id', async () => {
    const insert = `INSERT INTO usage_calls (source, host, call_id, session_external_id, ts, model)
                    VALUES ('claude-code','mac','msg_1','s1',now(),'claude-opus-5-5') ON CONFLICT DO NOTHING`;
    await query(insert);
    await query(insert);
    const { rows } = await query<{ n: number }>(`SELECT count(*)::int n FROM usage_calls`);
    expect(rows[0]!.n).toBe(1);
  });

  it('knows its hosts and refuses one that is not registered', async () => {
    const { rows } = await query<{ slug: string }>(`SELECT slug FROM usage_hosts ORDER BY slug`);
    expect(rows.map((r) => r.slug)).toEqual(['droplet', 'mac']);
    await expect(query(`INSERT INTO usage_calls (source, host, call_id, session_external_id, ts, model)
                        VALUES ('claude-code','toaster','msg_2','s1',now(),'m')`)).rejects.toThrow(/usage_hosts|foreign key/);
    // A host registered later is accepted.
    await query(`INSERT INTO usage_hosts (slug, display, kind) VALUES ('mac-2', 'Second laptop', 'laptop')`);
    await query(`INSERT INTO usage_calls (source, host, call_id, session_external_id, ts, model)
                 VALUES ('claude-code','mac-2','msg_3','s1',now(),'m')`);
    await expect(query(`INSERT INTO usage_calls (source, host, call_id, session_external_id, ts, model, action)
                        VALUES ('claude-code','mac','msg_4','s1',now(),'m','dance')`)).rejects.toThrow();
  });

  it('rejects an unknown plan window', async () => {
    await expect(query(`INSERT INTO plan_usage_snapshots (host, origin, "window", used_pct, observed_at)
                        VALUES ('mac','statusline','monthly',10,now())`)).rejects.toThrow();
  });
});
