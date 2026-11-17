/**
 * The health checks behind `secondbrain doctor` and `GET /api/health` (proposal
 * phase 3). One list of checks, two callers: the CLI prints them for a person,
 * the route returns them as JSON to the launcher and the web app. A check never
 * throws — a failure is a Check with ok:false, so one broken subsystem never
 * hides the rest.
 *
 * `critical` says whether a failure makes the install unhealthy (`ok` in the
 * response). A stale AGENTS.md is worth saying but does not stop the app; a
 * database that will not answer does.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { config } from './config.js';
import { pool } from './db.js';
import { agentClis, enabledManifests } from './features/registry.js';
import { loadSettingsFile } from './settings-file.js';
import { settingsReport } from './settings.js';

export interface Check {
  /** A short stable key, e.g. `database`. */
  name: string;
  ok: boolean;
  /** A failure blocks `ok`; advisory checks (stale docs, no backup yet) do not. */
  critical: boolean;
  /** One line a person can act on. */
  detail: string;
  /** What to do about it, when there is something. */
  hint?: string;
  /** True when the check does not apply here (e.g. server-only checks on a laptop). */
  skipped?: boolean;
}

export interface DoctorOptions {
  modules?: ReadonlySet<string>;
  /** Also run the checks that need the deployed server (timers, last backup). */
  deep?: boolean;
  /** Also say, per agent CLI wrapper, whether this machine has it (the CLI doctor; /api/health leaves it out). */
  clis?: boolean | AgentCliEnv;
}

const pass = (name: string, detail: string, critical = false): Check => ({ name, ok: true, critical, detail });
const fail = (name: string, detail: string, hint?: string, critical = true): Check => ({ name, ok: false, critical, detail, hint });
const skip = (name: string, detail: string, critical = false): Check => ({ name, ok: true, critical, detail, skipped: true });

/** The minimum Node the engine supports; `engines` is not set in package.json, so it lives here. */
export const MIN_NODE_MAJOR = 20;

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? pass('node', `node ${process.versions.node}`)
    : fail('node', `node ${process.versions.node} is older than ${MIN_NODE_MAJOR}`, `install Node ${MIN_NODE_MAJOR} or newer`);
}

async function checkDatabase(): Promise<Check> {
  try {
    await pool.query('SELECT 1');
    return pass('database', 'connected');
  } catch (err) {
    return fail('database', err instanceof Error ? err.message.split('\n')[0]! : String(err), 'is Postgres running, and is DATABASE_URL right?');
  }
}

async function checkPgvector(connected: boolean): Promise<Check> {
  if (!connected) return skip('pgvector', 'skipped: no database');
  try {
    const { rowCount } = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    return rowCount
      ? pass('pgvector', 'extension installed')
      : fail('pgvector', 'the vector extension is not installed', 'CREATE EXTENSION vector; (the 1756000002000_embeddings migration does this)');
  } catch (err) {
    return fail('pgvector', err instanceof Error ? err.message.split('\n')[0]! : String(err));
  }
}

/** Every migration file whose numeric prefix is not in pgmigrations is pending. */
async function checkMigrations(connected: boolean): Promise<Check> {
  if (!connected) return skip('migrations', 'skipped: no database');
  const dir = join(config.appRoot, 'db', 'migrations');
  if (!existsSync(dir)) return fail('migrations', `no migrations directory at ${dir}`);
  const local = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const prefix = (f: string): string => f.split('_')[0] ?? f;
  let applied = new Set<string>();
  try {
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM pgmigrations');
    applied = new Set(rows.map((r) => prefix(r.name)));
  } catch {
    // No pgmigrations table yet (a database that never migrated): every file is pending.
  }
  const pending = local.filter((f) => !applied.has(prefix(f)));
  return pending.length
    ? fail('migrations', `${pending.length} pending: ${pending.slice(0, 3).join(', ')}${pending.length > 3 ? '…' : ''}`, 'secondbrain start applies migrations on a local install')
    : pass('migrations', `${local.length} applied`);
}

