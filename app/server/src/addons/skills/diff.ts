/**
 * A bounded line diff for change previews (unified format, 3 lines of context). Files over the bound
 * are reported by size and hash only rather than diffed slowly.
 */
const MAX_LINES = 4000;

export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const a = before === null ? [] : before.split('\n');
  const b = after === null ? [] : after.split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) return `--- a/${path}\n+++ b/${path}\n(too large to show: ${a.length} -> ${b.length} lines)\n`;
  // LCS table on the trimmed middle (common prefix and suffix removed first).
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (A.length * B.length > 4_000_000) return `--- a/${path}\n+++ b/${path}\n(too many changes to show line by line)\n`;
  const dp: Uint32Array[] = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ t: ' ', s: a[k]!, ai: k, bi: k });
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { ops.push({ t: ' ', s: A[i]!, ai: pre + i, bi: pre + j }); i++; j++; }
    else if (j < B.length && (i >= A.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) { ops.push({ t: '+', s: B[j]!, ai: pre + i, bi: pre + j }); j++; }
    else { ops.push({ t: '-', s: A[i]!, ai: pre + i, bi: pre + j }); i++; }
  }
  for (let k = 0; k < suf; k++) ops.push({ t: ' ', s: a[a.length - suf + k]!, ai: a.length - suf + k, bi: b.length - suf + k });
  const out = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`];
  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return '';
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, changed[k]! - 3);
    let end = Math.min(ops.length - 1, changed[k]! + 3);
    while (k + 1 < changed.length && changed[k + 1]! - 3 <= end + 1) { k++; end = Math.min(ops.length - 1, changed[k]! + 3); }
    const hunk = ops.slice(start, end + 1);
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${hunk[0]!.ai + (aLen ? 1 : 0)},${aLen} +${hunk[0]!.bi + (bLen ? 1 : 0)},${bLen} @@`);
    for (const o of hunk) out.push(`${o.t}${o.s}`);
    k++;
    start = end;
  }
  return `${out.join('\n')}\n`;
}
