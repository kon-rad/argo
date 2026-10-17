import { config } from './config.js';
import { pool } from './db.js';
import { pullLocalAi } from './localai/pull.js';

// `secondbrain local-ai-pull`: copy the local model host's call log (LOCAL_AI_EXPORT_URL) into local_ai_*.
// On the server a systemd timer runs it every 5 minutes (deploy/secondbrain-localai-pull.*) when the
// localai module is on. The host being off is normal: each table records the error and the next run retries.
let code = 1;
try {
  if (!config.localAiExportUrl) {
    console.log('local-ai-pull: LOCAL_AI_EXPORT_URL is not set; nothing to do');
    code = 0;
  } else {
    const results = await pullLocalAi({ host: config.localAiHost, baseUrl: config.localAiExportUrl });
    const failed = results.filter((r) => r.error);
    console.log(`local-ai-pull ${config.localAiHost}: ` + results.map((r) => `${r.table} +${r.rows} (seq ${r.after})`).join(', '));
    for (const r of failed) console.error(`  ! ${r.table}: ${r.error}`);
    // Every table failing is the host being off or unreachable: not an error worth a failed unit.
    code = failed.length && failed.length < results.length ? 2 : 0;
  }
} catch (err) {
  console.error(`local-ai-pull failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}
process.exit(code);
