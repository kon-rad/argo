import { describe, expect, it } from 'vitest';
import { ADAPTER_RUNTIMES, agentSpecProblem } from '../src/agent-spec.js';

/**
 * Write-time validation of an agent's runtime and model (cutover plan 5a, item 5). It runs when the roster is
 * imported and when an override is set, so a pair no adapter can run is refused before it costs a wake. The first
 * case is the one that went live: ravi was zen-agent with model `sonnet`.
 */
describe('agentSpecProblem', () => {
  it('refuses a zen-agent whose model is a bare Anthropic alias (the ravi case)', () => {
    expect(agentSpecProblem({ runtime: 'zen-agent', model: 'sonnet' })).toMatch(/provider\/model/);
  });

  it('accepts a zen-agent with provider/model and one with no model', () => {
    expect(agentSpecProblem({ runtime: 'zen-agent', model: 'openrouter/deepseek/deepseek-v4.1-flash' })).toBeNull();
    expect(agentSpecProblem({ runtime: 'zen-agent', model: null })).toBeNull();
  });

  it('refuses a claude-code agent whose model is not an Anthropic alias', () => {
    expect(agentSpecProblem({ runtime: 'claude-code', model: 'openrouter/deepseek/deepseek-v4.1-flash' })).toMatch(/Anthropic alias/);
    expect(agentSpecProblem({ runtime: 'claude-code', model: 'gpt-5' })).toMatch(/Anthropic alias/);
  });

  it('accepts the Anthropic aliases and full claude ids', () => {
    for (const model of ['opus', 'sonnet', 'haiku', 'sonnet[1m]', 'claude-sonnet-5-5', 'claude-opus-5-5']) {
      expect(agentSpecProblem({ runtime: 'claude-code', model })).toBeNull();
    }
    expect(agentSpecProblem({ runtime: 'claude-code', model: undefined })).toBeNull();
  });

  it('refuses a runtime that no adapter runs', () => {
    expect(agentSpecProblem({ runtime: 'codex', model: null })).toMatch(/no adapter/);
    expect(agentSpecProblem({ runtime: 'gemini', model: null })).toMatch(/no adapter/);
  });

  it('leaves humans and sessions alone: nothing claims for them', () => {
    expect(agentSpecProblem({ runtime: 'human', model: null })).toBeNull();
    expect(agentSpecProblem({ runtime: 'session', model: null })).toBeNull();
  });

  it('names the runtimes that do have an adapter', () => {
    expect([...ADAPTER_RUNTIMES].sort()).toEqual(['claude-code', 'hermes', 'zen-agent']);
  });

  it('refuses an effort the runtime cannot take', () => {
    expect(agentSpecProblem({ runtime: 'claude-code', model: 'sonnet', effort: 'turbo' })).toMatch(/effort/);
    expect(agentSpecProblem({ runtime: 'claude-code', model: 'sonnet', effort: 'high' })).toBeNull();
  });
});
