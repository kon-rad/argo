/** Bounded context-free observations, not full-file replacements or executable patches. */
export interface ChangedHunk { oldStart: number; newStart: number; deleted: string[]; added: string[] }
export type DiffReason = 'input-limit' | 'line-limit' | 'output-limit' | 'binary' | 'unsafe-text' | 'empty-change';
export type ChangedLines = { format: 'changed-lines'; context: 0; redacted: true } & (
  { truncated: false; hunks: ChangedHunk[] } | { truncated: true; reason: DiffReason });

// Redact the entire changed line, including adjacent code, rather than guessing a
// credential's quotation/escaping boundaries. This is best effort, not a secret-free trace.
const sensitive = /(?:credential|password|passwd|secret|token|api[_-]?key|authorization|private[_ -]?key)|\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{15,}|github_pat_[\w]+|AKIA[A-Z0-9]{16}|AIza[\w-]{20,}|xox[abprs]-[\w-]+)|\bBearer\s+\S+|[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i;
const secretName = /(?:^|_)(?:KEY|KEYS|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|PRIVATE|DSN|PAT)(?:_|$)/i;

export function changedLines(before: Buffer | null, after: Buffer, env: NodeJS.ProcessEnv = process.env): ChangedLines {
  const unavailable = (reason: DiffReason): ChangedLines => ({ format: 'changed-lines', context: 0, redacted: true, truncated: true, reason });
  if ((before?.length ?? 0) > 65536 || after.length > 65536) return unavailable('input-limit');
  let old: string, next: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    old = before === null ? '' : decoder.decode(before); next = decoder.decode(after);
  } catch { return unavailable('binary'); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(old + next)) return unavailable('binary');
  // Multiline secrets can have unrecognizable continuation lines: retain hashes only.
  if (/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/.test(old + next)) return unavailable('unsafe-text');
  const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = lines(old), b = lines(next);
  if (a.length > 512 || b.length > 512 || [...a, ...b].some(s => Buffer.byteLength(s) > 4096)) return unavailable('line-limit');
  const secrets = Object.entries(env).filter(([name, value]) => (secretName.test(name) || /_URL$/i.test(name) && /:\/\/[^/@\s]+:[^/@\s]+@/.test(value ?? '')) && value && value.length >= 8 && value.length <= 65536).map(([, value]) => value!);
  if (secrets.some(value => /[\r\n]/.test(value) && (old.includes(value) || next.includes(value)))) return unavailable('unsafe-text');
  const redact = (line: string): string => sensitive.test(line) || secrets.some(value => line.includes(value))
    ? `[redacted:sensitive-line]${line.endsWith('\n') ? '\n' : ''}` : line;
  // At most 513*513 cells. Equal lines are context and never serialized.
  const width = b.length + 1, lengths = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lengths[i * width + j] = a[i] === b[j] ? lengths[(i + 1) * width + j + 1]! + 1
      : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
  }
  const hunks: ChangedHunk[] = [];
  let i = 0, j = 0, current: ChangedHunk | undefined;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; current = undefined; continue; }
    if (!current) { current = { oldStart: i + 1, newStart: j + 1, deleted: [], added: [] }; hunks.push(current); }
    if (i < a.length && (j === b.length || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)) current.deleted.push(redact(a[i++]!));
    else current.added.push(redact(b[j++]!));
  }
  if (!hunks.length) return unavailable('empty-change');
  const result: ChangedLines = { format: 'changed-lines', context: 0, redacted: true, truncated: false, hunks };
  return Buffer.byteLength(JSON.stringify(result)) > 16384 ? unavailable('output-limit') : result;
}
