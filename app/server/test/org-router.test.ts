import { describe, expect, it } from 'vitest';
import { checkFixed, decide, escalations, type RoutingConfig } from '../src/org-router.js';

/** The router is pure: floors beat cost, a permission block never escalates, nothing runs below its floor. */

const CFG: RoutingConfig = {
  tiers: { t0: { turns: 8 }, t1: { turns: 20 }, t2: { turns: 30 }, t3: { turns: 40 } },
  floors: { coding_single_file_named_path: 't1', coding_default: 't2', high_risk: 't3', merge: 't3', deploy: 't3' },
  escalation: { turn_cap_no_commit: 1, tests_failed_twice: 1, review_changes_twice: 1 },
  risk_keywords: ['migration', 'auth', 'deploy', 'prod'],
  models: [
    { id: 'qwen', provider: 'ollama', tier: 't1', can_code: false, local: true, price_in: 0, price_out: 0 },
    { id: 'haiku', provider: 'anthropic', tier: 't1', can_code: true, local: false, price_in: 1, price_out: 5 },
    { id: 'sonnet', provider: 'anthropic', tier: 't2', can_code: true, local: false, price_in: 3, price_out: 15 },
    { id: 'opus', provider: 'anthropic', tier: 't3', can_code: true, local: false, price_in: 15, price_out: 75 },
  ],
};

describe('decide', () => {
  it('replays the idris run: a one-file coding card with no verified path runs on sonnet, not the local 35B', () => {
    const d = decide({ work: 'coding', files: 1, namedPath: false, text: 'default sort of Board.tsx = most recently updated', envelope: ['t1', 't2'] }, CFG);
    expect(d).toMatchObject({ action: 'run', model: 'sonnet', tier: 't2', floor: 't2' });
  });

  it('allows a t1 coding model only for one file with a named path, and never the can_code:false one', () => {
    const d = decide({ work: 'coding', files: 1, namedPath: true, envelope: ['t1', 't2'] }, CFG);
    expect(d).toMatchObject({ action: 'run', model: 'haiku', tier: 't1' });
  });

  it('picks the cheapest model for non-coding work, local included', () => {
    expect(decide({ work: 'writing', envelope: ['t1', 't2'] }, CFG)).toMatchObject({ action: 'run', model: 'qwen', tier: 't1' });
  });

  it('asks for a spec when clarity is low and the scope is more than one file', () => {
    expect(decide({ work: 'coding', files: 3, specClarity: 'low', envelope: ['t2'] }, CFG).action).toBe('ask-spec');
  });

  it('puts merge, deploy and risk keywords on the top tier and never on a local model', () => {
    expect(decide({ work: 'ops', role: 'merge', envelope: ['t1', 't2', 't3'] }, CFG)).toMatchObject({ model: 'opus', tier: 't3' });
    const d = decide({ work: 'coding', files: 1, namedPath: true, text: 'add a migration for the users table', envelope: ['t1', 't2', 't3'] }, CFG);
    expect(d).toMatchObject({ action: 'run', tier: 't3' });
    expect(d.signals.riskWords).toEqual(['migration']);
  });

  it('parks instead of running below the floor when the envelope is too low', () => {
    const d = decide({ work: 'coding', role: 'deploy', envelope: ['t1', 't2'] }, CFG);
    expect(d.action).toBe('park');
  });

  it('makes a reviewer at least the author tier', () => {
    expect(decide({ work: 'coding', role: 'review', authorTier: 't2', envelope: ['t1', 't2', 't3'] }, CFG)).toMatchObject({ tier: 't2' });
  });

  it('escalates one tier after a turn-cap miss, and parks at the top of the envelope', () => {
    expect(decide({ work: 'writing', failures: ['turn_cap_no_commit'], envelope: ['t1', 't2'] }, CFG)).toMatchObject({ action: 'run', tier: 't2' });
    expect(decide({ work: 'writing', failures: ['turn_cap_no_commit', 'turn_cap_no_commit'], envelope: ['t1', 't2'] }, CFG).action).toBe('park');
  });

  it('counts test failures and rejected reviews two at a time', () => {
    expect(escalations(['tests_failed'], CFG)).toBe(0);
    expect(escalations(['tests_failed', 'tests_failed', 'review_changes', 'review_changes'], CFG)).toBe(2);
  });

  it('reports BLOCKED on a permission block and does not escalate', () => {
    expect(decide({ work: 'coding', files: 1, failures: ['turn_cap_no_commit', 'blocked'], envelope: ['t1', 't2', 't3'] }, CFG).action).toBe('blocked');
  });

  it('waits when the only fit is on a down provider, rather than dropping below the floor', () => {
    const d = decide({ work: 'coding', files: 2, envelope: ['t2'], unhealthyProviders: ['anthropic'] }, CFG);
    expect(d.action).toBe('wait');
  });
});

describe('checkFixed', () => {
  it('accepts a fixed top-tier merger and rejects a fixed local one', () => {
    expect(checkFixed('opus', { work: 'ops', role: 'merge', envelope: [] }, CFG).ok).toBe(true);
    expect(checkFixed('qwen', { work: 'ops', role: 'merge', envelope: [] }, CFG).ok).toBe(false);
  });
  it('rejects a coder fixed to a can_code:false model', () => {
    expect(checkFixed('qwen', { work: 'coding', files: 1, namedPath: true, envelope: [] }, CFG).ok).toBe(false);
  });
});
