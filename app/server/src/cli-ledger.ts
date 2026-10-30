// `ledger`: this machine's agent ledger. Built into one file by bin/build-ledger.sh and run by the
// OS scheduler, outside the app: it imports node builtins and pure parsers only (see ledger/types.ts).
//   ledger run                 collect, then sync (what the scheduler runs)
//   ledger collect | sync [--force] | status
//   ledger install --server <url> --token <t> --host <slug> [--hermes <dir>[=<label>]]... [--claude-dir <dir>]
//                  [--redact-env <file>]... [--provider anthropic] [--interval 120] [--retain-days 60|forever] [--proxy [--proxy-port 18080]] [--no-schedule]
//   ledger uninstall
//   ledger proxy               the capture proxy in the foreground (what its service runs)
//   ledger proxy-on | proxy-off   route Claude Code through the proxy, or straight to the API again
//   ledger requeue             retry every row the server refused (after a server upgrade)
//   ledger redact-captures     redact proxy captures not yet sent with this machine's env files (once, after adding --redact-env)
import { exitFlushed } from './cli-exit.js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectClaude, collectHermes, emptyCounts, type CollectCounts } from './ledger/collect.js';
import { dataDir, loadConfig, saveConfig } from './ledger/config.js';
import { routeDirect, routeThroughProxy, watchProxy } from './ledger/claudeSettings.js';
import {
  launchdPlist, launchdProxyPlist, LAUNCHD_LABEL, LAUNCHD_PROXY_LABEL, logFileFor, SCHTASKS_NAME, SCHTASKS_PROXY_NAME, schtasksArgs,
  schtasksProxyArgs, systemdProxyUnit, systemdUnits, SYSTEMD_PROXY_UNIT, SYSTEMD_UNIT, type ScheduleSpec,
} from './ledger/install.js';
import { buildRedactor, type Redactor } from './archive/redact.js';
import { captureQueue, HEALTH_PATH, recordExchange, redactCaptures, startProxy } from './ledger/proxy.js';
import { Ledger } from './ledger/store.js';
import { syncOnce } from './ledger/sync.js';
import type { LedgerConfig } from './ledger/types.js';

declare const LEDGER_BUNDLE: string | undefined; // set by esbuild --define
const BUNDLE = typeof LEDGER_BUNDLE === 'string' ? LEDGER_BUNDLE : 'dev';

const [cmd = 'status', ...rest] = process.argv.slice(2);
const flag = (name: string): boolean => rest.includes(`--${name}`);
const values = (name: string): string[] => rest.flatMap((a, i) => (a === `--${name}` && rest[i + 1] ? [rest[i + 1]!] : []));
const value = (name: string): string | undefined => values(name).at(-1);
const log = (msg: string) => console.error(`${new Date().toISOString()} ledger: ${msg}`);

// A scheduled run is the installed copy at <data>/bin/ledger.mjs: its data folder is the one above it.
const selfPath = fileURLToPath(import.meta.url);
const besideBundle = resolve(dirname(selfPath), '..');
const dir = !process.env.SB_LEDGER_DIR && selfPath.endsWith(join('bin', 'ledger.mjs')) && existsSync(join(besideBundle, 'ledger.json'))
  ? besideBundle : dataDir();

/** One run at a time: a manual `ledger run` while the scheduler's is going would race the cursors. */
function acquireLock(): (() => void) | null {
  const lock = join(dir, 'lock');
  mkdirSync(dir, { recursive: true });
  try { mkdirSync(lock); } catch {
    const pid = Number(existsSync(join(lock, 'pid')) ? readFileSync(join(lock, 'pid'), 'utf8') : NaN);
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    if (alive) return null;
    // Stale: rename is atomic, so of two runs taking over at once exactly one wins the rename.
    const stale = `${lock}.stale-${process.pid}`;
    try { renameSync(lock, stale); } catch { return null; }
    rmSync(stale, { recursive: true, force: true });
    try { mkdirSync(lock); } catch { return null; }
  }
  writeFileSync(join(lock, 'pid'), String(process.pid));
  return () => rmSync(lock, { recursive: true, force: true });
}

