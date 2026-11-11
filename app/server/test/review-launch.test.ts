import { describe, expect, it, vi } from 'vitest';
import { LaunchRegistration } from '../src/review/launch.js';
import { acknowledgeCorrectionAfterLookup, handleCorrectionLookupFailure } from '../src/review/corrections.js';
import { retryCorrectionLookup, SafeProcessError } from '../src/review/process.js';

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

  it('retries only the same acknowledgement lookup and acknowledges the reservation once', async () => {
    const lookup=vi.fn()
      .mockRejectedValueOnce(new SafeProcessError('temporary','fixture-secret'))
      .mockResolvedValueOnce(undefined);
    const sleep=vi.fn().mockResolvedValue(undefined);
    const query=vi.fn().mockResolvedValue({rows:[{state:'running'}]});

    await expect(acknowledgeCorrectionAfterLookup(
      {query} as never,
      {id:9,token:'lease-token',runId:'run-reserved',processId:'process-42',head:'b'.repeat(40)},
      lookup,
      {attempts:3,delayMs:1,deadlineMs:20,sleep},
    )).resolves.toEqual({state:'running'});

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([
      'SELECT * FROM review_correction_ack($1,$2,$3,$4,$5)',
      [9,'lease-token','run-reserved','process-42','b'.repeat(40)],
    ]);
  });

  it('bounds acknowledgement lookup exhaustion without acknowledging or redispatching', async () => {
    const lookup=vi.fn().mockRejectedValue(new SafeProcessError('temporary','fixture-secret'));
    const sleep=vi.fn().mockResolvedValue(undefined);
    const query=vi.fn();

    let failure:unknown;
    try{
      await acknowledgeCorrectionAfterLookup(
        {query} as never,
        {id:9,token:'lease-token',runId:'run-reserved',processId:'process-42',head:'b'.repeat(40)},
        lookup,
        {attempts:3,delayMs:1,deadlineMs:20,sleep},
      );
    }catch(error){failure=error;}
    expect(failure).toMatchObject({kind:'temporary'});

    expect(lookup).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalled();
    await expect(handleCorrectionLookupFailure({query} as never,'ack',9,'lease-token',failure)).rejects.toThrow(/owner reconciliation required/);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toContain('review_correction_reconcile');
    expect(JSON.stringify(query.mock.calls[0])).not.toContain('fixture-secret');
  });

  it('caps a short remaining lease and refuses acknowledgement after a late lookup success', async () => {
    let clock=1_000;
    const lookup=vi.fn(async (timeoutMs:number) => {
      expect(timeoutMs).toBe(5);
      clock=1_006;
    });
    const query=vi.fn();

    await expect(acknowledgeCorrectionAfterLookup(
      {query} as never,
      {id:9,token:'lease-token',runId:'run-reserved',processId:'process-42',head:'b'.repeat(40)},
      lookup,
      {attempts:3,delayMs:1,deadlineAt:1_005,now:()=>clock,sleep:vi.fn()},
    )).rejects.toMatchObject({kind:'temporary'});

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['authentication','identity','confirmed-stale'] as const)('does not retry %s acknowledgement failures', async kind => {
    const lookup=vi.fn().mockRejectedValue(new SafeProcessError(kind));
    const sleep=vi.fn();
    await expect(retryCorrectionLookup(lookup,{attempts:3,delayMs:1,deadlineMs:20,sleep})).rejects.toMatchObject({kind});
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
