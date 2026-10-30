import { exitFlushed } from './cli-exit.js';
import { pool } from './db.js';
import { addManualSession, buildSummary, pollers, recordObservation, writeSummary, type Platform } from './livestream.js';
import { fetchXBroadcast, hermesTelegram, parseBroadcastId, pollX, registerXBroadcast, remindXLink } from './livestream-x.js';

// `cli-livestream.js`            one poll of YouTube, Twitch, Kick and any registered X broadcast →
//                                Postgres → public livestream.json; pings Telegram for a missing X link.
//                                On a server a systemd timer runs it every minute
//                                (deploy/secondbrain-livestream.*, livestream module).
// `cli-livestream.js check [x-link]`  poll every platform (and that X broadcast) and print; writes nothing.
// `cli-livestream.js x <link>`   register an X broadcast (x.com/i/broadcasts/<id>); the livestream-x skill runs this.
// `cli-livestream.js add <start> <end> [note] [platform]`
//                                a stream the collector never saw, e.g.
//                                add 2026-10-12T10:00:00+08:00 2026-10-12T13:30:00+08:00 "day 1"
const outDir = process.env.LIVESTREAM_PUBLIC_DIR ?? '/var/lib/secondbrain-public';
const [cmd, ...args] = process.argv.slice(2);

function date(s: string | undefined): Date {
  const d = new Date(s ?? '');
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${s ?? '(missing)'}; use ISO 8601 with a zone`);
  return d;
}

let code = 1;
try {
  if (cmd === 'check') {
    for (const [p, poll] of Object.entries(pollers())) {
      console.log(p, JSON.stringify(await poll().catch((e: Error) => ({ error: e.message }))));
    }
    if (args[0]) console.log('x', JSON.stringify(await fetchXBroadcast(parseBroadcastId(args[0])).catch((e: Error) => ({ error: e.message }))));
    code = 0;
  } else if (cmd === 'x') {
    const id = await registerXBroadcast(args[0] ?? '');
    const { lines, errors } = await pollX();
    writeSummary(outDir, await buildSummary());
    console.log(`registered X broadcast ${id}`);
    for (const l of lines) console.log(l);
    for (const e of errors) console.error(`poll failed: ${e}`);
    code = errors.length ? 2 : 0;
  } else if (cmd === 'add') {
    const platform = (args[3] ?? 'youtube') as Platform;
    if (!['youtube', 'twitch', 'kick', 'x'].includes(platform)) throw new Error(`unknown platform ${platform}`);
    const id = await addManualSession({ platform, startedAt: date(args[0]), endedAt: date(args[1]), note: args[2] });
    const file = writeSummary(outDir, await buildSummary());
    console.log(`added manual session ${id}; wrote ${file}`);
    code = 0;
  } else if (cmd === undefined) {
    // One timestamp for the whole run, so the page can sum platforms minute by minute.
    const now = new Date();
    const errors: string[] = [];
    await Promise.all(
      Object.entries(pollers()).map(async ([platform, poll]) => {
        try {
          const obs = await poll();
          await recordObservation(platform, obs, now);
          console.log(`${platform}: ${obs.live ? `live ${obs.videoId}, ${obs.viewers} watching` : 'not live'}`);
        } catch (err) {
          // That platform's tables stay untouched, so a blip never ends its session.
          errors.push(`${platform}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    try {
      const x = await pollX(now);
      for (const l of x.lines) console.log(l);
      errors.push(...x.errors);
    } catch (err) {
      errors.push(`x: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const sent = await remindXLink(new Date(), hermesTelegram());
      if (sent) console.log('pinged Telegram for the X link');
    } catch (err) {
      // A missing ping isn't a data error; log it and retry next minute.
      console.error(`x reminder failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const e of errors) console.error(`poll failed: ${e}`);
    // Still rewrite the summary: the page keeps the last good numbers and can say a poll failed.
    writeSummary(outDir, await buildSummary(new Date(), 120, errors.length ? errors.join('; ') : null));
    code = errors.length ? 2 : 0;
  } else {
    console.error(`unknown command: ${cmd} (expected nothing, "check", "x" or "add")`);
  }
} catch (err) {
  console.error(`livestream failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}
await exitFlushed(code);
