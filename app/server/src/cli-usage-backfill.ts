// usage-backfill: two one-off jobs for the ledger.
//   (default)   token calls for every local Claude Code session the archive already holds (older than Claude Code's
//               30-day transcript cleanup), as wire lines on stdout:
//               secondbrain usage-backfill | ssh <server> '/usr/local/bin/secondbrain-usage-import mac'
//   --actions   label existing calls with the tool they invoked and its action class, from the archive's raw
//               records (only calls whose transcript text is in this database get a label), then attach every
//               call to its run. Run on the server after migration 12900.
//   --bots      label sessions already imported with the roster bot a person chose (archive_sessions.bot: Claude
//               Code's agent-setting, a Codex or Hermes chat opened with the persona, a zen-agent persona), and take
//               the agent off zen-agent runs no dispatcher started. Run on the server after migration 18800.
import { replayProvenance } from './usage/provenance.js';
import { backfillBots } from './archive/bot.js';
import { pool, query, withTransaction } from './db.js';
import { classifyAction } from './usage/actions.js';
import { callsFromRecords } from './usage/claudeCalls.js';
import { attachCallsToRuns } from './usage/store.js';

if (process.argv.includes('--provenance')) {
  const arg = process.argv.find(a => a.startsWith('--sessions='));
  if (!arg || !/^--sessions=[0-9]+(?:,[0-9]+)*$/.test(arg)) throw new Error('--provenance requires --sessions=<archive IDs>');
  const ids = arg.slice('--sessions='.length).split(',').map(Number);
  if (ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('invalid archive ID scope (max 500)');
  const result = await withTransaction(tx => replayProvenance(tx, ids, !process.argv.includes('--apply')));
  console.log(JSON.stringify({ dryRun: !process.argv.includes('--apply'), ...result }));
} else if (process.argv.includes('--bots')) {
  const r = await backfillBots();
  console.error(`usage-backfill: ${r.scanned} sessions read, ${r.labelled} labelled with a bot, ${r.zenRuns} zen-agent chats no longer counted as wakes`);
} else if (process.argv.includes('--actions')) {
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
