import { z } from 'zod';
import type { ChangeEvidence } from '@secondbrain/contracts/observatory';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(1024).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(s => s === '..' || s === '.' || s === '') && !/[\x00-\x1f]/.test(p));
const capture = z.object({ version: z.literal(1), id: z.string().min(1).max(128), repository: hash, worktree: hash, path,
  before: hash.nullable(), after: hash,
  diff: z.object({ format: z.literal('replacement'), before: z.string().max(16384).optional(), after: z.string().max(16384).optional(), truncated: z.boolean() }),
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
  if (!c.diff.truncated && (c.diff.before === undefined || c.diff.after === undefined || new TextEncoder().encode(c.diff.before).length + new TextEncoder().encode(c.diff.after).length > 16384)) return null;
  return { version: 1, id: c.id, repository: c.repository, worktree: c.worktree, path: c.path, before: c.before, after: c.after,
    level: c.commit ? 'commit' : c.diff.truncated ? 'captured-hashes' : 'captured-diff', diff: { format: 'replacement', truncated: c.diff.truncated }, ...(c.commit ? { commit: c.commit } : {}) };
}

/** JSON metadata equality independent of PostgreSQL jsonb key order. Pure for fixture consumers. */
export function sameChange(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameChange((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
