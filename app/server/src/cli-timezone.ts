/**
 * `secondbrain timezone [show | set <Area/City> | clear] [--json]` (docs/timezone.md).
 *
 * The vault's current time zone, kept in secondbrain.json (`"timezone"`). The web app shows every time in it and
 * buckets the Usage charts by it; unset, each browser uses its own zone. An agent asked "I'm in Singapore now"
 * runs `secondbrain timezone set Asia/Singapore`; the next page load uses it, no restart.
 */
import { pathToFileURL } from 'node:url';
import { exitFlushed } from './cli-exit.js';
import { settingsPath } from './settings.js';
import { currentTimezone, saveTimezone } from './timezone.js';

export interface TimezoneIo { path: string; out: (line: string) => void; err: (line: string) => void }

const USAGE = 'usage: secondbrain timezone [show | set <IANA zone, e.g. Asia/Singapore> | clear] [--json]';

export function runTimezone(argv: string[], io: TimezoneIo): number {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const [sub = 'show', value] = args;
  const report = (before: string | null, after: string | null) => {
    if (json) io.out(JSON.stringify({ timezone: after, previous: before, file: io.path }));
    else if (after === null) io.out(`timezone: not set (each browser uses its own zone)${before ? `, was ${before}` : ''}`);
    else io.out(before && before !== after ? `timezone: ${before} -> ${after}` : `timezone: ${after}`);
  };
  const before = currentTimezone(io.path);
  switch (sub) {
    case 'show':
      report(before, before);
      return 0;
    case 'set': {
      if (!value || args.length > 2) { io.err(USAGE); return 2; }
      try {
        report(before, saveTimezone(value, io.path));
        return 0;
      } catch (e) {
        io.err((e as Error).message);
        return 2;
      }
    }
    case 'clear':
      if (args.length > 1) { io.err(USAGE); return 2; }
      report(before, saveTimezone(null, io.path));
      return 0;
    default:
      io.err(USAGE);
      return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const code = runTimezone(process.argv.slice(2), { path: settingsPath(), out: (l) => console.log(l), err: (l) => console.error(l) });
  await exitFlushed(code);
}
