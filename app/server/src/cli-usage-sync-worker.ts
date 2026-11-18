import { producerHealth } from './usage/producerHealth.js';
import { exitFlushed } from './cli-exit.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Host } from './archive/types.js';
import { config } from './config.js';
import { pool } from './db.js';
import { hermesTelegram } from './livestream-x.js';
import { checkPlanAlerts } from './usage/planAlert.js';
import { syncUsage } from './usage/sync.js';

// `secondbrain usage-sync`: this machine's Claude Code transcripts, cc-runs logs, plan readings and zen-agent traces -> the ledger.
// On the server a systemd timer runs it as the service user (deploy/secondbrain-usage-sync.*).
const home = homedir();
const host = (config.env.USAGE_SYNC_HOST ?? (config.env.DEPLOYMENT === 'server' ? 'droplet' : 'mac')) as Host;
const paths = {
  claudeProjectsDir: config.env.CLAUDE_PROJECTS_DIR ?? join(home, '.claude', 'projects'),
  runsDir: config.env.CC_RUNS_DIR ?? join(home, 'cc-runs'),
  statuslineLog: config.env.PLAN_USAGE_LOG ?? join(home, '.local', 'share', 'secondbrain', 'plan-usage.ndjson'),
  codexSessionsDir: join(config.env.CODEX_HOME ?? join(home, '.codex'), 'sessions'),
  zenSessionsDir: config.zenSessionsDir,
};

let code = 1;
try {
  if (process.argv.includes('--health-timeout')) {
    for (const [runtime, path] of [['claude-code', paths.claudeProjectsDir], ['codex', paths.codexSessionsDir], ['zen', paths.zenSessionsDir], ['runs', paths.runsDir], ['plan', paths.statuslineLog]]) {
      if (path) await producerHealth(host, 'usage-sync', runtime!, path, new Date().toISOString(), null, true, 'deadline');
    }
    code = 1;
  } else {
    const c = await syncUsage(paths, host);
    console.log(`usage-sync ${host}: ${c.files} files, ${c.calls} calls, ${c.sessions} sessions, ${c.messages} messages, ` +
      `${c.runs} runs, ${c.plan} plan readings changed, ${c.attached} calls attached to runs`);
    for (const e of c.errors) console.error(`  ! ${e}`);
    code = c.errors.length ? 2 : 0;
    // Only the central droplet sends plan-window alerts, within the supervised attempt.
    if (host === 'droplet' && config.env.PLAN_ALERTS !== 'off') {
      try {
        const a = await checkPlanAlerts(hermesTelegram());
        for (const s of a.sent) console.log(`plan-alert: sent ${s.window} ${Math.max(...s.crossed)}% (at ${Math.round(s.reading.usedPct)}%)`);
        for (const f of a.failed) {
          console.error(`  ! plan-alert ${f.window}: ${f.error}`);
          code = 2;
        }
      } catch (err) {
        console.error(`  ! plan-alert: ${err instanceof Error ? err.message : String(err)}`);
        code = 2;
      }
    }
  }
} catch (err) {
  console.error(`usage-sync failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}
await exitFlushed(code);
