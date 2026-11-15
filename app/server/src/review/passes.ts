import { Verdict, type Snapshot, type Source } from './gate.js';
import { POLICY } from './policy.js';

/** One reviewer call carries at most this much source text, measured as it is sent (JSON-escaped bytes), so a pass
 *  stays inside the reviewer transport's input bound. Size never rejects a PR: a larger one is reviewed in several passes. */
export const PASS_CHARS = POLICY.combinedChars;
const MIN_CODE_CHARS = 100_000, PARALLEL = 3;
const isDiff = (s: Source) => s.ref.startsWith('github:diff:');
const isCode = (s: Source) => s.ref.startsWith('github:source:');
/** `github:source:<40-hex revision>:<path>` */
const codePath = (ref: string) => ref.slice('github:source:'.length + 41);
const sent = (text: string) => Buffer.byteLength(JSON.stringify(text));

/** The aggregate diff as one chunk per file, in Git's order. Joining the chunks returns the input. */
export function splitDiff(diff: string): { path: string; text: string }[] {
  const starts = [...diff.matchAll(/^diff --git /gm)].map(m => m.index);
  if (!starts.length) return diff ? [{ path: '', text: diff }] : [];
  const chunks = starts.map((start, i) => diff.slice(i === 0 ? 0 : start, starts[i + 1] ?? diff.length));
  return chunks.map(text => {
    const header = text.slice(text.indexOf('diff --git ')).split('\n', 1)[0]!;
    const split = header.lastIndexOf(' b/');
    return { path: split < 0 ? '' : header.slice(split + 3).trim(), text };
  });
}

type Unit = { path: string; chars: number; diff: string[]; code: Source[] };
/**
 * Split one snapshot into reviewer passes. Ticket, notes and builder evidence go into every pass; each file's diff
 * travels with its source, and files are packed in path order so neighbours are read together. A snapshot that fits
 * one call is returned unchanged.
 */
export function partition(s: Snapshot, budget = PASS_CHARS): { snapshot: Snapshot; files: string[] }[] {
  const size = (list: Source[]) => list.reduce((n, x) => n + sent(x.text), 0);
  if (size(s.sources) <= budget) return [{ snapshot: s, files: [] }];
  const context = s.sources.filter(x => !isDiff(x) && !isCode(x));
  const room = Math.max(MIN_CODE_CHARS, budget - size(context));
  const units = new Map<string, Unit>();
  const unit = (path: string) => { if (!units.has(path)) units.set(path, { path, chars: 0, diff: [], code: [] }); return units.get(path)!; };
  for (const d of s.sources.filter(isDiff)) for (const chunk of splitDiff(d.text)) { const u = unit(chunk.path); u.diff.push(chunk.text); u.chars += sent(chunk.text); }
  for (const c of s.sources.filter(isCode)) { const u = unit(codePath(c.ref)); u.code.push(c); u.chars += sent(c.text); }
  const groups: Unit[][] = [];
  let used = 0;
  for (const u of [...units.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    // A file larger than a pass still gets its own pass, whole: it is never cut or dropped.
    if (!groups.length || used + u.chars > room) { groups.push([]); used = 0; }
    groups.at(-1)!.push(u); used += u.chars;
  }
  const template = s.sources.find(isDiff);
  return groups.map(group => {
    const text = group.flatMap(u => u.diff).join('');
    return { files: group.map(u => u.path), snapshot: { ...s, sources: [...context, ...(template && text ? [{ ...template, text }] : []), ...group.flatMap(u => u.code)] } };
  });
}

const RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
/** One verdict from every pass. Any rejection rejects; findings are kept most severe first. */
export function mergeVerdicts(verdicts: Verdict[]): Verdict {
  const first = verdicts[0];
  if (!first) throw new Error('Review produced no verdict');
  if (verdicts.length === 1) return first;
  for (const v of verdicts) {
    if ((['reviewer', 'repo', 'pr', 'head', 'base', 'evidence'] as const).some(k => v[k] !== first[k])) throw new Error('Review passes are bound to different revisions or evidence');
    if ((v.decision === 'accept') !== (v.findings.length === 0)) throw new Error('Verdict contradicts blocking findings');
  }
  const findings = verdicts.flatMap((v, i) => v.findings.map(f => ({ f, i }))).sort((a, b) => RANK[a.f.severity] - RANK[b.f.severity] || a.i - b.i).map(x => x.f);
  const dropped = findings.length - 30;
  const kept = dropped > 0 ? findings.slice(0, 30) : findings;
  if (dropped > 0) kept[29] = { ...kept[29]!, evidence: `${kept[29]!.evidence} (${dropped} further lower-ranked findings from the other passes are not listed; they return on the next review.)` };
  const merged = (key: keyof Verdict['categories']) => {
    const parts = verdicts.map(v => v.categories[key]);
    return { status: parts.some(c => c.status === 'checked') ? 'checked' as const : 'not-applicable' as const,
      evidence: [...new Set(parts.flatMap(c => c.evidence))].slice(0, 60),
      rationale: parts.map((c, i) => `Pass ${i + 1}/${parts.length}: ${c.rationale.slice(0, 1200)}`).join('\n') };
  };
  return Verdict.parse({ ...first, decision: kept.length ? 'reject' : 'accept', findings: kept,
    categories: { security: merged('security'), compatibility: merged('compatibility'), migrations: merged('migrations'), regressions: merged('regressions'),
      scope: merged('scope'), placeholders: merged('placeholders'), tests: { ...merged('tests'), status: 'checked' } } });
}

export type Pass = { index: number; total: number; files: string[]; allFiles: string[] };
export type ReviewPass = (snapshot: Snapshot, evidence: string, pass: Pass) => Promise<unknown>;
/** Review a snapshot of any size. Passes run a few at a time; one failed pass fails the review, so nothing is accepted half-read. */
export async function reviewInPasses(s: Snapshot, evidence: string, review: ReviewPass, budget = PASS_CHARS): Promise<Verdict> {
  const passes = partition(s, budget), verdicts: Verdict[] = new Array(passes.length);
  const allFiles = passes.flatMap(p => p.files);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < passes.length; i = next++) verdicts[i] = Verdict.parse(await review(passes[i]!.snapshot, evidence, { index: i + 1, total: passes.length, files: passes[i]!.files, allFiles }));
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, passes.length) }, worker));
  return mergeVerdicts(verdicts);
}
