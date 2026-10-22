import { pool } from './db.js';
import { hermesTelegram } from './livestream-x.js';
import { checkPlanAlerts, currentReadings, pendingAlerts } from './usage/planAlert.js';

// `secondbrain plan-alert [--dry-run]`
//   (no flag)   check the plan windows now and send what is due (usage-sync does this every 5 minutes on the droplet)
//   --dry-run   print the plan readings and the messages that would be sent; claims nothing, sends nothing
const dry = process.argv.includes('--dry-run');
let code = 1;
try {
  const now = new Date();
  if (dry) {
    for (const r of await currentReadings(now)) console.log(`${r.window}: ${r.usedPct}% used, resets ${r.resetsAt.toISOString()}, read ${r.observedAt.toISOString()}`);
    const due = await pendingAlerts(now);
    if (!due.length) console.log('nothing due: no new threshold crossed');
    for (const a of due) console.log(`\n--- would send (${a.window}, crossed ${a.crossed.join(', ')}) ---\n${a.text}`);
    code = 0;
  } else {
    const r = await checkPlanAlerts(hermesTelegram(), now);
    for (const s of r.sent) console.log(`sent ${s.window} ${Math.max(...s.crossed)}%`);
    for (const f of r.failed) console.error(`failed ${f.window}: ${f.error}`);
    if (!r.sent.length && !r.failed.length) console.log('nothing due');
    code = r.failed.length ? 2 : 0;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
} finally {
  await pool.end();
}
process.exit(code);
