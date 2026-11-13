import { describe, expect, it } from 'vitest';
import { CapacityError, evaluate } from '../src/review/policy.js';
import { actionableCapacityFeedback, ciFindings, Feedback } from '../src/review/feedback.js';

const binding = {
  card: 't_123abc', repo: 'example/engine', pr: 7,
  base: 'a'.repeat(40), head: 'b'.repeat(40), evidenceHash: 'c'.repeat(64),
  producer: { kind: 'coordinator' as const, id: 'review-worker' },
};

describe('typed review feedback', () => {
  it('maps deterministic capacity failures to revision-bound actionable rejection, never acceptance', () => {
    const result = evaluate({ changedFiles: 31, reviewableFiles: 31, sources: 81, sourceChars: 10, diffChars: 20, combinedChars: 30 }, 'actual');
    const feedback = actionableCapacityFeedback(new CapacityError(result), binding);
    expect(feedback).toHaveLength(2);
    expect(feedback[0]).toMatchObject({ card: binding.card, repo: binding.repo, pr: 7, head: binding.head, code: 'scope-reviewable-files', severity: 'high' });
    expect(feedback[0]!.requiredFix).toContain('Split');
    expect(feedback[0]!.verification).toContain('actual');
    expect(feedback.every(item => Feedback.safeParse(item).success)).toBe(true);
    expect(feedback.map(item => item.id)).toEqual(actionableCapacityFeedback(new CapacityError(result), binding).map(item => item.id));
  });

  it('waits for pending CI and creates actionable feedback only for terminal failures', () => {
    expect(ciFindings([{ name: 'app', state: 'pending' }], ['app'], binding)).toEqual({ status: 'wait', feedback: [] });
    expect(ciFindings([], ['app'], binding)).toEqual({ status: 'wait', feedback: [] });
    const failed = ciFindings([{ name: 'app', state: 'fail' }], ['app'], binding);
    expect(failed.status).toBe('reject');
    expect(failed.feedback[0]).toMatchObject({ code: 'ci-failure', reason: 'Required CI check failed: app', head: binding.head });
  });

  it('rejects untrusted, private-excluded and incomplete feedback envelopes', () => {
    const valid = actionableCapacityFeedback(new CapacityError(evaluate({ changedFiles: 0, reviewableFiles: 31, sources: 0, sourceChars: 0, diffChars: 0, combinedChars: 0 }, 'actual')), binding)[0]!;
    expect(Feedback.safeParse({ ...valid, producer: { kind: 'builder', id: 'builder' } }).success).toBe(false);
    expect(Feedback.safeParse({ ...valid, code: 'private-excluded-context' }).success).toBe(false);
    expect(Feedback.safeParse({ ...valid, evidence: '' }).success).toBe(false);
  });
});
