import { query } from './db.js';

/**
 * Card signals for the model router (docs/org-routing.md, "The classifier"). Rules first: scope, named paths, repos,
 * spec clarity and risk flags are read from the card's title, body and contract by fixed patterns. An optional t0
 * model step may only make the spec-clarity reading stricter; it never touches risk, and any error falls back to rules.
 */

export interface ClassifyCard {
  id?: string;
  title: string;
  body?: string | null;
  kind?: string | null;
  work_type?: string | null;
  repo?: string | null;
  project_slug?: string | null;
  contract?: { objective?: string; returns?: string[]; scope?: string[]; verification?: string } | null;
}

export interface CardSignals {
  work: string;
  /** Files the router should assume: named files, a named directory counts as two, more than one repo is at least two. */
  scope: number;
  paths: string[];
  namedPath: boolean;
  repos: number;
  specClarity: 'low' | 'ok';
  /** What made the spec clear: acceptance criteria, a verification command, a path or URL. Empty when low. */
  clarity: string[];
  risk: 'normal' | 'high';
  riskFlags: string[];
  source: 'rules' | 'model';
  /** Why the model step did not run or was ignored, when it was asked for. */
  note?: string;
}

export interface ClassifierSettings {
  mode: 'rules' | 'model';
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const EXT = 'ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|swift|kt|java|c|h|cc|cpp|sql|md|json|ya?ml|toml|css|scss|html|vue|svelte|sh|env|pem|lock';
const URL_RE = /\bhttps?:\/\/[^\s`'")\]>]+/gi;
// A file: a token whose last segment has a known extension, with or without directories.
const FILE_RE = new RegExp(`(?:^|[\\s\`'"(\\[])((?:\\.{0,2}/)?(?:[\\w@.-]+/)*[\\w@-][\\w@.-]*\\.(?:${EXT}))(?=$|[\\s\`'"),:;\\]]|\\.(?:\\s|$))`, 'gim');
// A directory: a slash path in backticks, or one that ends in a slash (src/server/). Bare a/b prose ("and/or") is not one.
const DIR_RE = /`((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\/?)`|(?:^|[\s(])((?:\.{0,2}\/)?(?:[\w@.-]+\/)+)(?=$|[\s),:;])/gim;

const RISK: [flag: string, words: RegExp, paths: RegExp | null][] = [
  ['migration', /\b(migrat(e|es|ed|ing|ion|ions)|alter table|schema change)\b/i, /(^|\/)migrations?\/|\.sql$/i],
  ['auth', /\b(auth|authn|authz|authenticat\w*|authoriz\w*|oauth|login|jwt|rls|row level security)\b/i, /(^|\/)o?auth(\/|\.|-)/i],
  ['secret', /\b(secrets?|credentials?|passwords?|(api|private|secret|ssh|signing|access)[ _-]?keys?)\b/i, /(^|\/)\.env(\.|$)|\.pem$|(^|\/)secrets?\//i],
  ['payment', /\b(payments?|billing|invoices?|refunds?|stripe|money|wallets?|payouts?)\b/i, /(^|\/)(billing|payments?|wallets?)\//i],
  ['deploy', /\b(deploy\w*|rsync|release to)\b/i, /(^|\/)deploy[\w-]*(\/|\.)/i],
  ['prod', /\b(prod|production|live site|live server)\b/i, null],
];

const CMD = /`\$?\s*(npm|npx|pnpm|yarn|bun|node|tsx|vitest|jest|tsc|pytest|python3?|make|cargo|go|curl|bash|sh|psql|docker|\.\/)\b[^`]*`/i;
const ACCEPT = /\b(acceptance criteria|acceptance:|done when|definition of done|expected result|expected:)|^\s*[-*] \[[ x]\]/im;
const VERIFY = /^\s*(verify|verification|verified by|check|test)\s*:/im;

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.replace(/^\.\//, '')))];
}

/** The deterministic reading. Pure: the same card always gives the same signals. */
export function classifyRules(card: ClassifyCard): CardSignals {
  const contract = card.contract ?? {};
  const text = [card.title, card.body ?? '', contract.objective ?? ''].join('\n');
  const urls = text.match(URL_RE) ?? [];
  const bare = text.replace(URL_RE, ' ');

  const files = [...bare.matchAll(FILE_RE)].map((m) => m[1]!);
  const dirs = [...bare.matchAll(DIR_RE)].map((m) => m[1] ?? m[2] ?? '').filter((p) => p.includes('/') && !new RegExp(`\\.(?:${EXT})$`, 'i').test(p));
  for (const s of contract.scope ?? []) (new RegExp(`\\.(?:${EXT})$`, 'i').test(s) ? files : dirs).push(s);
  const fileSet = uniq(files);
  const dirSet = uniq(dirs).filter((d) => !fileSet.some((f) => f === d));
  const paths = [...fileSet, ...dirSet];

  const repoNames = new Set<string>();
  const repoName = (r: string): string => r.replace(/\.+$/, '').replace(/\.git$/, '').toLowerCase().split('/').pop()!;
  if (card.repo) repoNames.add(repoName(card.repo));
  for (const m of text.matchAll(/(?:--repo[ =]|github\.com\/)([\w.-]+(?:\/[\w.-]+)?)/gi)) repoNames.add(repoName(m[1]!));
  const repos = repoNames.size;

  let scope = fileSet.length + dirSet.length * 2;
  if (repos > 1) scope = Math.max(scope, 2);

  const clarity: string[] = [];
  if (ACCEPT.test(text) || (contract.returns?.length ?? 0) > 0) clarity.push('acceptance criteria');
  if (CMD.test(text) || VERIFY.test(text) || (contract.verification ?? '').trim()) clarity.push('verification command');
  if (paths.length || urls.length) clarity.push(paths.length ? 'path' : 'url');

  const riskFlags = RISK.filter(([, words, re]) => words.test(text) || (re !== null && paths.some((p) => re.test(p)))).map(([flag]) => flag);

  return {
    work: card.work_type ?? 'ops',
    scope,
    paths,
    namedPath: paths.length > 0,
    repos,
    specClarity: clarity.length ? 'ok' : 'low',
    clarity,
    risk: riskFlags.length ? 'high' : 'normal',
    riskFlags,
    source: 'rules',
  };
}

const PROMPT = `You grade the spec of a task card for a coding or writing agent. A spec is "ok" when an agent could start without asking a question: it says what done looks like, or names the files, or names a command that verifies it. Otherwise it is "low". Reply with JSON only: {"spec_clarity": "ok" | "low", "why": "<one short sentence>"}.`;

/**
 * Rules, then (mode `model`) a t0 model on an OpenAI-compatible /v1/chat/completions endpoint for spec clarity only.
 * The model can turn `ok` into `low`, never the reverse, and is not asked when the rules already say `low`.
 */
export async function classifyCard(card: ClassifyCard, cfg?: ClassifierSettings, fetchImpl: typeof fetch = fetch): Promise<CardSignals> {
  const rules = classifyRules(card);
  if (!cfg || cfg.mode !== 'model') return rules;
  if (!cfg.model || !cfg.baseUrl) return { ...rules, note: 'classifier mode is model but model or baseUrl is unset; rules only' };
  if (rules.specClarity === 'low') return rules;

  const url = `${cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: `Title: ${card.title}\n\n${(card.body ?? '').slice(0, 6000)}` },
        ],
      }),
    });
    if (!res.ok) return { ...rules, note: `classifier model HTTP ${res.status}; rules only` };
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = (data.choices?.[0]?.message?.content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed = JSON.parse(raw) as { spec_clarity?: unknown };
    if (parsed.spec_clarity !== 'ok' && parsed.spec_clarity !== 'low') return { ...rules, note: 'classifier model gave no spec_clarity; rules only' };
    if (parsed.spec_clarity === 'low') return { ...rules, specClarity: 'low', clarity: [], source: 'model' };
    return { ...rules, source: 'model' };
  } catch (err) {
    const why = err instanceof Error && err.name === 'AbortError' ? 'timed out' : err instanceof SyntaxError ? 'bad JSON' : 'failed';
    return { ...rules, note: `classifier model ${why}; rules only` };
  } finally {
    clearTimeout(timer);
  }
}

/** The card as the classifier reads it, from the board's `cards` table. */
export async function loadCard(id: string): Promise<ClassifyCard | null> {
  const { rows } = await query<ClassifyCard>(
    `SELECT id, title, body, kind, work_type, repo, project_slug, contract FROM cards WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
