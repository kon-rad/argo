// usage-backfill: two one-off jobs for the ledger.
//   (default)   token calls for every Mac Claude Code session the archive already holds (older than Claude Code's
//               30-day transcript cleanup), as wire lines on stdout:
//               secondbrain usage-backfill | ssh <server> '/usr/local/bin/secondbrain-usage-import mac'
//   --actions   label existing calls with the tool they invoked and its action class, from the archive's raw
//               records (only calls whose transcript text is in this database get a label), then attach every
//               call to its run. Run on the droplet after migration 12900.
import { pool, query, withTransaction } from './db.js';
import { classifyAction } from './usage/actions.js';
import { callsFromRecords } from './usage/claudeCalls.js';
import { attachCallsToRuns } from './usage/store.js';

if (process.argv.includes('--actions')) {
  let labelled = 0;
  for (;;) {
    const { rows } = await query<{ id: number; raws: unknown[] }>(
      `SELECT c.id, array_agg(m.raw ORDER BY m.seq) AS raws
         FROM usage_calls c
         JOIN archive_sessions s ON s.host = c.host AND s.external_id = c.session_external_id AND s.source = 'claude-code'
         JOIN archive_messages m ON m.session_id = s.id AND m.kind = 'assistant' AND m.raw -> 'message' ->> 'id' = c.call_id
        WHERE c.action IS NULL
        GROUP BY c.id LIMIT 500`);
    if (!rows.length) break;
    await withTransaction(async (tx) => {
      for (const r of rows) {
        const first = (r.raws as any[]).flatMap((rec) => (Array.isArray(rec?.message?.content) ? rec.message.content : []))
          .find((b: any) => b?.type === 'tool_use' && typeof b.name === 'string');
        const tool = first?.name ?? null;
        await tx.query(`UPDATE usage_calls SET tool = $2, action = $3 WHERE id = $1`, [r.id, tool, classifyAction(tool, first?.input)]);
      }
    });
    labelled += rows.length;
    console.error(`usage-backfill: ${labelled} calls labelled`);
  }
  const hosts = await query<{ host: string }>(`SELECT DISTINCT host FROM usage_runs`);
  let attached = 0;
  for (const h of hosts.rows) attached += await withTransaction((tx) => attachCallsToRuns(tx, h.host));
  console.error(`usage-backfill: ${labelled} calls labelled, ${attached} calls attached to runs`);
} else {
  const { rows } = await query<{ external_id: string; raws: unknown[] }>(
    `SELECT s.external_id, array_agg(m.raw ORDER BY m.seq) AS raws
     FROM archive_sessions s JOIN archive_messages m ON m.session_id = s.id
     WHERE s.source = 'claude-code' AND s.host = 'mac' AND m.kind = 'assistant'
     GROUP BY s.external_id`);
  let calls = 0;
  for (const r of rows) {
    const cs = callsFromRecords(r.raws, 'mac', r.external_id);
    if (!cs.length) continue;
    calls += cs.length;
    process.stdout.write(JSON.stringify({ t: 'calls', calls: cs.map((c) => ({ ...c, ts: c.ts.toISOString() })) }) + '\n');
  }
  console.error(`usage-backfill: ${rows.length} sessions, ${calls} calls`);
}
await pool.end();
