import { describe, expect, it } from 'vitest';
import { LaunchRegistration } from '../src/review/launch.js';

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