async function collect(ledger: Ledger, cfg: LedgerConfig): Promise<{ claude: CollectCounts; hermes: CollectCounts }> {
  const claude = cfg.claudeProjectsDir ? collectClaude(ledger, cfg.claudeProjectsDir, cfg.claudeProvider) : emptyCounts();
  const hermes = await collectHermes(ledger, cfg.hermesHomes);
  return { claude, hermes };
}

async function install(): Promise<void> {
  const cfg = loadConfig(dir);
  if (value('server')) cfg.server = value('server')!.replace(/\/+$/, '');
  if (value('token')) cfg.token = value('token')!;
  if (value('host')) cfg.host = value('host')!;
  if (value('claude-dir')) cfg.claudeProjectsDir = resolve(value('claude-dir')!);
  if (value('provider')) cfg.claudeProvider = value('provider')!;
  if (value('interval')) cfg.intervalSec = Math.max(60, Number(value('interval')));
  if (flag('proxy')) cfg.proxy = { ...cfg.proxy, enabled: true };
  if (value('proxy-port')) cfg.proxy = { ...cfg.proxy, port: Number(value('proxy-port')) };
  if (value('upstream')) cfg.proxy = { ...cfg.proxy, upstream: value('upstream')!.replace(/\/+$/, '') };
  if (values('redact-env').length) cfg.redactEnvFiles = values('redact-env').map((f) => resolve(f));
  if (value('retain-days')) cfg.retainDays = value('retain-days') === 'forever' ? null : Math.max(1, Number(value('retain-days')));
  if (values('hermes').length) {
    cfg.hermesHomes = values('hermes').map((h) => {
      const [d, label = 'main'] = h.split('=');
      return { dir: resolve(d!), label };
    });
  }
  if (cfg.proxy.enabled && cfg.server && !(cfg.redactEnvFiles ?? []).length) {
    throw new Error('--proxy with a server needs at least one --redact-env file: proxy captures are sent as they were recorded');
  }
  const labels = cfg.hermesHomes.map((h) => h.label);
  if (new Set(labels).size !== labels.length) throw new Error(`Hermes home labels must be unique, got ${labels.join(', ')}`);
  const configFile = saveConfig(dir, cfg);

  // The scheduler runs a copy outside any synced or protected folder (macOS TCC blocks ~/Documents for launchd).
  const self = fileURLToPath(import.meta.url);
  if (!self.endsWith('.mjs')) throw new Error('install from the built bundle: app/bin/build-ledger.sh, then node <out>/ledger.mjs install …');
  const bundle = join(dir, 'bin', 'ledger.mjs');
  mkdirSync(dirname(bundle), { recursive: true });
  if (resolve(self) !== resolve(bundle)) copyFileSync(self, bundle);
  console.log(`config: ${configFile}\nbundle: ${bundle} (${BUNDLE})`);
  if (flag('no-schedule')) return;

  const spec: ScheduleSpec = { node: process.execPath, bundle, intervalSec: cfg.intervalSec, dataDir: dir, logFile: logFileFor(process.platform, dir) };
  schedule('run', spec);
  if (!cfg.proxy.enabled) return;
  schedule('proxy', spec);
  // Point Claude Code at the proxy only once it answers.
  const url = `http://127.0.0.1:${cfg.proxy.port}${HEALTH_PATH}`;
  for (let i = 0; i < 20; i++) {
    if (await fetch(url, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false)) {
      const route = routeThroughProxy(cfg.proxy.port);
      console.log(route === 'other'
        ? 'proxy running, but ~/.claude/settings.json already sets another ANTHROPIC_BASE_URL: left alone'
        : `Claude Code now goes through http://127.0.0.1:${cfg.proxy.port} (new sessions)`);
      return;
    }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  console.log('proxy service installed but not answering yet; `ledger run` routes Claude Code through it once it does');
}

/** Registers one scheduler entry: the periodic `run`, or the always-on `proxy`. */
function schedule(what: 'run' | 'proxy', spec: ScheduleSpec): void {
  if (process.platform === 'darwin') {
    const label = what === 'run' ? LAUNCHD_LABEL : LAUNCHD_PROXY_LABEL;
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, what === 'run' ? launchdPlist(spec) : launchdProxyPlist(spec));
    const uid = process.getuid!();
    try { execFileSync('launchctl', ['bootout', `gui/${uid}`, plist], { stdio: 'ignore' }); } catch { /* not loaded */ }
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    console.log(`scheduled: ${plist}, log ${spec.logFile}`);
  } else if (process.platform === 'win32') {
    execFileSync('schtasks', what === 'run' ? schtasksArgs(spec) : schtasksProxyArgs(spec), { stdio: 'inherit' });
    if (what === 'proxy') execFileSync('schtasks', ['/Run', '/TN', SCHTASKS_PROXY_NAME], { stdio: 'inherit' });
    console.log(`scheduled: task ${what === 'run' ? SCHTASKS_NAME : SCHTASKS_PROXY_NAME}, log ${spec.logFile}`);
  } else {
    const unitDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    let unit: string;
    if (what === 'run') {
      const units = systemdUnits(spec);
      writeFileSync(join(unitDir, `${SYSTEMD_UNIT}.service`), units.service);
      writeFileSync(join(unitDir, `${SYSTEMD_UNIT}.timer`), units.timer);
      unit = `${SYSTEMD_UNIT}.timer`;
    } else {
      writeFileSync(join(unitDir, `${SYSTEMD_PROXY_UNIT}.service`), systemdProxyUnit(spec));
      unit = `${SYSTEMD_PROXY_UNIT}.service`;
    }
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', unit]);
    console.log(`scheduled: ${unitDir}/${unit}, log ${spec.logFile}`);
    if (what === 'run') console.log(`headless box: run \`loginctl enable-linger ${process.env.USER ?? '<user>'}\` so it runs without a login`);
  }
}

