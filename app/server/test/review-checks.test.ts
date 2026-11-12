import { describe, expect, it } from 'vitest';
import { runReview, Snapshot, type GateIO, type Job, type Verdict } from '../src/review/gate.js';
import { normalizeChecks } from '../src/review/worker.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);
const check = (name: string, conclusion: string | null) => ({ name, status: 'COMPLETED', conclusion });
function fixture(checks: Snapshot['checks'], requiredChecks?: string[]) {
  const s: Snapshot = { repo: 'example/engine', pr: 1, head, base, branch: 'main', merged: null, checks,
    sources: [{ ref: 'fixture:ticket', revision: '1', text: 'Acceptance: configured CI and independent review', essential: true, missing: false, truncated: false }],
    ...(requiredChecks === undefined ? {} : { requiredChecks }) };
  const job: Job = { id: 1, card: 't_123abc', builder: 'builder', reviewer: 'auditor', target: 'fixture', round: 0,
    state: 'queued', snapshot: null, verdict: null, merged: null, deployed: null };
  const calls = { review: 0, merge: 0, deploy: 0, complete: 0 };
  const covered = { status: 'checked' as const, evidence: ['fixture:ticket'], rationale: 'Exact synthetic check evidence' };
  const io: GateIO = {
    gather: async () => structuredClone(s),
    review: async (_, evidence): Promise<Verdict> => { calls.review++; return { decision: 'accept', reviewer: 'auditor', repo: s.repo, pr: 1, head, base, evidence,
      categories: { security: covered, compatibility: covered, migrations: covered, regressions: covered, scope: covered, placeholders: covered, tests: covered }, findings: [] }; },
    save: async patch => { Object.assign(job, patch); }, reject: async () => {},
    merge: async () => { calls.merge++; s.merged = merged; return merged; },
    verifyMerge: async (_, revision) => { expect(revision).toBe(merged); },
    deploy: async revision => { calls.deploy++; return revision; }, health: async revision => revision === merged,
    complete: async () => { calls.complete++; },
  };
  return { s, job, io, calls };
}

describe('production check normalization', () => {
  it('retains all names and distinguishes optional skipped/neutral from failures', () => {
    expect(normalizeChecks([check('tests', 'SUCCESS'), check('deploy', 'SKIPPED'), check('advice', 'NEUTRAL')]))
      .toEqual([{ name: 'tests', state: 'pass' }, { name: 'deploy', state: 'skipped' }, { name: 'advice', state: 'neutral' }]);
  });
  it.each([
    ['SUCCESS', 'pass'], ['FAILURE', 'fail'], ['CANCELLED', 'fail'], ['TIMED_OUT', 'fail'], ['ACTION_REQUIRED', 'fail'],
    ['STARTUP_FAILURE', 'fail'], ['STALE', 'fail'], ['SKIPPED', 'skipped'], ['NEUTRAL', 'neutral'], ['NEW_CONCLUSION', 'unknown'], ['constructor', 'unknown'], [null, 'unknown'],
  ] as const)('reports completed %s as %s', (conclusion, state) => {
    expect(normalizeChecks([check('named check', conclusion)])).toEqual([{ name: 'named check', state }]);
  });
  it.each(['QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'PENDING'])('keeps %s pending despite contradictory success fields', status => {
    expect(normalizeChecks([{ name: 'tests', status, conclusion: 'SUCCESS', state: 'SUCCESS' }])[0]!.state).toBe('pending');
  });
  it.each([['SUCCESS', 'pass'], ['FAILURE', 'fail'], ['ERROR', 'fail'], ['PENDING', 'pending'], ['EXPECTED', 'pending'], ['NEW_STATE', 'unknown'], ['toString', 'unknown']] as const)
  ('retains legacy StatusContext names and maps %s to %s', (state, expected) => {
    expect(normalizeChecks([{ context: 'legacy status', state }])).toEqual([{ name: 'legacy status', state: expected }]);
  });
  it('never uses a legacy success field to erase skipped or unknown CheckRun state', () => {
    expect(normalizeChecks([{ ...check('deploy', 'SKIPPED'), state: 'SUCCESS' }, { name: 'tests', status: 'NEW_STATUS', state: 'SUCCESS' }, {}]))
      .toEqual([{ name: 'deploy', state: 'skipped' }, { name: 'tests', state: 'unknown' }, { name: '', state: 'unknown' }]);
  });
});

