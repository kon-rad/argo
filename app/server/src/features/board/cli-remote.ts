import { existsSync, readFileSync } from 'node:fs';
import { exitFlushed } from '../../cli-exit.js';
import { OrgError } from '../../org-error.js';
import { CLIENT_VERBS, HttpBoard, parseVerb, runVerb, USAGE } from './cli-core.js';
import { BoardError } from './service/errors.js';

/**
 * cli-board on a client machine: the HTTPS door only (docs/kanban-board.md, section 2, door 2). It is the entry of
 * the bundle `secondbrain-vault clis install` builds (bin/build-agent-clis.sh), so it must import nothing that loads
 * pg, config or db: no database, no /etc/secondbrain/env, no server build at run time.
 *
 * BOARD_URL and BOARD_TOKEN come from the environment, else from the vault .env the wrapper names in SB_VAULT_ENV.
 * That file is read literally (KEY=VALUE lines, never sourced) and only those two keys are taken. The token is sent
 * as a bearer header and never printed.
 */

const KEYS = ['BOARD_URL', 'BOARD_TOKEN'] as const;

/** BOARD_URL and BOARD_TOKEN from a dotenv file; other keys and comments are skipped, quotes stripped. */
export function readBoardEnv(path: string): Partial<Record<(typeof KEYS)[number], string>> {
  const found: Partial<Record<(typeof KEYS)[number], string>> = {};
  if (!existsSync(path)) return found;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || !(KEYS as readonly string[]).includes(m[1]!)) continue;
    let v = m[2]!;
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0]!)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (v) found[m[1] as (typeof KEYS)[number]] = v; // the last line wins, as with dotenv
  }
  return found;
}

/** The door's settings: the environment first, then the vault .env. `problem` is the one line to print when absent. */
export function remoteDoor(env: NodeJS.ProcessEnv): { url: string; token: string } | { problem: string } {
  const file = env.SB_VAULT_ENV ? readBoardEnv(env.SB_VAULT_ENV) : {};
  const url = env.BOARD_URL || file.BOARD_URL;
  const token = env.BOARD_TOKEN || file.BOARD_TOKEN;
  if (url && token) return { url: url.replace(/\/+$/, ''), token };
  const missing = [url ? '' : 'BOARD_URL', token ? '' : 'BOARD_TOKEN'].filter(Boolean).join(' and ');
  const where = env.SB_VAULT_ENV ? `the environment or ${env.SB_VAULT_ENV}` : 'the environment';
  return { problem: `cli-board: ${missing} not set in ${where}; add them to the vault .env (docs/kanban-board.md, door 2)` };
}

export async function remoteMain(argv: string[], out: (s: string) => void = console.log, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<number> {
  const { cmd, pos, opts } = parseVerb(argv);
  if (cmd === 'token' || cmd === 'import') throw new OrgError(`cli-board ${cmd} needs the database door: run it on the server`);
  if (!cmd || !CLIENT_VERBS.includes(cmd)) {
    out(USAGE);
    return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
  const door = remoteDoor(env);
  if ('problem' in door) throw new OrgError(door.problem);
  try {
    return (await runVerb(cmd, pos, opts, new HttpBoard(door.url, door.token, fetchFn), out))!;
  } catch (err) {
    // fetch's own failure is "fetch failed" with the reason in `cause`; say where it was going instead.
    if (err instanceof TypeError && err.message === 'fetch failed') {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new BoardError(`cli-board: cannot reach ${door.url} (${cause?.code ?? cause?.message ?? 'network error'})`);
    }
    if (err instanceof Error && err.name === 'TimeoutError') throw new BoardError(`cli-board: ${door.url} did not answer in 30 seconds`);
    throw err;
  }
}

/** The bundle's main: one line on stderr for any failure, never a stack trace. */
export async function runRemote(argv: string[]): Promise<never> {
  let code = 1;
  try {
    code = await remoteMain(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
  }
  return exitFlushed(code) as Promise<never>;
}