function uninstall(): void {
  const cfg = loadConfig(dir);
  routeDirect(cfg.proxy.port); // new Claude Code sessions go straight to the API before the proxy stops
  if (process.platform === 'darwin') {
    for (const label of [LAUNCHD_LABEL, LAUNCHD_PROXY_LABEL]) {
      const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      try { execFileSync('launchctl', ['bootout', `gui/${process.getuid!()}`, plist], { stdio: 'ignore' }); } catch { /* not loaded */ }
      rmSync(plist, { force: true });
    }
  } else if (process.platform === 'win32') {
    for (const name of [SCHTASKS_NAME, SCHTASKS_PROXY_NAME]) {
      try { execFileSync('schtasks', ['/Delete', '/F', '/TN', name], { stdio: 'ignore' }); } catch { /* absent */ }
    }
  } else {
    for (const unit of [`${SYSTEMD_UNIT}.timer`, `${SYSTEMD_PROXY_UNIT}.service`]) {
      try { execFileSync('systemctl', ['--user', 'disable', '--now', unit], { stdio: 'ignore' }); } catch { /* absent */ }
    }
  }
  console.log(`unscheduled. The ledger itself stays in ${dir}; delete it by hand if you mean to.`);
}

async function proxy(): Promise<never> {
  const cfg = loadConfig(dir);
  const ledger = new Ledger(join(dir, 'ledger.db'), { busyTimeoutMs: 50 });
  // Captures are redacted before they are hashed. An env file it can't read means no captures at all;
  // requests are still forwarded, so Claude Code keeps working.
  let red: Redactor | null = null;
  try { red = buildRedactor({ env: process.env, files: cfg.redactEnvFiles ?? [] }); }
  catch (err) { log(`captures off: redact env file unreadable: ${(err as Error).message}`); }
  const server = await startProxy({
    port: cfg.proxy.port, upstream: cfg.proxy.upstream, log,
    onCapture: red ? captureQueue((c) => recordExchange(ledger, c, 'anthropic', red!), log) : () => {},
  });
  log(`capture proxy on http://127.0.0.1:${cfg.proxy.port} -> ${cfg.proxy.upstream} (${BUNDLE})`);
  const stop = () => server.close(() => { ledger.close(); process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return new Promise<never>(() => {});
}

let code = 0;
try {
  if (cmd === 'install') await install();
  else if (cmd === 'uninstall') uninstall();
  else if (cmd === 'proxy') await proxy();
  else if (cmd === 'proxy-on' || cmd === 'proxy-off') {
    const cfg = loadConfig(dir);
    cfg.proxy = { ...cfg.proxy, enabled: cmd === 'proxy-on' };
    saveConfig(dir, cfg);
    const route = cmd === 'proxy-on' ? routeThroughProxy(cfg.proxy.port) : routeDirect(cfg.proxy.port);
    console.log(`Claude Code route for new sessions: ${route}`);
  }
  else if (['run', 'collect', 'sync', 'status', 'requeue', 'redact-captures'].includes(cmd)) {
    const cfg = loadConfig(dir);
    const release = cmd === 'status' ? () => {} : acquireLock();
    if (!release) { log('another run is active; exiting'); process.exit(0); }
    const ledger = new Ledger(join(dir, 'ledger.db'));
    try {
      const out: Record<string, unknown> = { at: new Date().toISOString(), bundle: BUNDLE };
      if (cmd === 'run' || cmd === 'collect') {
        const c = await collect(ledger, cfg);
        out.collect = c;
        if (c.claude.errors.length || c.hermes.errors.length) code = 2;
      }
      if (cmd === 'requeue') out.requeued = ledger.requeue();
      if (cmd === 'redact-captures') {
        if (!(cfg.redactEnvFiles ?? []).length) throw new Error('set --redact-env first (ledger install --redact-env <file>)');
        out.redacted = redactCaptures(ledger, buildRedactor({ env: process.env, files: cfg.redactEnvFiles ?? [] }));
      }
      if (cmd === 'run') out.requeued = ledger.requeue({ olderThanMs: 86_400_000, maxAttempts: 7 });
      if (cmd === 'run' || cmd === 'sync' || cmd === 'requeue') {
        out.sync = await syncOnce(ledger, cfg, { fetch, now: () => new Date(), bundle: BUNDLE, log }, { force: flag('force') || cmd === 'sync' || cmd === 'requeue' });
        if (cfg.retainDays) out.pruned = ledger.prune(cfg.retainDays);
        if (cfg.proxy.enabled) {
          const w = await watchProxy(cfg.proxy.port, Number(ledger.meta('proxy_failures') ?? 0));
          ledger.setMeta('proxy_failures', w.failures);
          if (w.changed) log(`proxy ${w.healthy ? 'healthy' : 'down'}: Claude Code route is now ${w.route}`);
          out.proxy = w;
        }
      }
      if (cmd === 'status') out.status = { dir, server: cfg.server, host: cfg.host, hermesHomes: cfg.hermesHomes, redactEnvFiles: cfg.redactEnvFiles ?? [], ...ledger.stats() };
      console.log(JSON.stringify(out, null, cmd === 'status' ? 2 : 0));
    } finally {
      ledger.close();
      release();
    }
  } else {
    console.error(`usage: ledger run | collect | sync [--force] | status | requeue | redact-captures | install … | uninstall | proxy | proxy-on | proxy-off`);
    code = 1;
  }
} catch (err) {
  log(`failed: ${(err as Error).message}`);
  code = 1;
}
await exitFlushed(code);
