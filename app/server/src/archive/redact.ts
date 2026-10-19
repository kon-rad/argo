import { existsSync, readFileSync } from 'node:fs';

/**
 * Keys never reach the archive. Every row the archive stores (content_text, raw, a
 * session's title and meta) passes through here first: exact values of the secret-named
 * variables this process can see (its environment plus REDACT_ENV_FILES), then common
 * key formats. Replacements name what was removed, never the value.
 */
export interface Redactor {
  text(s: string): string;
  deep<T>(v: T): T;
  values: Array<{ name: string; value: string }>;
}

/** `js` does the replacing; `pg` is a POSIX prefilter for finding stored rows that need it. */
export const PATTERNS: Array<{ name: string; js: RegExp; pg: string; keep?: number }> = [
  { name: 'private-key', js: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, pg: '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
  { name: 'anthropic', js: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g, pg: 'sk-ant-[A-Za-z0-9_-]{20}' },
  { name: 'openai', js: /(?<![A-Za-z0-9-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, pg: '(^|[^A-Za-z0-9-])sk-[A-Za-z0-9_-]{20}' },
  { name: 'github', js: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, pg: '(gh[pousr]_[A-Za-z0-9]{30}|github_pat_[A-Za-z0-9_]{30})' },
  { name: 'slack', js: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g, pg: 'xox[abprs]-[A-Za-z0-9-]{10}' },
  { name: 'aws', js: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g, pg: 'AKIA[0-9A-Z]{16}' },
  { name: 'google', js: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g, pg: 'AIza[0-9A-Za-z_-]{35}' },
  // Keep the scheme word: "Bearer [redacted:bearer]" still says what it was.
  { name: 'bearer', js: /(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, pg: 'Bearer\\s+[A-Za-z0-9._~+/=-]{20}', keep: 1 },
  // The password in scheme://user:password@host.
  { name: 'url-password', js: /([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@/"']{6,}(@)/gi, pg: '[a-z][a-z0-9+.-]*://[^[:space:]:/@]+:[^[:space:]@/]{6,}@', keep: 2 },
];

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|DSN)/i;
const MIN_LEN = 12;

function isSecret(name: string, value: string): boolean {
  if (value.length < MIN_LEN || /^[/~]/.test(value) || /\s/.test(value)) return false;
  if (SECRET_NAME.test(name)) return true;
  return /_URL$/i.test(name) && /:\/\/[^/@\s]+:[^/@\s]+@/.test(value);
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildRedactor(opts: { env: Record<string, string | undefined>; files?: string[] }): Redactor {
  const all: Record<string, string | undefined> = { ...opts.env };
  for (const f of opts.files ?? []) Object.assign(all, parseEnvFile(f));
  const seen = new Set<string>();
  const values: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(all)) {
    if (typeof value !== 'string' || !isSecret(name, value) || seen.has(value)) continue;
    seen.add(value);
    values.push({ name, value });
  }
  // Longest first, so a value that contains another one is replaced whole.
  values.sort((a, b) => b.value.length - a.value.length);
  const byValue = new Map(values.map((v) => [v.value, v.name]));
  const valueRe = values.length ? new RegExp(values.map((v) => escapeRe(v.value)).join('|'), 'g') : null;

  const text = (s: string): string => {
    if (!s) return s;
    let out = valueRe ? s.replace(valueRe, (m) => `[redacted:${byValue.get(m)}]`) : s;
    for (const p of PATTERNS) {
      out = out.replace(p.js, (...m: string[]) => p.keep === 1 ? `${m[1]}[redacted:${p.name}]`
        : p.keep === 2 ? `${m[1]}[redacted:${p.name}]${m[2]}` : `[redacted:${p.name}]`);
    }
    return out;
  };

  const deep = <T>(v: T): T => {
    if (typeof v === 'string') return text(v) as T;
    if (Array.isArray(v)) return v.map((x) => deep(x)) as T;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = deep(x);
      return o as T;
    }
    return v;
  };

  return { text, deep, values };
}

let cached: Redactor | null = null;

/** The process's redactor: its environment plus every file in REDACT_ENV_FILES (comma list). */
export function redactor(): Redactor {
  if (!cached) {
    const files = (process.env.REDACT_ENV_FILES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    cached = buildRedactor({ env: process.env, files });
  }
  return cached;
}

/** Tests: forget the cached redactor after changing the environment. */
export function resetRedactor(): void { cached = null; }
