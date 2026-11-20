import { z } from 'zod';
import type { EvidenceEvent } from '@secondbrain/contracts/observatory';
import { envelope, instant } from './adapters.js';
export interface ReviewRow { id: number; job: number; card: string; reviewer: string; at: Date; patch: unknown }
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const snapshot = z.object({ repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200), pr: z.number().int().positive(), head: sha, base: sha });
const verdict = z.object({ decision: z.enum(['accept', 'reject']), head: sha, base: sha });
/** Only immutable trusted gate attempts. Never today's review_jobs snapshot/state/timestamps. */
export function reviewEvents(rows: ReviewRow[]): EvidenceEvent[] {
  const jobs = new Map<number, { snapshot?: z.infer<typeof snapshot>; verdict?: z.infer<typeof verdict>; merged?: string }>();
  const events: EvidenceEvent[] = [];
  for (const row of [...rows].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id)) {
    const patch = row.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
    const p = patch as Record<string, unknown>, state = jobs.get(row.job) ?? {};
    jobs.set(row.job, state);
    const emit = (stage: NonNullable<EvidenceEvent['artifact']>['stage'], merge?: string) => {
      if (!state.snapshot) return;
      const s = state.snapshot, e = envelope('review_attempts', String(row.id), instant(row.at), 'artifact');
      e.observedAt = instant(row.at); e.sequence = row.id; e.part = ['pr-observed', 'review-accepted', 'review-rejected', 'merge-recorded', 'merge-verified'].indexOf(stage);
      e.id += `:${stage}`; e.source.part = stage; e.ticket = row.card;
      e.actor = { kind: 'automation', sender: row.reviewer, channel: null, evidence: 'trusted-review-gate; recorded-reviewer' };
      e.artifact = { repository: s.repo, pr: s.pr, head: s.head, base: s.base, stage, verification: 'trusted-review-gate', ...(merge ? { merge } : {}) };
      events.push(e);
    };
    if (Object.hasOwn(p, 'snapshot')) {
      const parsed = snapshot.safeParse(p.snapshot);
      state.snapshot = parsed.success ? parsed.data : undefined;
      state.verdict = undefined; state.merged = undefined;
      if (state.snapshot) emit('pr-observed');
    }
    if (Object.hasOwn(p, 'verdict')) {
      const parsed = verdict.safeParse(p.verdict);
      state.verdict = parsed.success && parsed.data.head === state.snapshot?.head && parsed.data.base === state.snapshot?.base ? parsed.data : undefined;
      if (state.verdict) emit(state.verdict.decision === 'accept' ? 'review-accepted' : 'review-rejected');
    }
    if (sha.safeParse(p.merged).success) {
      state.merged = p.merged as string;
      emit('merge-recorded', state.merged);
    }
    if (state.verdict?.decision === 'accept' && p.mergeVerified === state.merged && state.merged) emit('merge-verified', state.merged);
  }
  return events;
}
