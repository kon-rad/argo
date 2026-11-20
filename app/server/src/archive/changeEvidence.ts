import { z } from 'zod';
import type { ChangeEvidence } from '@secondbrain/contracts/observatory';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(1024).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(s => s === '..' || s === '.' || s === '') && !/[\x00-\x1f]/.test(p));
const changedLine = z.string().min(1).max(4096).refine(line => Buffer.byteLength(line) <= 4096 && !line.slice(0, -1).includes('\n'));
const hunk = z.object({ oldStart: z.number().int().min(1).max(513), newStart: z.number().int().min(1).max(513),
  deleted: z.array(changedLine).max(512), added: z.array(changedLine).max(512) }).strict();
const diffSchema = z.union([
  z.object({ format: z.literal('replacement'), before: z.string().max(16384).optional(), after: z.string().max(16384).optional(), truncated: z.boolean() }).strict(),
  z.object({ format: z.literal('changed-lines'), context: z.literal(0), redacted: z.literal(true), truncated: z.literal(false), hunks: z.array(hunk).min(1).max(512) }).strict(),
  z.object({ format: z.literal('changed-lines'), context: z.literal(0), redacted: z.literal(true), truncated: z.literal(true),
    reason: z.enum(['input-limit', 'line-limit', 'output-limit', 'binary', 'unsafe-text']) }).strict(),
]);
const capture = z.object({ version: z.literal(1), id: z.string().min(1).max(128), repository: hash, worktree: hash, path,
  before: hash.nullable(), after: hash,
  diff: diffSchema,
  commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), verification: z.literal('local-object'), authorship: z.literal('unknown') }).strict().optional(),
}).strict();
/** Only the runtime-owned result details, never tool arguments, prose or shell strings. */
export function capturedChange(raw: unknown): ChangeEvidence | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>, m = r.message;
  if (r.harness !== 'zen-agent' || r.type !== 'message' || m?.role !== 'toolResult' || m.isError !== false) return null;
  if (!['write_file', 'edit_file', 'inspect_change_commit'].includes(m.toolName)) return null;
  const parsed = capture.safeParse(m.details?.change);
  if (!parsed.success) return null;
  const c = parsed.data;
  if (c.before === c.after || !!c.commit !== (m.toolName === 'inspect_change_commit')) return null;
  if (c.diff.format === 'replacement' && !c.diff.truncated && (c.diff.before === undefined || c.diff.after === undefined || new TextEncoder().encode(c.diff.before).length + new TextEncoder().encode(c.diff.after).length > 16384)) return null;
  if (c.diff.format === 'changed-lines' && !c.diff.truncated) {
    if (Buffer.byteLength(JSON.stringify(c.diff)) > 16384 || c.diff.hunks.reduce((n, h) => n + h.deleted.length + h.added.length, 0) > 1024) return null;
    let oldEnd = 0, newEnd = 0;
    for (const h of c.diff.hunks) {
      if (!h.deleted.length && !h.added.length || h.oldStart < oldEnd || h.newStart < newEnd || h.oldStart + h.deleted.length > 513 || h.newStart + h.added.length > 513) return null;
      oldEnd = h.oldStart + h.deleted.length; newEnd = h.newStart + h.added.length;
    }
  }
  // Overview/projection metadata never contains hunk or replacement text.
  const diff: ChangeEvidence['diff'] = c.diff.format === 'replacement' ? { format: 'replacement', truncated: c.diff.truncated }
    : { format: 'changed-lines', context: 0, redacted: true, truncated: c.diff.truncated, ...(c.diff.truncated ? { reason: c.diff.reason } : {}) };
  return { version: 1, id: c.id, repository: c.repository, worktree: c.worktree, path: c.path, before: c.before, after: c.after,
    level: c.commit ? 'commit' : c.diff.truncated ? 'captured-hashes' : 'captured-diff', diff, ...(c.commit ? { commit: c.commit } : {}) };
}

/** JSON metadata equality independent of PostgreSQL jsonb key order. Pure for fixture consumers. */
export function sameChange(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameChange((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
