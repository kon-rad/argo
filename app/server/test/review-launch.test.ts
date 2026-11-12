import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { LaunchRegistration } from '../src/review/launch.js';
import { acknowledgeCorrectionAfterLookup, attestCorrectionCompletion, finishCorrectionAfterAttestation, handleCorrectionLookupFailure } from '../src/review/corrections.js';
import { retryCorrectionLookup, SafeProcessError } from '../src/review/process.js';

const execFileAsync=promisify(execFile);

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
    ['finish','temporary','review_correction_reconcile'],
    ['finish','authentication','review_correction_reconcile'],
    ['prepare','confirmed-stale','review_correction_cancel'],
    ['ack','confirmed-stale','review_correction_cancel'],
    ['finish','confirmed-stale','review_correction_cancel'],
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

describe('trusted completion attestation', () => {
  it('derives a genuine new correction commit from the registered branch, worktree and common dir', async () => {
    const root=await realpath(await mkdtemp(join(tmpdir(),'review-completion-')));
    try{
      await execFileAsync('git',['init','-b','card/t_123abc-fix',root]);
      await execFileAsync('git',['-C',root,'config','user.name','Fixture']);
      await execFileAsync('git',['-C',root,'config','user.email','fixture@example.invalid']);
      await execFileAsync('git',['-C',root,'commit','--allow-empty','-m','rejected']);
      const rejected=(await execFileAsync('git',['-C',root,'rev-parse','HEAD'])).stdout.trim();
      await execFileAsync('git',['-C',root,'commit','--allow-empty','-m','correction']);
      const expected=(await execFileAsync('git',['-C',root,'rev-parse','HEAD'])).stdout.trim();
      const commonDir=(await execFileAsync('git',['-C',root,'rev-parse','--path-format=absolute','--git-common-dir'])).stdout.trim();
      await expect(attestCorrectionCompletion({git:'git',worktree:root,commonDir,branch:'card/t_123abc-fix',rejectedHead:rejected,home:root})).resolves.toBe(expected);
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it.each(['confirmed-stale','temporary','authentication','identity'] as const)('does not finish when the final live PR check is %s', async kind => {
    const query=vi.fn();
    const validate=vi.fn().mockRejectedValue(new SafeProcessError(kind));
    await expect(finishCorrectionAfterAttestation(
      {query} as never,
      {id:9,runId:'run-reserved',rejectedHead:'b'.repeat(40),completionHead:'d'.repeat(40)},
      validate,
    )).rejects.toMatchObject({kind});
    expect(query).not.toHaveBeenCalled();
  });

  it('passes both the immutable rejected head and trusted final head only after live validation', async () => {
    const query=vi.fn().mockResolvedValue({rows:[]});
    const validate=vi.fn().mockResolvedValue(undefined);
    await finishCorrectionAfterAttestation(
      {query} as never,
      {id:9,runId:'run-reserved',rejectedHead:'b'.repeat(40),completionHead:'d'.repeat(40)},
      validate,
    );
    expect(validate).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith('SELECT review_correction_finish($1,$2,$3,$4)',[9,'run-reserved','b'.repeat(40),'d'.repeat(40)]);
  });
});