describe('actual runReview configured-check authority', () => {
  it('allows truthful optional skipped deploy when all configured checks pass', async () => {
    const f = fixture(normalizeChecks([check('tests', 'SUCCESS'), check('deploy', 'SKIPPED')]), ['tests']);
    await runReview(f.job, ['tests'], f.io);
    expect(f.job.state).toBe('done');
    expect(f.job.snapshot?.checks).toEqual([{ name: 'tests', state: 'pass' }, { name: 'deploy', state: 'skipped' }]);
    expect(f.calls).toEqual({ review: 1, merge: 1, deploy: 1, complete: 1 });
  });
  it.each(['SKIPPED', 'NEUTRAL', 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'NEW_CONCLUSION'])
  ('stops required %s before model or shipping despite snapshot claiming no required checks', async conclusion => {
    const f = fixture(normalizeChecks([check('tests', conclusion)]), []);
    await runReview(f.job, ['tests'], f.io);
    expect(f.job.state).toBe(['SKIPPED', 'NEUTRAL', 'NEW_CONCLUSION'].includes(conclusion) ? 'blocked' : 'rejected');
    expect(f.calls).toEqual({ review: 0, merge: 0, deploy: 0, complete: 0 });
  });
  it.each(['missing', 'pending', 'unknown'])('stops %s configured CI', async state => {
    const checks = state === 'missing' ? [] : normalizeChecks([{ name: 'tests', ...(state === 'pending' ? { status: 'IN_PROGRESS' } : {}) }]);
    const f = fixture(checks, []); await runReview(f.job, ['tests'], f.io);
    expect(f.job.state).toBe('blocked'); expect(f.calls).toEqual({ review: 0, merge: 0, deploy: 0, complete: 0 });
  });
  it('preserves the terminal legacy ERROR rejection path without model or shipping', async () => {
    const f = fixture(normalizeChecks([{ context: 'tests', state: 'ERROR' }]), []);
    await runReview(f.job, ['tests'], f.io);
    expect(f.job.state).toBe('rejected'); expect(f.calls).toEqual({ review: 0, merge: 0, deploy: 0, complete: 0 });
  });
  it('does not allow snapshot metadata to substitute a different successful check', async () => {
    const f = fixture(normalizeChecks([check('optional', 'SUCCESS')]), ['optional']);
    await runReview(f.job, ['tests'], f.io);
    expect(f.job.state).toBe('blocked'); expect(f.calls.review).toBe(0); expect(f.calls.merge).toBe(0);
  });
  it('does not substitute snapshot names for an empty configured policy', async () => {
    const f = fixture(normalizeChecks([check('tests', 'SUCCESS')]), ['tests']);
    await runReview(f.job, [], f.io); expect(f.job.state).toBe('blocked'); expect(f.calls.review).toBe(0);
  });
  it('does not select a passing duplicate while ignoring a skipped duplicate', async () => {
    const f = fixture(normalizeChecks([check('tests', 'SUCCESS'), check('tests', 'SKIPPED')]), ['tests']);
    await runReview(f.job, ['tests'], f.io); expect(f.job.state).toBe('blocked'); expect(f.calls.merge).toBe(0);
  });
  it('preserves legacy snapshots without informative requiredChecks', async () => {
    const f = fixture(normalizeChecks([{ context: 'tests', state: 'SUCCESS' }]));
    expect(Snapshot.parse(f.s)).not.toHaveProperty('requiredChecks');
    await runReview(f.job, ['tests'], f.io); expect(f.job.state).toBe('done');
  });
});
