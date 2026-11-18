import { redactor } from '../../archive/redact.js';
import type { StepPart } from '../../archive/steps.js';
import type { Touched } from '../derive.js';
import { lines } from '../input.js';
import type { ModelSummary } from '../schema.js';

/**
 * Deterministic quality checks: no model, so they run in CI and on every sampled summary.
 * A check either passes or not; `weight` says how much a failure costs the 0 to 1 score.
 * What a rule cannot judge (is it faithful, is it complete) is the judge's job (judge.ts).
 */
export interface Check { name: string; pass: boolean; weight: number; detail?: string }
export interface CheckReport { score: number; checks: Check[] }

const STOP = new Set(['about', 'after', 'again', 'also', 'because', 'before', 'being', 'could', 'during', 'every', 'first', 'found', 'from', 'have', 'into', 'more', 'other', 'should', 'since', 'still', 'than', 'that', 'their', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until', 'using', 'were', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'session', 'agent']);
const PATH_RE = /(?:^|[\s("'`])((?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8})(?=$|[\s)"'`,.;:])/g;
const CARD_RE = /\bt_[0-9a-f]{8}\b/g;
const NUM_RE = /\b\d[\d,]*(?:\.\d+)?\b/g;

const words = (s: string): string[] => (s.toLowerCase().match(/[a-z][a-z0-9_-]{4,}/g) ?? []).filter((w) => !STOP.has(w));

/** What the model could have seen: the compacted lines plus the derived fields it never saw but a claim may legitimately repeat. */
export function haystack(parts: StepPart[], extra = ''): string {
  return `${lines(parts).join('\n')}\n${parts.filter((p) => p.step === 'tool_call').map((p) => p.text).join('\n')}\n${extra}`.toLowerCase();
}

function fields(s: ModelSummary): string {
  return [s.request, s.done, s.learned, s.open_items, ...s.facts.map((f) => `${f.subject} ${f.claim}`)].join('\n');
}

export function runChecks(summary: ModelSummary, parts: StepPart[], touched?: Touched): CheckReport {
  const hay = haystack(parts, touched ? JSON.stringify(touched) : '');
  const all = fields(summary);
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, weight: number, detail?: string) => checks.push({ name, pass, weight, ...(detail && !pass ? { detail } : {}) });

  add('has-request-and-done', Boolean(summary.request && summary.done), 3, 'request or done is empty');

  const paths = [...all.matchAll(PATH_RE)].map((m) => m[1]!).filter((p) => !p.startsWith('http'));
  const missingPaths = paths.filter((p) => !hay.includes(p.toLowerCase()) && !hay.includes(p.split('/').pop()!.toLowerCase()));
  add('paths-grounded', missingPaths.length === 0, 3, `not in the transcript: ${missingPaths.slice(0, 5).join(', ')}`);

  const cards = [...all.matchAll(CARD_RE)].map((m) => m[0]);
  const missingCards = cards.filter((c) => !hay.includes(c));
  add('cards-grounded', missingCards.length === 0, 3, `not in the transcript: ${missingCards.join(', ')}`);

  // Bare numbers of 3+ digits (counts, ports, sizes) must come from the transcript; 1 and 2 digit numbers are too common to judge.
  const nums = [...all.matchAll(NUM_RE)].map((m) => m[0].replace(/,/g, '')).filter((n) => n.replace('.', '').length >= 3);
  const hayNums = hay.replace(/,/g, '');
  const missingNums = nums.filter((n) => !hayNums.includes(n));
  add('numbers-grounded', missingNums.length === 0, 2, `not in the transcript: ${missingNums.slice(0, 5).join(', ')}`);

  // Each fact should be mostly made of words the transcript contains.
  const weakFacts = summary.facts.filter((f) => {
    const w = words(`${f.subject} ${f.claim}`);
    return w.length >= 3 && w.filter((x) => hay.includes(x)).length / w.length < 0.5;
  });
  add('facts-grounded', weakFacts.length === 0, 3, `weakly supported: ${weakFacts.map((f) => f.subject).slice(0, 3).join(', ')}`);

  add('no-secrets', redactor().text(all) === all, 5, 'a key-shaped string is in the summary');
  add('style', !/[—]|^#{1,6}\s|\*\*/m.test(all), 1, 'em-dash or markdown in the text');
  add('concise', summary.request.length + summary.done.length + summary.learned.length + summary.open_items.length <= 2400, 1, 'over 2400 characters');

  const errors = parts.filter((p) => p.step === 'tool_result');
  const tail = errors.slice(-3);
  const endedInErrors = tail.length === 3 && tail.every((p) => p.isError);
  add('outcome-vs-errors', !(summary.outcome === 'finished' && endedInErrors), 3, 'finished, but the last three tool results all failed');
  add('outcome-vs-silence', !(summary.outcome === 'finished' && !parts.some((p) => p.step === 'response')), 2, 'finished with no agent response');

  const total = checks.reduce((n, c) => n + c.weight, 0);
  const lost = checks.filter((c) => !c.pass).reduce((n, c) => n + c.weight, 0);
  return { score: total ? Math.round(((total - lost) / total) * 1000) / 1000 : 0, checks };
}

export interface Expectation {
  outcome?: ModelSummary['outcome'];
  /** Each group needs at least one alternative (case-insensitive) in request + done + learned + open_items. */
  mustMention?: string[][];
  mustNotMention?: string[];
  filesEdited?: string[];
  cards?: string[];
}

/** The golden-set half: what a person said a good summary of this transcript must contain. */
export function runExpectations(summary: ModelSummary, touched: Touched, expect: Expectation): CheckReport {
  const text = [summary.request, summary.done, summary.learned, summary.open_items].join('\n').toLowerCase();
  const checks: Check[] = [];
  if (expect.outcome) checks.push({ name: 'outcome', pass: summary.outcome === expect.outcome, weight: 3, detail: `expected ${expect.outcome}, got ${summary.outcome}` });
  (expect.mustMention ?? []).forEach((alts, i) => {
    const hit = alts.some((a) => text.includes(a.toLowerCase()));
    checks.push({ name: `mentions-${i + 1}`, pass: hit, weight: 2, detail: `none of: ${alts.join(' | ')}` });
  });
  for (const bad of expect.mustNotMention ?? []) {
    checks.push({ name: `omits-${bad}`, pass: !text.includes(bad.toLowerCase()), weight: 3, detail: `mentions "${bad}"` });
  }
  if (expect.filesEdited) checks.push({ name: 'files-edited', pass: JSON.stringify([...touched.files_edited].sort()) === JSON.stringify([...expect.filesEdited].sort()), weight: 2, detail: `got ${touched.files_edited.join(', ')}` });
  if (expect.cards) checks.push({ name: 'cards', pass: JSON.stringify([...touched.cards].sort()) === JSON.stringify([...expect.cards].sort()), weight: 2, detail: `got ${touched.cards.join(', ')}` });
  const total = checks.reduce((n, c) => n + c.weight, 0);
  const lost = checks.filter((c) => !c.pass).reduce((n, c) => n + c.weight, 0);
  return { score: total ? Math.round(((total - lost) / total) * 1000) / 1000 : 1, checks };
}
