import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { exitFlushed } from './cli-exit.js';
import { config } from './config.js';
import { settingsPath } from './settings.js';
import { type Env, type Exec, type Fs, formatStatus, status, TelegramSetup } from './telegram/setup.js';

// `secondbrain telegram`: connect a Telegram bot to an agent and keep it checked (docs/onboarding/11-telegram.md).
//   add --agent claude-code|hermes|zen-agent --name <bot> --allow <user id>[,<id>] [--username <bot>] [--persona <p>]
//       [--profile <hermes profile>] [--clear-at HH:MM] [--no-install]        token from stdin, or typed when asked (hidden)
//   status [--json]
//   allow add|remove <bot> <user id>[,<id>]
//   remove <bot> [--keep-token]
const [cmd, ...rest] = process.argv.slice(2);
const has = (f: string) => rest.includes(f);
const value = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] && !rest[i + 1]!.startsWith('--') ? rest[i + 1] : undefined;
};
const FLAGS = new Set(['--no-install', '--json', '--keep-token']);   // flags without a value; every other -- flag takes one
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--') && !FLAGS.has(rest[i - 1]!)));

const fs: Fs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, text, mode) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text, { mode: mode ?? 0o644 }); },
  remove: (p) => rmSync(p, { force: true }),
  chmod: (p, mode) => chmodSync(p, mode),
  mkdir: (p, mode) => mkdirSync(p, { recursive: true, mode: mode ?? 0o755 }),
};
const exec: Exec = {
  run: (c, args) => {
    try { return { code: 0, out: execFileSync(c, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (err) { const e = err as { status?: number; stdout?: string; stderr?: string }; return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
  },
};
const appRoot = resolve(import.meta.dirname, '..', '..');
const env: Env = {
  home: homedir(), user: userInfo().username, vaultDir: config.vaultRoot,
  templateDir: join(appRoot, 'deploy', 'telegram'),
  bridgeUnitTemplate: [join(appRoot, '..', 'addons', 'telegram-bridge', 'telegram-bridge.service'),
    join(config.vaultRoot, '.secondbrain', 'addons', 'telegram-bridge', 'telegram-bridge.service')].find((p) => existsSync(p))
    ?? join(config.vaultRoot, '.secondbrain', 'addons', 'telegram-bridge', 'telegram-bridge.service'),
  stateDir: process.env.SECONDBRAIN_TELEGRAM_DIR ?? join(homedir(), '.local', 'share', 'secondbrain', 'telegram'),
  settingsFile: settingsPath(),
  claudeBin: process.env.CLAUDE_BIN, hermesHome: process.env.HERMES_HOME,
};

/** The token from stdin when piped, else typed with echo off. Never printed, never in argv. */
async function readToken(): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').trim();
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const muted = rl as unknown as { _writeToOutput: (s: string) => void };
  const orig = muted._writeToOutput;
  process.stderr.write('bot token (from BotFather, not shown): ');
  muted._writeToOutput = () => {};
  const answer = await new Promise<string>((res) => rl.question('', res));
  muted._writeToOutput = orig;
  rl.close();
  process.stderr.write('\n');
  return answer.trim();
}

async function getMe(token: string): Promise<string | null | undefined> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 404) return null;
    const j = (await r.json()) as { ok?: boolean; result?: { username?: string } };
    return j.ok ? j.result?.username ?? '' : null;
  } catch { return undefined; }
}

async function sessions(bot: string | null): Promise<{ n: number; last: string | null } | null> {
  if (!process.env.DATABASE_URL && !process.env.SECONDBRAIN_DB_URL) return null;
  try {
    const { pool } = await import('./db.js');
    const { rows } = await pool.query<{ n: string; last: Date | null }>(
      `SELECT count(*) n, max(started_at) last FROM archive_sessions WHERE channel = 'telegram' AND ($1::text IS NULL OR meta ->> 'channel_bot' = $1)`, [bot]);
    return { n: Number(rows[0]?.n ?? 0), last: rows[0]?.last ? rows[0].last.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null };
  } catch { return null; }
}

const usage = 'usage: secondbrain telegram add --agent claude-code|hermes|zen-agent --name <bot> --allow <user id> [--username <bot>] [--persona <p>] [--profile <p>] [--clear-at HH:MM] [--no-install]\n' +
  '       secondbrain telegram status [--json] | allow add|remove <bot> <user id>[,<id>] | remove <bot> [--keep-token]';
const print = (steps: Array<{ what: string; ok: boolean; detail?: string }>) => {
  for (const s of steps) { console.log(`${s.ok ? '✓' : '✗'} ${s.what}`); if (s.detail) console.log(s.detail.split('\n').map((l) => `    ${l}`).join('\n')); }
};

let code = 0;
try {
  const setup = new TelegramSetup(fs, exec, env);
  if (cmd === 'add') {
    const agent = value('agent'); const name = value('name') ?? (agent === 'claude-code' ? 'claude' : agent === 'hermes' ? 'hermes' : agent === 'zen-agent' ? 'zen' : undefined);
    if (agent !== 'claude-code' && agent !== 'hermes' && agent !== 'zen-agent') throw new Error(`--agent must be claude-code, hermes or zen-agent\n${usage}`);
    if (!name) throw new Error(usage);
    const allow = rest.flatMap((a, i) => (a === '--allow' && rest[i + 1] ? [rest[i + 1]!] : []));
    const token = await readToken();
    print(setup.add({ name, agent, token, allow, username: value('username'), persona: value('persona'), profile: value('profile'), clearAt: value('clear-at'), noInstall: has('--no-install') }));
    console.log(`\nSend the bot a message, then: secondbrain telegram status`);
  } else if (cmd === 'status') {
    const r = await status({ fs, exec, env }, { getMe, sessions });
    if (has('--json')) console.log(JSON.stringify(r, null, 2));
    else console.log(formatStatus(r, config.publicOrigin ?? null));
    if (r.problems.length || r.bots.some((b) => b.problems.length)) code = 1;
  } else if (cmd === 'allow' && (positional[0] === 'add' || positional[0] === 'remove') && positional[1] && positional[2]) {
    print(setup.allow(positional[1], positional[0], positional.slice(2)));
  } else if (cmd === 'remove' && positional[0]) {
    print(setup.remove(positional[0], has('--keep-token')));
  } else {
    console.error(usage);
    code = 1;
  }
} catch (err) {
  console.error(`telegram: ${(err as Error).message}`);
  code = 1;
} finally {
  try { const { pool } = await import('./db.js'); await pool.end(); } catch { /* no database here */ }
}
await exitFlushed(code);