/** A module token MODULES does not know is dropped silently by config.parseModules; say so. */
function checkModules(modules: ReadonlySet<string>): Check {
  const raw = (config.env.MODULES ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  const known = new Set(enabledManifests(modules).map((m) => m.name));
  const enabled = [...modules];
  if (enabled.length === 0) return pass('modules', 'core features off (MODULES is empty)');
  const unknown = raw.filter((m) => !known.has(m as never) && !enabled.includes(m));
  const detail = `on: ${enabled.join(', ')}`;
  return unknown.length
    ? fail('modules', `${detail}; unknown in MODULES: ${[...new Set(unknown)].join(', ')}`, 'check the names against docs/modules.md', false)
    : pass('modules', detail);
}

function checkVault(): Check {
  const agents = join(config.vaultRoot, 'AGENTS.md');
  const local = join(config.vaultRoot, 'AGENTS.local.md');
  if (!existsSync(agents)) return pass('vault', 'no AGENTS.md (fine for a bare engine checkout)', false);
  const stale = existsSync(local) && statSync(local).mtimeMs > statSync(agents).mtimeMs;
  if (stale) {
    return fail('vault', 'AGENTS.local.md is newer than AGENTS.md', 'regenerate it: .secondbrain/bin/secondbrain-vault rules', false);
  }
  return pass('vault', 'AGENTS.md is up to date');
}

/** secondbrain.json is optional; a file that fails to parse is ignored at runtime, so flag it here. */
export function checkSettings(vaultRoot = config.vaultRoot): Check {
  const loaded = loadSettingsFile(vaultRoot);
  if (loaded.raw === null && loaded.error === null) return skip('settings', `no settings file at ${loaded.path} (fine: every section is optional)`);
  if (loaded.error) {
    const problem = loaded.error.kind === 'json' ? 'is not valid JSON' : 'could not be read';
    return fail('settings', `${loaded.path} ${problem}`, 'fix the file; the app uses defaults until it is valid');
  }
  const report = settingsReport(loaded.raw);
  if (report.errors.length > 0) {
    const fields = report.errors.map((error) => `${error.path.map(String).join('.')}: ${error.message}`).join('; ');
    return fail('settings', `${loaded.path} has invalid settings: ${fields}`, 'fix the named fields; only their sections use defaults');
  }
  return pass('settings', `${loaded.path} parses and matches the schema`);
}

function checkSync(): Check {
  if (!config.syncStateDir) return skip('sync', 'skipped: this machine does not sync (SYNC_STATE_DIR unset)');
  const path = join(config.syncStateDir, 'sync.json');
  if (!existsSync(path)) return pass('sync', 'no sync.json yet', false);
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as { lastSync?: string };
    return pass('sync', state.lastSync ? `last sync ${state.lastSync}` : 'sync state present', false);
  } catch {
    return fail('sync', `${path} is not valid JSON`, 'secondbrain-vault sync rewrites it', false);
  }
}

/** Each core feature names the tables its health check reads; a missing table is an error. */
async function checkFeatures(modules: ReadonlySet<string>, connected: boolean): Promise<Check[]> {
  if (!connected) return [];
  const out: Check[] = [];
  for (const m of enabledManifests(modules)) {
    if (!m.health) continue;
    const missing: string[] = [];
    for (const table of m.health.tables) {
      const { rows } = await pool.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
      if (!rows[0]?.present) missing.push(table);
    }
    out.push(
      missing.length
        ? fail(`feature:${m.name}`, `${m.health.label}: missing ${missing.join(', ')}`, 'secondbrain start applies the migrations')
        : pass(`feature:${m.name}`, m.health.label),
    );
  }
  return out;
}

/** The marker line `secondbrain-vault clis install` (tools/sbclis.py) writes into each wrapper it owns. */
const CLI_MARK = '# secondbrain-agent-cli:';

