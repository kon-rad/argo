import { Verdict, type Snapshot, type Source } from './gate.js';
import { POLICY } from './policy.js';

/** One reviewer call carries at most this much source text, measured as it is sent (JSON-escaped bytes), so a pass
 *  stays inside the reviewer transport's input bound. Size never rejects a PR: a larger one is reviewed in several passes. */
export const PASS_CHARS = POLICY.combinedChars;
const PARALLEL = 3, PROMPT_RESERVE_BYTES = 12_000;
const isDiff = (s: Source) => s.ref.startsWith('github:diff:');
const isCode = (s: Source) => s.ref.startsWith('github:source:');
/** `github:source:<40-hex revision>:<path>` */
const codePath = (ref: string) => ref.slice('github:source:'.length + 41);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const isHistory = (s: Source) => /^board:[^:]+:earlier_findings(?::part-\d+-of-\d+)?$/.test(s.ref);
export const reviewTransportBytes = (s: Snapshot): number => bytes(s);

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

export type TransportPart = { ref: string; index: number; total: number; start: number; end: number };
type Unit = { path: string | null; sources: Source[]; parts?: TransportPart[] };
/**
 * Ticket, notes and builder evidence stay shared. Ordered prior-finding sources are reviewed once across
 * passes, rather than repeated in every call. File diffs travel with their source when they fit; oversized
 * units are transported in explicitly identified, Unicode-safe parts, never omitted or marked truncated.
 */
export function partition(s: Snapshot, budget = PASS_CHARS): { snapshot: Snapshot; files: string[]; parts?: TransportPart[] }[] {
  const allPaths = new Set<string>();
  const units = new Map<string, Unit>();
  const unit = (path: string) => {
    allPaths.add(path);
    if (!units.has(path)) units.set(path, { path, sources: [] });
    return units.get(path)!;
  };
  for (const d of s.sources.filter(isDiff)) for (const chunk of splitDiff(d.text)) unit(chunk.path).sources.push({ ...d, text: chunk.text });
  for (const c of s.sources.filter(isCode)) unit(codePath(c.ref)).sources.push(c);
  // Reserve room for the fixed adapter instructions, binding and both file lists in its prompt.
  const historyRefs = s.sources.filter(isHistory).map(x => x.ref);
  const overhead = PROMPT_RESERVE_BYTES + 2 * bytes([...allPaths]) + 2 * bytes(historyRefs);
  if (!Number.isSafeInteger(budget) || budget <= overhead) throw new Error('Reviewer transport budget cannot fit its identity and file-list metadata');
  const payloadBudget = budget - overhead;
  if (reviewTransportBytes(s) <= payloadBudget) return [{ snapshot: s, files: [] }];
  const common = s.sources.filter(x => !isDiff(x) && !isCode(x) && !isHistory(x));
  const snapshot = (items: Unit[]): Snapshot => ({ ...s, sources: [...common, ...items.flatMap(u => u.sources)] });
  const fits = (items: Unit[]) => reviewTransportBytes(snapshot(items)) <= payloadBudget;
  if (!fits([])) throw new Error('Essential shared reviewer context exceeds the transport budget; reduce registered shared context without dropping required evidence');
  const ordered: Unit[] = [
    ...s.sources.filter(isHistory).map(source => ({ path: null, sources: [source] })),
    ...[...units.values()].sort((a, b) => a.path! < b.path! ? -1 : a.path! > b.path! ? 1 : 0),
  ];
  const pieces: Unit[] = [];
  for (const u of ordered) {
    if (fits([u])) { pieces.push(u); continue; }
    for (const source of u.sources) {
      const whole = { path: u.path, sources: [source] };
      if (fits([whole])) { pieces.push(whole); continue; }
      const fragments: { text: string; start: number; end: number }[] = [];
      for (let start = 0; start < source.text.length;) {
        let low = start, high = source.text.length;
        while (low < high) {
          const end = Math.ceil((low + high) / 2);
          if (fits([{ path: u.path, sources: [{ ...source, text: source.text.slice(start, end) }] }])) low = end;
          else high = end - 1;
        }
        let end = low;
        const last = source.text.charCodeAt(end - 1);
        if (end < source.text.length && last >= 0xd800 && last <= 0xdbff) end--;
        if (end <= start) throw new Error(`Reviewer transport cannot fit source identity and a complete character: ${source.ref}`);
        fragments.push({ text: source.text.slice(start, end), start, end }); start = end;
      }
      if (!fragments.length) throw new Error(`Reviewer transport cannot fit source identity: ${source.ref}`);
      for (const [i, fragment] of fragments.entries()) pieces.push({ path: u.path, sources: [{ ...source, text: fragment.text }],
        parts: [{ ref: source.ref, index: i + 1, total: fragments.length, start: fragment.start, end: fragment.end }] });
    }
  }
  const groups: Unit[][] = [];
  for (const piece of pieces) {
    if (!groups.length || !fits([...groups.at(-1)!, piece])) groups.push([]);
    groups.at(-1)!.push(piece);
  }
  if (!groups.length) throw new Error('Reviewer transport has no reviewable units');
  return groups.map(group => {
    const parts = group.flatMap(u => u.parts ?? []);
    return { snapshot: snapshot(group), files: [...new Set(group.flatMap(u => u.path === null ? [] : [u.path]))], ...(parts.length ? { parts } : {}) };
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

export type Pass = { index: number; total: number; files: string[]; allFiles: string[]; allHistory?: string[]; parts?: TransportPart[] };
export type ReviewPass = (snapshot: Snapshot, evidence: string, pass: Pass) => Promise<unknown>;
/** Review a snapshot of any size. Passes run a few at a time; one failed pass fails the review, so nothing is accepted half-read. */
export async function reviewInPasses(s: Snapshot, evidence: string, review: ReviewPass, budget = PASS_CHARS): Promise<Verdict> {
  const passes = partition(s, budget), verdicts: Verdict[] = new Array(passes.length);
  const allFiles = [...new Set(passes.flatMap(p => p.files))];
  const allHistory = s.sources.filter(isHistory).map(x => x.ref);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < passes.length; i = next++) verdicts[i] = Verdict.parse(await review(passes[i]!.snapshot, evidence, { index: i + 1, total: passes.length, files: passes[i]!.files, allFiles, ...(allHistory.length ? { allHistory } : {}), ...(passes[i]!.parts ? { parts: passes[i]!.parts } : {}) }));
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, passes.length) }, worker));
  return mergeVerdicts(verdicts);
}
