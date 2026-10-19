import { config } from './config.js';
import { pool } from './db.js';
import { checkReauthNeeded, runDuePosts } from './social/scheduler.js';
import { hermesTelegram } from './livestream-x.js';
import { linkedinProvider } from './social/providers/linkedin.js';
import type { SocialProvider } from './social/providers/types.js';

// `cli-social.js` — one pass: publish every due post, then check for accounts
// that need reauthorization within 7 days (itself debounced to once/24h). On
// a server a systemd timer runs it every minute (deploy/secondbrain-social.*,
// social module). Reuses hermesTelegram() from the livestream module — same
// bot, same "please take a manual action" channel.

function providers(): Record<string, SocialProvider> {
  const p: Record<string, SocialProvider> = {};
  if (config.linkedinClientId && config.linkedinClientSecret) {
    p.linkedin = linkedinProvider({ clientId: config.linkedinClientId, clientSecret: config.linkedinClientSecret });
  }
  return p;
}

let code = 0;
try {
  const now = new Date();
  const { posted, failed } = await runDuePosts(providers(), config.socialTokenEncKey, now);
  if (posted || failed) console.log(`social: posted ${posted}, failed ${failed}`);
  try {
    await checkReauthNeeded(hermesTelegram(), now);
  } catch (err) {
    // A missed ping isn't a posting error; log it and let the next minute retry.
    console.error(`social: reauth check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (failed) code = 2;
} catch (err) {
  console.error(`social run failed: ${err instanceof Error ? err.message : String(err)}`);
  code = 1;
} finally {
  await pool.end();
}
process.exit(code);
