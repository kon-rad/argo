import { describe, expect, it, vi } from 'vitest';
import { LaunchRegistration } from '../src/review/launch.js';
import { handleCorrectionLookupFailure } from '../src/review/corrections.js';
import { SafeProcessError } from '../src/review/process.js';

describe('trusted correction launch identity', () => {
  const launch = {
    card: 't_123abc', builder: 'builder', persona: 'engineer', runtime: 'codex', model: 'test-model', host: 'worker-a',
    repo: 'engine', branch: 'card/t_123abc-fix', worktree: '/srv/worktrees/t_123abc', commonDir: '/srv/git/engine',
    originalRunId: 'run-original', stage: 'build' as const,
  };

  it('preserves the complete original identity and accepts an optional strict stage', () => {
    expect(LaunchRegistration.parse(launch)).toEqual(launch);
    expect(LaunchRegistration.parse(Object.fromEntries(Object.entries(launch).filter(([key]) => key !== 'stage'))).stage).toBeUndefined();
  });

  it.each([
    ['relative worktree', { ...launch, worktree: 'tmp/worktree' }],
    ['unknown stage', { ...launch, stage: 'ship' }],
    ['missing original run', { ...launch, originalRunId: '' }],
  ])('rejects %s', (_name, value) => expect(LaunchRegistration.safeParse(value).success).toBe(false));
});

describe('correction PR lookup outcomes', () => {
  it.each([
    ['prepare','temporary','review_correction_retry'],
    ['prepare','authentication','review_correction_reconcile'],
    ['ack','temporary','review_correction_reconcile'],
    ['ack','authentication','review_correction_reconcile'],
    ['prepare','confirmed-stale','review_correction_cancel'],
    ['ack','confirmed-stale','review_correction_cancel'],
  ] as const)('%s %s uses %s and reports only a safe reason', async (phase,kind,procedure) => {
    const query=vi.fn().mockResolvedValue({rows:[]});
    await expect(handleCorrectionLookupFailure({query} as never,phase,9,'lease-token',new SafeProcessError(kind,'fixture-secret'))).rejects.toThrow(/Correction PR/);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toContain(procedure);
    expect(JSON.stringify(query.mock.calls[0])).not.toContain('fixture-secret');
  });
});
