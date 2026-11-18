import type { StepPart } from '../../archive/steps.js';
import type { ChainDeps } from '../chain.js';
import type { SummaryConfig } from '../config.js';
import { deriveTouched } from '../derive.js';
import { generate } from '../generate.js';
import { compact } from '../input.js';
import type { ModelSummary } from '../schema.js';
import { runChecks, runExpectations, type CheckReport } from './checks.js';
import { toParts, type GoldenCase } from './golden.js';
import { judge, verdictScore, type JudgeVerdict } from './judge.js';

export interface Graded {
  id: string;
  writer: string;
  checks: CheckReport;
  expectations: CheckReport | null;
  verdict: JudgeVerdict | null;
  /** Why the judge gave no verdict (all judge providers failed); the case is then scored on the checks alone. */
  judgeError: string | null;
  judgeScore: number | null;
  /** The number the gate uses: the mean of the parts that ran. */
  score: number;
  summary: ModelSummary;
  inputTokens: number | null;
  outputTokens: number | null;
}

export function combine(parts: Array<number | null>): number {
  const v = parts.filter((x): x is number => x !== null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : 0;
}

/** Grades one summary of one transcript. `golden` adds the case's expectations. */
export async function grade(
  id: string, summary: ModelSummary, parts: StepPart[], cfg: SummaryConfig,
  opts: { golden?: GoldenCase; judge?: boolean; judgeChain?: SummaryConfig['chain']; deps?: ChainDeps; writer?: string; tokens?: [number | null, number | null] } = {},
): Promise<Graded> {
  const touched = deriveTouched(parts);
  const checks = runChecks(summary, parts, touched);
  const expectations = opts.golden ? runExpectations(summary, touched, opts.golden.expect) : null;
  let verdict: JudgeVerdict | null = null;
  let judgeError: string | null = null;
  if (opts.judge) {
    try {
      const input = compact(parts, cfg.maxInputChars);
      verdict = (await judge(input.text, summary, opts.judgeChain ?? cfg.chain, opts.deps)).verdict;
    } catch (err) {
      judgeError = (err as Error).message.slice(0, 300);
    }
  }
  const judgeScore = verdict ? verdictScore(verdict) : null;
  return {
    id, writer: opts.writer ?? 'unknown', checks, expectations, verdict, judgeError, judgeScore,
    score: combine([checks.score, expectations?.score ?? null, judgeScore]),
    summary, inputTokens: opts.tokens?.[0] ?? null, outputTokens: opts.tokens?.[1] ?? null,
  };
}

/** Writes a summary for each golden case with the real chain, then grades it. */
export async function runGolden(
  cases: GoldenCase[], cfg: SummaryConfig, opts: { judge?: boolean; judgeChain?: SummaryConfig['chain']; deps?: ChainDeps } = {},
): Promise<Graded[]> {
  const out: Graded[] = [];
  for (const c of cases) {
    const parts = toParts(c);
    const g = await generate(compact(parts, cfg.maxInputChars).text, { harness: c.harness }, cfg, opts.deps);
    out.push(await grade(c.id, g.summary, parts, cfg, { golden: c, ...opts, writer: `${g.provider}/${g.model}`, tokens: [g.inputTokens, g.outputTokens] }));
  }
  return out;
}

/** Proves the checks themselves: each case's hand-written reference must clear its own bar. */
export async function gradeReferences(cases: GoldenCase[], cfg: SummaryConfig): Promise<Graded[]> {
  const out: Graded[] = [];
  for (const c of cases) {
    if (!c.reference) continue;
    out.push(await grade(c.id, { ...c.reference, facts: c.reference.facts }, toParts(c), cfg, { golden: c, writer: 'reference' }));
  }
  return out;
}

export function report(graded: Graded[], title: string): string {
  const mean = combine(graded.map((g) => g.score));
  const rows = graded.map((g) => {
    const failed = [...g.checks.checks, ...(g.expectations?.checks ?? [])].filter((c) => !c.pass).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`);
    if (g.verdict?.unsupported.length) failed.push(`judge: unsupported - ${g.verdict.unsupported.slice(0, 3).join('; ')}`);
    const j = g.verdict ? `${g.verdict.faithful}/${g.verdict.complete}/${g.verdict.concise}/${g.verdict.outcome_correct}` : g.judgeError ? 'failed' : '-';
    return `| ${g.id} | ${g.writer} | ${g.score.toFixed(2)} | ${g.checks.score.toFixed(2)} | ${g.expectations ? g.expectations.score.toFixed(2) : '-'} | ${j} | ${failed.join('; ') || 'none'} |`;
  });
  return [
    `# ${title}`, '',
    `Mean score ${mean.toFixed(3)} over ${graded.length} summaries.`, '',
    '| Case | Writer | Score | Checks | Expectations | Judge F/C/Co/O | Failed |',
    '|---|---|---|---|---|---|---|', ...rows, '',
  ].join('\n');
}
