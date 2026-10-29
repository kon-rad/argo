import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { breakerLimitsFromEnv, runBreaker } from './breaker.js';
import { classify } from './classify/index.js';
import { config } from './config.js';
import { pool } from './db.js';
import { Dispatcher, type Deps, type Runner } from './dispatch/index.js';
import { OrgError } from './org.js';
import type { RoutingConfig } from './org-router.js';
import { settings } from './settings.js';

// `secondbrain org-dispatch tick | routines`: the engine's dispatcher for bots on the zen-agent runtime
// (docs/zen-runtime.md, section 8). A systemd timer runs `tick` every ORG_DISPATCH_TICK_SECONDS as the app
// user; a oneshot service that is still running is not started again, so a long run never overlaps a tick.
const USAGE = `secondbrain org-dispatch: run zen-agent bots for their open wakeups

  tick       materialise due routines, release stale claims, then one zen-agent run per bot with open wakeups
  routines   only add the roster's due routine wakeups (once per local day in ORG_TZ)

Settings: ORG_DISPATCH, ORG_TZ, ORG_DISPATCH_QUIET, ORG_DISPATCH_DAILY_TOKENS, ORG_DISPATCH_PARALLEL, ORG_ZEN_COMMAND
(env), and secondbrain.json "dispatch" (tiers, budgets, tools). Bots on other runtimes are left to their own dispatcher.`;

/** Runs zen-agent as a child process; stdout is the --json result, stderr the printer's lines. */
export const execRunner: Runner = (cmd, args, env, cwd, timeoutMs) =>
  new Promise((done) => {
    execFile(cmd, args, { env, cwd, timeout: timeoutMs, maxBuffer: 16_000_000, killSignal: 'SIGTERM' }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code
        : err ? 1 : 0;
      done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (err && typeof (err as { code?: unknown }).code !== 'number' ? `\n${err.message}` : '') });
    });
  });

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (!config.modules.has('org')) throw new OrgError('the org module is off (MODULES)');
  const dispatch = settings().dispatch;
  let router: Deps['router'];
  if (dispatch.routing.mode !== 'off') {
    const file = isAbsolute(dispatch.routing.config) ? dispatch.routing.config : join(config.vaultRoot, dispatch.routing.config);
    if (!existsSync(file)) throw new OrgError(`dispatch.routing is ${dispatch.routing.mode} but ${file} is missing; run compile.py routing`);
    router = { mode: dispatch.routing.mode, cfg: JSON.parse(readFileSync(file, 'utf8')) as RoutingConfig, maxTier: dispatch.routing.maxTier };
  }
  const d = new Dispatcher({
    runner: execRunner,
    classify,
    router,
    settings: dispatch,
    config: {
      orgTz: config.orgTz, orgDispatchQuiet: config.orgDispatchQuiet, orgDispatchDailyTokens: config.orgDispatchDailyTokens,
      orgDispatchParallel: config.orgDispatchParallel, orgZenCommand: config.orgZenCommand, vaultRoot: config.vaultRoot,
    },
    log: (line) => console.error(line),
  });
  if (cmd === 'routines') {
    console.log(`routines: ${await d.routines()} wakeup(s) added`);
    return 0;
  }
  if (cmd === 'tick') {
    // The credit breaker rides the tick (ORG_BREAKER=on): it only ever pauses, and a failure never blocks the tick.
    if (process.env.ORG_BREAKER === 'on') {
      try {
        for (const a of await runBreaker(process.env.ORG_BREAKER_AS || config.orgOwner, breakerLimitsFromEnv(), { dryRun: false })) {
          if (a.paused) console.error(`breaker: ${a.runtime} lane paused (${a.paused} bots): ${a.reason}`);
        }
      } catch (err) {
        console.error(`breaker: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const r = await d.tick();
    console.log(`tick: ${r.routines} routines, ${r.released} released, ${r.agents} bots, ${r.runs} runs, ${r.acks} acks, ${r.gated} gated` +
      (r.held ? `, held: ${r.held}` : ''));
    for (const e of r.errors) console.error(`  ! ${e}`);
    return r.errors.length ? 2 : 0;
  }
  console.log(USAGE);
  return 1;
}

if (process.argv[1]?.endsWith('cli-dispatch.js') || process.argv[1]?.endsWith('cli-dispatch.ts')) {
  let code = 1;
  try {
    code = await main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end();
  }
  process.exit(code);
}