/** The first three lines of a regular file, or '' (a directory, an unreadable file). */
function head(path: string): string {
  try {
    if (!statSync(path).isFile()) return '';
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(512);
      return buf.subarray(0, readSync(fd, buf, 0, 512, 0)).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** The bundle a client wrapper execs: its `bundle=` line, unquoted the way shlex.quote quotes. */
function wrapperBundle(text: string): string | undefined {
  const m = /^bundle=(.*)$/m.exec(text);
  if (!m) return undefined;
  const v = m[1]!;
  return v.startsWith("'") ? v.slice(1, -1).replaceAll(`'"'"'`, "'") : v;
}

export interface AgentCliEnv {
  /** PATH to search; defaults to process.env.PATH. */
  path?: string;
  /** Where `secondbrain-vault clis install` writes; searched first. */
  binDir?: string;
  /** Whether BOARD_URL and BOARD_TOKEN reach cli-board here. */
  boardDoor?: boolean;
}

/**
 * Per wrapper the manifests name, what this machine has: installed (the server's deploy.sh wrapper, or the HTTPS
 * client), server-only (the one-line notice) or missing. Advisory: a laptop without them is still a working install.
 */
export function checkAgentClis(env: AgentCliEnv = {}): Check[] {
  const binDir = env.binDir ?? (process.env.SECONDBRAIN_BIN_DIR || join(homedir(), '.local', 'bin'));
  const dirs = [binDir, ...(env.path ?? process.env.PATH ?? '').split(delimiter).filter(Boolean)];
  const door = env.boardDoor ?? Boolean((process.env.BOARD_URL || config.boardUrl) && (process.env.BOARD_TOKEN || config.boardToken));
  return agentClis().map(({ name }) => {
    const key = `cli:${name}`;
    const found = dirs.map((d) => join(d, name)).find((p) => existsSync(p));
    if (!found) return fail(key, 'missing on this machine', 'secondbrain-vault clis install', false);
    const text = head(found);
    const mark = text.split('\n').slice(0, 3).find((l) => l.startsWith(CLI_MARK))?.slice(CLI_MARK.length).trim().split(/\s+/)[0];
    if (mark === 'server-only') return pass(key, `server-only on this machine (${found} says how to reach it)`);
    if (mark === 'https') {
      const bundle = wrapperBundle(text);
      if (!bundle || !existsSync(bundle)) return fail(key, `missing: ${found} has no bundle`, 'npm ci in app/, then secondbrain-vault clis install', false);
      if (!door) return fail(key, `installed (HTTPS) at ${found}, but BOARD_URL and BOARD_TOKEN are not set`, 'add both to the vault .env (docs/kanban-board.md, door 2)', false);
      return pass(key, `installed (HTTPS door) at ${found}`);
    }
    return pass(key, `installed at ${found}`);
  });
}

/**
 * Server-only checks. On a laptop they are skipped; against a deployed box the
 * route and the CLI both ask for them with deep:true. They shell out to
 * systemctl, which is absent locally, so they stay behind the flag.
 */
async function checkServer(deep: boolean, connected: boolean): Promise<Check[]> {
  if (!deep) return [skip('timers', 'skipped: pass --deep on the server'), skip('backup', 'skipped: pass --deep on the server')];
  const { runServerChecks } = await import('./doctor-server.js');
  return runServerChecks(connected);
}

export async function runChecks(opts: DoctorOptions = {}): Promise<Check[]> {
  const modules = opts.modules ?? config.modules;
  const checks: Check[] = [checkNode(), await checkDatabase()];
  const connected = checks[1]!.ok;
  checks.push(await checkPgvector(connected), await checkMigrations(connected), checkModules(modules), checkVault(), checkSettings(), checkSync());
  checks.push(...(await checkFeatures(modules, connected)), ...(await checkServer(opts.deep === true, connected)));
  if (opts.clis) checks.push(...checkAgentClis(opts.clis === true ? {} : opts.clis));
  return checks;
}

/** True when no critical check failed. */
export function healthy(checks: readonly Check[]): boolean {
  return checks.every((c) => c.ok || !c.critical);
}
