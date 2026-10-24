import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * The tool guard, in process. A port of the engine's `harness/hooks/guard.py`
 * with the same rules and the same `.agents/guard.local.json`, so a zen-agent
 * run is held to exactly what a Claude Code or Hermes session is held to.
 * Payloads use the Claude Code shape (`tool_name`, `tool_input`, `cwd`), so
 * the Python suite's cases replay here unchanged (see test/guard.test.ts).
 *
 * Built in, every vault: secrets files never reach a tool; no force push; no
 * `rsync --delete` without a dry run (the one rule a vault may disable).
 * Fails open: a payload it cannot read is allowed.
 */
export interface GuardPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface LocalRules {
  protected_dirs: { path: string; reason?: string }[];
  no_delete: { path: string; reason?: string }[];
  readonly: { pattern: string; reason?: string }[];
  disable: Set<string>;
}

const SHELL_TOOLS = new Set(['Bash', 'terminal', 'bash']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'read_file', 'search_files', 'list_dir']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'write_file', 'patch', 'edit_file']);
const SECRET_NAMES = new Set(['.env', 'auth.json', '.credentials.json']);
const READERS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'rg', 'awk', 'sed', 'echo', 'printf', 'cp', 'scp', 'rsync', 'xxd', 'od',
  'strings', 'base64', 'bat', 'nl', 'tee', 'diff', 'sort', 'uniq', 'wc', 'cut', 'jq', 'curl',
]);
const SECRET_TOKEN = /(?:^|[\s/"'=<>:])(?:\.env(?:\.(?!example\b)[\w.-]+)?|auth\.json|\.credentials\.json)(?=$|[\s"';|&)<>])/;
const SEGMENT_SPLIT = /&&|\|\||[;|\n]|\$\(|`/;
const EXCLUDE_ARG = /--(?:exclude|filter|include)(?:-from)?(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/g;
const DISABLEABLE = new Set(['rsync_dry_run']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time']);

export const EMPTY_RULES: LocalRules = { protected_dirs: [], no_delete: [], readonly: [], disable: new Set() };

/** `$SB_GUARD_LOCAL`, an explicit path, then the first `.agents/guard.local.json` up from cwd. */
export function findLocalRules(cwd: string, explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = [];
  if (env['SB_GUARD_LOCAL']) candidates.push(env['SB_GUARD_LOCAL']);
  if (explicit) candidates.push(explicit);
  let d = resolve(cwd);
  for (;;) {
    candidates.push(join(d, '.agents', 'guard.local.json'));
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function loadLocalRules(path: string | null): LocalRules {
  const rules: LocalRules = { protected_dirs: [], no_delete: [], readonly: [], disable: new Set() };
  if (!path) return rules;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return rules;
  }
  if (!data || typeof data !== 'object') return rules;
  const d = data as Record<string, unknown>;
  const pick = <T extends { path?: string; pattern?: string }>(key: string, field: 'path' | 'pattern'): T[] => {
    const items = d[key];
    if (!Array.isArray(items)) return [];
    return items.filter((i) => i && typeof i === 'object' && typeof (i as Record<string, unknown>)[field] === 'string' && (i as Record<string, unknown>)[field]) as T[];
  };
  rules.protected_dirs = pick('protected_dirs', 'path');
  rules.no_delete = pick('no_delete', 'path');
  rules.readonly = pick('readonly', 'pattern');
  if (Array.isArray(d['disable'])) rules.disable = new Set(d['disable'].filter((x): x is string => typeof x === 'string' && DISABLEABLE.has(x)));
  return rules;
}

export function isSecretPath(path: string): boolean {
  const base = basename(path.replace(/\/+$/, ''));
  return SECRET_NAMES.has(base) || (base.startsWith('.env.') && base !== '.env.example');
}

/** A small POSIX split: quotes group, backslash escapes; an unterminated quote falls back to whitespace. */
export function shellWords(segment: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < segment.length) {
      cur += segment[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) words.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return segment.split(/\s+/).filter(Boolean);
  if (cur || has) words.push(cur);
  return words;
}

function firstWord(segment: string): string {
  for (const w of shellWords(segment)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) continue;
    return basename(w);
  }
  return '';
}

const protectedReason = (item: { path: string; reason?: string }) =>
  `guard: ${item.reason || `${item.path} is off limits to agents (.agents/guard.local.json).`}`;

export function checkShell(cmd: string, rules: LocalRules): string | null {
  for (const item of rules.protected_dirs) {
    const d = item.path;
    if (cmd.includes(d) || (cmd + ' ').includes(d.replace(/\/+$/, '') + ' ')) return protectedReason(item);
  }
  for (const raw of cmd.split(SEGMENT_SPLIT)) {
    const seg = raw.trim().replace(/^\(+/, '').trim();
    if (!seg) continue;
    const word = firstWord(seg);
    if (READERS.has(word) && SECRET_TOKEN.test(seg.replace(EXCLUDE_ARG, ' '))) {
      return 'guard: that would print or copy a secrets file. Load keys with `set -a; . ./.env; set +a` and test variables instead (AGENTS.md, Credentials).';
    }
    if (word === 'rsync' && seg.includes('--delete') && !rules.disable.has('rsync_dry_run')) {
      const dry = seg.includes('--dry-run') || /(?:^|\s)-[A-Za-z]*n[A-Za-z]*(?=\s|$)/.test(seg);
      if (!dry) return "guard: rsync --delete without a dry run. Run it with -n first, read the 'deleting' lines, then ask the user before the real run.";
    }
    if (word === 'rm' || word === 'find' || word === 'trash' || word === 'rmdir') {
      for (const item of rules.no_delete) {
        if (seg.includes(item.path) && (word !== 'find' || seg.includes('-delete') || seg.includes('-exec'))) {
          return `guard: ${item.reason || `deleting under ${item.path} is blocked (.agents/guard.local.json).`}`;
        }
      }
    }
    if (word === 'git' && /\bpush\b/.test(seg)) {
      if (/(?:^|\s)(?:--force(?:-with-lease)?(?:=\S*)?|-f|-[A-Za-z]*f[A-Za-z]*)(?=\s|$)/.test(seg) || /\s\+\S+/.test(seg)) {
        return 'guard: force push is blocked. Other sessions and syncs share this repo; pull and merge instead.';
      }
    }
  }
  return null;
}

export function checkPath(tool: string, path: string, rules: LocalRules): string | null {
  if (!path) return null;
  for (const item of rules.protected_dirs) {
    if (path.startsWith(item.path) || path === item.path.replace(/\/+$/, '')) return protectedReason(item);
  }
  if (isSecretPath(path) && (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool))) {
    return "guard: secrets files can't be read or edited by agent tools. Source .env in a shell instead (AGENTS.md, Credentials).";
  }
  if (WRITE_TOOLS.has(tool)) {
    for (const item of rules.readonly) {
      try {
        if (new RegExp(item.pattern).test(path)) return `guard: ${item.reason || `${path} is read-only for agents (.agents/guard.local.json).`}`;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** The decision for one tool call: a reason to block, or null. */
export function decide(payload: GuardPayload, rules: LocalRules): string | null {
  try {
    const tool = payload.tool_name ?? '';
    const ti = payload.tool_input;
    if (!ti || typeof ti !== 'object') return null;
    if (SHELL_TOOLS.has(tool)) return checkShell(String(ti['command'] ?? ''), rules);
    if (!READ_TOOLS.has(tool) && !WRITE_TOOLS.has(tool)) return null;
    const path = ti['file_path'] ?? ti['path'] ?? ti['notebook_path'] ?? '';
    return checkPath(tool, String(path), rules);
  } catch {
    return null;
  }
}

/** A zen tool call as the Claude Code payload the guard and the hook commands read. */
export function toolPayload(name: string, args: unknown, cwd: string): GuardPayload | null {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const map: Record<string, [string, Record<string, unknown>]> = {
    bash: ['Bash', { command: a['command'] }],
    read_file: ['Read', { file_path: a['path'] }],
    list_dir: ['Glob', { path: a['path'] ?? '.' }],
    write_file: ['Write', { file_path: a['path'], content: a['content'] }],
    edit_file: ['Edit', { file_path: a['path'], old_string: a['old'], new_string: a['new'] }],
  };
  const m = map[name];
  return m ? { tool_name: m[0], tool_input: m[1], cwd } : null;
}

export function logBlock(logPath: string | null, agent: string, tool: string | undefined, reason: string): void {
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), agent, tool, reason }) + '\n');
  } catch {
    // A full disk must not stop the agent; the block itself still happens.
  }
}
