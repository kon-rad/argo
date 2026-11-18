import { Verdict, digest, type Snapshot, type Source } from './gate.js';
import { POLICY } from './policy.js';

/** One reviewer call carries at most this much source text, measured as it is sent (JSON-escaped bytes), so a pass
 *  stays inside the reviewer transport's input bound. Size never rejects a PR: a larger one is reviewed in several passes. */
export const PASS_CHARS = POLICY.combinedChars;
const PARALLEL = 3, PROMPT_RESERVE_BYTES = 12_000, SHARED_TICKET_BYTES = 32_000;
const isDiff = (s: Source) => s.ref.startsWith('github:diff:');
const isCode = (s: Source) => s.ref.startsWith('github:source:');
/** `github:source:<40-hex revision>:<path>` */
const codePath = (ref: string) => ref.slice('github:source:'.length + 41);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const isTicket = (s: Source) => s.ref === 'ticket' || /^board:[^:]+:ticket$/.test(s.ref);
const isHistory = (s: Source) => /^board:[^:]+:earlier_findings(?::part-\d+-of-\d+)?$/.test(s.ref);
export const reviewTransportBytes = (s: Snapshot): number => bytes(s);

/** Git quotes paths as C strings; octal escapes represent bytes, not Unicode code points. */
function quotedPath(value: string): { path: string; end: number } {
  const chunks: Buffer[] = []; let literal = '', i = 1;
  const flush = () => { if (literal) { chunks.push(Buffer.from(literal)); literal = ''; } };
  const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  while (i < value.length) {
    const ch = value[i++]!;
    if (ch === '"') { flush(); return { path: Buffer.concat(chunks).toString('utf8'), end: i }; }
    if (ch !== '\\') { literal += ch; continue; }
    flush(); const escaped = value[i++];
    if (escaped && /[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && i < value.length && /[0-7]/.test(value[i]!)) octal += value[i++];
      const byte = parseInt(octal, 8);
      if (byte > 255) throw new Error('Invalid octal byte in quoted Git path');
      chunks.push(Buffer.from([byte]));
    } else if (escaped !== undefined && escapes[escaped] !== undefined) chunks.push(Buffer.from(escapes[escaped]!));
    else throw new Error('Invalid escape in quoted Git path');
  }
  throw new Error('Unterminated quoted Git path');
}
function pathValue(value: string, marker = false): string {
  if (!value.startsWith('"')) return marker ? value.split('\t', 1)[0]! : value;
  const parsed = quotedPath(value), tail = value.slice(parsed.end);
  if (tail && !(marker && tail.startsWith('\t'))) throw new Error('Unexpected text after quoted Git path');
  return parsed.path;
}
function prefixedPath(value: string, prefix: 'a/' | 'b/', marker = false): string {
  const path = pathValue(value, marker);
  if (!path.startsWith(prefix)) throw new Error('Missing canonical prefix in Git diff path');
  return path.slice(prefix.length);
}
function diffPath(text: string): string {
  const patch = text.slice(text.indexOf('diff --git '));
  const hunk = patch.search(/^@@(?: |$)|^GIT binary patch$|^Binary files /m);
  const lines = patch.slice(0, hunk < 0 ? patch.length : hunk).split('\n');
  // Only inspect extended/file headers, never hunk content resembling +++ or --- paths.
  const after = lines.find(line => line.startsWith('+++ '))?.slice(4);
  if (after !== undefined && after !== '/dev/null') return prefixedPath(after, 'b/', true);
  const before = lines.find(line => line.startsWith('--- '))?.slice(4);
  if (before !== undefined && before !== '/dev/null') return prefixedPath(before, 'a/', true);
  const moved = lines.find(line => /^(?:rename|copy) to /.test(line));
  if (moved) return pathValue(moved.replace(/^(?:rename|copy) to /, ''));
  const header = lines[0]!.slice('diff --git '.length);
  if (header.startsWith('"')) {
    const left = quotedPath(header), rest = header.slice(left.end);
    if (!left.path.startsWith('a/') || !rest.startsWith(' ')) throw new Error('Invalid quoted Git diff header');
    return prefixedPath(rest.slice(1), 'b/');
  }
  const quotedRight = header.indexOf(' "b/');
  if (quotedRight >= 0) return prefixedPath(header.slice(quotedRight + 1), 'b/');
  const separators = [...header.matchAll(/ b\//g)].map(match => match.index);
  // Unquoted spaces are legal. Identical source/destination paths disambiguate literal " b/" segments.
  const same = separators.find(split => header.startsWith('a/') && header.slice(2, split) === header.slice(split + 3));
  if (same !== undefined) return header.slice(same + 3);
  if (separators.length === 1) return header.slice(separators[0]! + 3);
  throw new Error('Ambiguous unquoted Git diff path without file or rename headers');
}
/** The aggregate diff as one chunk per file, in Git's order. Joining the chunks returns the input. */
export function splitDiff(diff: string): { path: string; text: string }[] {
  const starts = [...diff.matchAll(/^diff --git /gm)].map(m => m.index);
  if (!starts.length) return diff ? [{ path: '', text: diff }] : [];
  const chunks = starts.map((start, i) => diff.slice(i === 0 ? 0 : start, starts[i + 1] ?? diff.length));
  return chunks.map(text => ({ path: diffPath(text), text }));
}

export type TransportPart = { ref: string; path?: string; index: number; total: number; start: number; end: number };
export type InventoryPart = { index: number; total: number; start: number; end: number; text: string; repeatedEvidence?: true };
export type InventoryIdentity = { digest: string; sources: number; files: number; history: number; parts: number };
type Unit = { path: string | null; sources: Source[]; parts?: TransportPart[] };
const INVENTORY_PART_BYTES = 32_000;
function fragments(text: string, accepts: (part: string) => boolean): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  for (let start = 0; start < text.length;) {
    let low = start, high = text.length;
    while (low < high) {
      let end = Math.ceil((low + high) / 2);
      // Search only complete Unicode boundaries, so encoded size grows monotonically.
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end++;
      if (accepts(text.slice(start, end))) low = end;
      else {
        high = end - 1;
        const before = text.charCodeAt(high - 1);
        if (high < text.length && before >= 0xd800 && before <= 0xdbff) high--;
      }
    }
    if (low <= start) throw new Error('Reviewer transport cannot fit a complete character and its individual source identity');
    out.push({ text: text.slice(start, low), start, end: low }); start = low;
  }
  return out;
}
function inventoryOf(s: Snapshot, budget: number) {
  const files = [...new Set([
    ...s.sources.filter(isDiff).flatMap(d => splitDiff(d.text).map(c => c.path)),
    ...s.sources.filter(isCode).map(c => codePath(c.ref)),
  ])];
  const history = s.sources.filter(isHistory).map(x => x.ref), sources = s.sources.map(x => x.ref);
  const complete = { files, history, sources }, text = JSON.stringify(complete);
  const adaptive = 2 * bytes(complete) > Math.min(64_000, budget / 4);
  const chunks = adaptive ? fragments(text, part => bytes(part) <= INVENTORY_PART_BYTES - 512) : [];
  const parts: InventoryPart[] = chunks.map((part, i) => ({ ...part, index: i + 1, total: chunks.length }));
  const identity: InventoryIdentity = { digest: digest(text), sources: sources.length, files: files.length, history: history.length, parts: parts.length };
  return { ...complete, adaptive, parts, identity, reserve: adaptive ? 2 * INVENTORY_PART_BYTES + 2 * bytes(identity) : 2 * bytes(complete) };
}
/**
 * A complete bounded ticket stays shared. All other complete evidence is transported in order across
 * passes, including notes, builder evidence and oversized tickets. Inventories also use ordered parts
 * when a repeated full inventory would itself fill the call; every pass retains its digest and counts.
 */
export function partition(s: Snapshot, budget = PASS_CHARS): { snapshot: Snapshot; files: string[]; parts?: TransportPart[]; inventoryParts?: InventoryPart[] }[] {
  const units = new Map<string, Unit>();
  const unit = (path: string) => {
    if (!units.has(path)) units.set(path, { path, sources: [] });
    return units.get(path)!;
  };
  for (const d of s.sources.filter(isDiff)) for (const chunk of splitDiff(d.text)) unit(chunk.path).sources.push({ ...d, text: chunk.text });
  for (const c of s.sources.filter(isCode)) unit(codePath(c.ref)).sources.push(c);
  if (!Number.isSafeInteger(budget) || budget <= PROMPT_RESERVE_BYTES) throw new Error('Reviewer transport budget cannot fit its fixed identity metadata');
  // A single complete snapshot already carries its full source inventory without repeating it in a prompt.
  if (reviewTransportBytes(s) <= budget - PROMPT_RESERVE_BYTES) return [{ snapshot: s, files: [] }];
  const inventory = inventoryOf(s, budget);
  const payloadBudget = budget - PROMPT_RESERVE_BYTES - inventory.reserve;
  const ticket = s.sources.find(isTicket);
  const common = ticket && bytes(ticket) <= Math.min(SHARED_TICKET_BYTES, payloadBudget / 4) ? [ticket] : [];
  const snapshot = (items: Unit[]): Snapshot => ({ ...s, sources: [...common, ...items.flatMap(u => u.sources)] });
  const fits = (items: Unit[]) => reviewTransportBytes(snapshot(items))
    + 2 * bytes([...new Set(items.flatMap(u => u.path === null ? [] : [u.path]))])
    + 2 * bytes(items.flatMap(u => u.parts ?? [])) <= payloadBudget;
  if (!fits([])) throw new Error('Reviewer transport cannot fit its individual snapshot identity and status metadata');
  const ordered: Unit[] = [
    ...s.sources.filter(source => !common.includes(source) && !isDiff(source) && !isCode(source)).map(source => ({ path: null, sources: [source] })),
    ...[...units.values()].sort((a, b) => a.path! < b.path! ? -1 : a.path! > b.path! ? 1 : 0),
  ];
  const pieces: Unit[] = [];
  for (const u of ordered) {
    if (fits([u])) { pieces.push(u); continue; }
    for (const source of u.sources) {
      const whole = { path: u.path, sources: [source] };
      if (fits([whole])) { pieces.push(whole); continue; }
      const chunks = fragments(source.text, text => fits([{ path: u.path, sources: [{ ...source, text }],
        parts: [{ ref: source.ref, ...(u.path !== null ? { path: u.path } : {}), index: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER, start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER }] }]));
      if (!chunks.length) throw new Error(`Reviewer transport cannot fit individual source identity: ${source.ref}`);
      for (const [i, fragment] of chunks.entries()) pieces.push({ path: u.path, sources: [{ ...source, text: fragment.text }],
        parts: [{ ref: source.ref, ...(u.path !== null ? { path: u.path } : {}), index: i + 1, total: chunks.length, start: fragment.start, end: fragment.end }] });
    }
  }
  const groups: Unit[][] = [];
  // Give inventory parts room without replicating all evidence. Extra metadata-only passes retain a bounded ticket.
  const maxUnits = inventory.parts.length && pieces.length >= inventory.parts.length ? Math.max(1, Math.floor(pieces.length / inventory.parts.length)) : Infinity;
  for (const piece of pieces) {
    if (!groups.length || groups.at(-1)!.length >= maxUnits || !fits([...groups.at(-1)!, piece])) groups.push([]);
    groups.at(-1)!.push(piece);
  }
  while (groups.length < inventory.parts.length) groups.push([]);
  if (!groups.length) throw new Error('Reviewer transport has no reviewable evidence');
  return groups.map((group, i) => {
    const repeatedEvidence = !common.length && !group.length;
    if (repeatedEvidence) group = [pieces[0]!];
    const parts = group.flatMap(u => u.parts ?? []);
    const originalInventoryPart = inventory.parts[i];
    const inventoryPart = originalInventoryPart && repeatedEvidence ? { ...originalInventoryPart, repeatedEvidence: true as const } : originalInventoryPart;
    return { snapshot: snapshot(group), files: [...new Set(group.flatMap(u => u.path === null ? [] : [u.path]))],
      ...(parts.length ? { parts } : {}), ...(inventoryPart ? { inventoryParts: [inventoryPart] } : {}) };
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

export type Pass = { index: number; total: number; files: string[]; allFiles: string[]; allHistory?: string[]; allSources?: string[]; parts?: TransportPart[]; inventory?: InventoryIdentity; inventoryParts?: InventoryPart[] };
export type ReviewPass = (snapshot: Snapshot, evidence: string, pass: Pass) => Promise<unknown>;
/** Review a snapshot of any size. Passes run a few at a time; one failed pass fails the review, so nothing is accepted half-read. */
export async function reviewInPasses(s: Snapshot, evidence: string, review: ReviewPass, budget = PASS_CHARS): Promise<Verdict> {
  const passes = partition(s, budget), verdicts: Verdict[] = new Array(passes.length);
  const inventory = inventoryOf(s, budget);
  const adaptive = inventory.adaptive && passes.length > 1;
  const allFiles = adaptive ? [] : inventory.files;
  const allHistory = adaptive ? [] : inventory.history;
  const allSources = adaptive ? [] : inventory.sources;
  const identity = passes.length > 1 ? inventory.identity : { ...inventory.identity, parts: 0 };
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < passes.length; i = next++) verdicts[i] = Verdict.parse(await review(passes[i]!.snapshot, evidence, { index: i + 1, total: passes.length, files: passes[i]!.files, allFiles, allSources, inventory: identity, ...(passes[i]!.inventoryParts ? { inventoryParts: passes[i]!.inventoryParts } : {}), ...(allHistory.length ? { allHistory } : {}), ...(passes[i]!.parts ? { parts: passes[i]!.parts } : {}) }));
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, passes.length) }, worker));
  return mergeVerdicts(verdicts);
}
