import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { completeWithFallback, ChainExhausted, providerFor } from '../src/summaries/chain.js';
import { summaryConfig } from '../src/summaries/config.js';
import { deriveTouched } from '../src/summaries/derive.js';
import { runChecks, runExpectations } from '../src/summaries/eval/checks.js';
import { loadGolden, toParts } from '../src/summaries/eval/golden.js';
import { parseVerdict, verdictScore } from '../src/summaries/eval/judge.js';
import { combine, gradeReferences } from '../src/summaries/eval/run.js';
import { compact } from '../src/summaries/input.js';
import { parseModelSummary } from '../src/summaries/schema.js';
import { sse } from './summaries-helpers.js';

const GOLDEN = resolve(import.meta.dirname, 'fixtures', 'summaries');
const cfg = summaryConfig();


const GOOD = JSON.stringify({ request: 'Fix the bug.', done: 'Fixed it.', learned: '', open_items: '', outcome: 'finished', facts: [] });
const ENV = { SUMMARIES_M1_URL: 'http://m1.invalid:11434', TOGETHER_API_KEY: 'tg-fake-key-for-tests-0001', OPENROUTER_API_KEY: 'or-fake-key-for-tests-0002' };

describe('parseModelSummary', () => {
  it('reads plain, fenced and think-wrapped JSON', () => {
    expect(parseModelSummary(GOOD)?.outcome).toBe('finished');
    expect(parseModelSummary('```json\n' + GOOD + '\n```')?.done).toBe('Fixed it.');
    expect(parseModelSummary('<think>hmm {not json}</think>\n' + GOOD)?.request).toBe('Fix the bug.');
  });
  it('rejects prose, broken JSON and an empty object', () => {
    expect(parseModelSummary('I cannot do that.')).toBeNull();
    expect(parseModelSummary('{"request": "x", ')).toBeNull();
    expect(parseModelSummary('{"request":"","done":"","outcome":"finished"}')).toBeNull();
  });
  it('turns an unknown outcome into unknown and caps facts', () => {
    const s = parseModelSummary(JSON.stringify({ request: 'a', done: 'b', outcome: 'great', facts: Array.from({ length: 9 }, (_, i) => ({ subject: `s${i}`, claim: 'c' })) }));
    expect(s?.outcome).toBe('unknown');
    expect(s?.facts).toEqual([]); // more than five: the whole list is dropped rather than half-trusted
  });
});

describe('provider chain', () => {
  it('uses the home server first when it answers', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => { urls.push(url); return sse(GOOD); }) as unknown as typeof fetch;
    const r = await completeWithFallback(cfg.chain, { messages: [{ role: 'user', content: 'x' }] }, { environment: ENV, fetchFn });
    expect(r.provider).toBe('ollama');
    expect(urls).toEqual(['http://m1.invalid:11434/v1/chat/completions']);
    expect(r.attempts).toHaveLength(1);
  });

  it('falls through a dead server and a bad answer to the third provider', async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes('m1.invalid')) throw new Error('connect ECONNREFUSED');
      if (url.includes('together')) return sse('sorry, no JSON here');
      return sse(GOOD);
    }) as unknown as typeof fetch;
    const r = await completeWithFallback(cfg.chain, { messages: [{ role: 'user', content: 'x' }] }, { environment: ENV, fetchFn, accept: (t) => parseModelSummary(t) !== null });
    expect(r.provider).toBe('openrouter');
    expect(r.attempts.map((a) => [a.provider, a.ok])).toEqual([['ollama', false], ['together', false], ['openrouter', true]]);
    expect(r.attempts[1]!.error).toMatch(/schema/);
  });

  it('skips a provider with no key and never puts the key in the record', async () => {
    const fetchFn = (async () => { throw new Error(`HTTP 401 for Bearer ${ENV.TOGETHER_API_KEY}`); }) as unknown as typeof fetch;
    const noOr = { ...ENV, OPENROUTER_API_KEY: '' };
    await expect(completeWithFallback(cfg.chain, { messages: [{ role: 'user', content: 'x' }] }, { environment: noOr, fetchFn }))
      .rejects.toSatisfy((e: unknown) => {
        expect(e).toBeInstanceOf(ChainExhausted);
        const text = JSON.stringify((e as ChainExhausted).attempts);
        expect(text).not.toContain(ENV.TOGETHER_API_KEY);
        expect((e as ChainExhausted).attempts.find((a) => a.provider === 'openrouter')?.error).toMatch(/OPENROUTER_API_KEY is not set/);
        return true;
      });
  });

  it('reads the home address from the variable the entry names, and from the config override', () => {
    const entry = cfg.chain[0]!;
    expect(providerFor(entry, { environment: ENV }).model).toBe(entry.model);
    expect(providerFor({ ...entry, baseUrl: 'http://other.invalid' }, { environment: {} }).id).toBe('ollama');
    expect(() => providerFor({ provider: 'nope', model: 'x' })).toThrow(/unknown provider/);
  });
});

describe('compacting a transcript', () => {
  const golden = loadGolden(GOLDEN);
  it('keeps prompts, responses, tool calls and failed results only', () => {
    const c = compact(toParts(golden.find((g) => g.id === 'deploy-blocked')!), 24000);
    expect(c.text).toContain('[prompt] Deploy the web app');
    expect(c.text).toContain('[tool] Bash: ./deploy.sh');
    expect(c.text).toContain('[error] deploy.sh: DEPLOY_SSH_KEY');
    expect(c.text).not.toContain('#!/usr/bin/env bash'); // a successful tool result is dropped
    expect(c.conversational).toBe(3);
  });
  it('cuts the middle, keeps both ends, and hashes the result', () => {
    const parts = Array.from({ length: 400 }, (_, i) => ({ key: `${i}`, step: (i % 2 ? 'response' : 'prompt') as 'response', text: `message number ${i} with some padding text to take room`, toolName: null, toolCallId: null, isError: null }));
    const c = compact(parts, 3000);
    expect(c.text.length).toBeLessThan(3200);
    expect(c.text).toContain('message number 0 ');
    expect(c.text).toContain('message number 399 ');
    expect(c.text).toMatch(/\[\.\.\. \d+ steps omitted \.\.\.\]/);
    expect(c.sha).toHaveLength(64);
    expect(compact(parts, 3000).sha).toBe(c.sha);
  });
  it('redacts a key before it reaches a model', () => {
    const c = compact([{ key: '1', step: 'prompt', text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the push', toolName: null, toolCallId: null, isError: null }], 5000);
    expect(c.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('derived fields', () => {
  it('lists edited files, cards, tools and skills from the tool calls, not from a model', () => {
    const t = deriveTouched(toParts(loadGolden(GOLDEN).find((g) => g.id === 'bugfix-finished')!));
    expect(t.files_edited.sort()).toEqual(['/work/shop/src/billing/invoice.ts', '/work/shop/test/invoice-duplicate-code.test.ts']);
    expect(t.cards).toEqual(['t_ab12cd34']);
    expect(t.tools).toMatchObject({ Read: 1, Grep: 1, Edit: 1, Write: 1, Bash: 1 });
    expect(t.files_read).toBe(2);
  });
});

describe('the quality checks', () => {
  const cases = loadGolden(GOLDEN);
  const bug = cases.find((g) => g.id === 'bugfix-finished')!;
  const good = bug.reference!;

  it('pass every hand-written reference summary above its bar (this proves the checks, not a model)', async () => {
    const graded = await gradeReferences(cases, cfg);
    expect(graded).toHaveLength(cases.length);
    for (const g of graded) {
      const c = cases.find((x) => x.id === g.id)!;
      expect(g.score, `${g.id}: ${JSON.stringify([...g.checks.checks, ...(g.expectations?.checks ?? [])].filter((x) => !x.pass))}`).toBeGreaterThanOrEqual(c.minScore);
    }
  });

  it('catch an invented file, card and number', () => {
    const r = runChecks({ ...good, done: 'Edited src/payments/refund.ts for card t_deadbeef and fixed 4821 rows.' }, toParts(bug));
    const failed = r.checks.filter((c) => !c.pass).map((c) => c.name);
    expect(failed).toEqual(expect.arrayContaining(['paths-grounded', 'cards-grounded', 'numbers-grounded']));
    expect(r.score).toBeLessThan(0.7);
  });

  it('catch an ungrounded fact', () => {
    const r = runChecks({ ...good, facts: [{ subject: 'kubernetes autoscaler', claim: 'The cluster autoscaler shrinks nodepools overnight according to telemetry.' }] }, toParts(bug));
    expect(r.checks.find((c) => c.name === 'facts-grounded')!.pass).toBe(false);
  });

  it('catch a secret, an em-dash and markdown', () => {
    const r = runChecks({ ...good, learned: 'Key was ghp_abcdefghijklmnopqrstuvwxyz0123456789 — **rotate**' }, toParts(bug));
    expect(r.checks.find((c) => c.name === 'no-secrets')!.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'style')!.pass).toBe(false);
  });

  it('catch "finished" when the session ended in failures', () => {
    const failed = cases.find((g) => g.id === 'failed-in-errors')!;
    const r = runChecks({ ...failed.reference!, outcome: 'finished' }, toParts(failed));
    expect(r.checks.find((c) => c.name === 'outcome-vs-errors')!.pass).toBe(false);
  });

  it('expectations catch a wrong outcome and a forbidden claim', () => {
    const blocked = cases.find((g) => g.id === 'deploy-blocked')!;
    const r = runExpectations({ ...blocked.reference!, outcome: 'finished', done: 'The app deployed successfully.' }, deriveTouched(toParts(blocked)), blocked.expect);
    expect(r.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual(expect.arrayContaining(['outcome', 'omits-deployed successfully']));
  });
});

describe('the judge', () => {
  it('parses a verdict, tolerates fences and clamps nothing silently', () => {
    const v = parseVerdict('```json\n{"faithful":5,"complete":4,"concise":3,"outcome_correct":5,"unsupported":[],"missed":["the test count"]}\n```');
    expect(v?.missed).toEqual(['the test count']);
    expect(verdictScore(v!)).toBeGreaterThan(0.8);
    expect(parseVerdict('{"faithful":9,"complete":4,"concise":3,"outcome_correct":5}')).toBeNull();
    expect(parseVerdict('no')).toBeNull();
  });
  it('weights faithfulness double', () => {
    const base = { complete: 3, concise: 3, outcome_correct: 3, unsupported: [], missed: [] };
    expect(verdictScore({ ...base, faithful: 1 })).toBeLessThan(verdictScore({ ...base, faithful: 5 }));
    expect(combine([1, null, 0.5])).toBe(0.75);
  });
});

describe('how a session ends', () => {
  it('keeps the last response nearly whole so a finished report is not read as cut off', () => {
    const long = 'Report: ' + 'x'.repeat(2500) + ' THE END';
    const mk = (step: 'response' | 'prompt', text: string) => ({ key: text.slice(0, 4), step, text, toolName: null, toolCallId: null, isError: null });
    const c = compact([mk('prompt', 'write the report'), mk('response', 'y'.repeat(2000)), mk('response', long)], 24000);
    expect(c.text).toContain('THE END'); // the last response is kept (up to 3,500 characters)
    expect(c.text).toMatch(/y{900,}\s*\[\.\.\.\]/); // an earlier response is still clipped to about 1,000
    expect(c.text).not.toContain('y'.repeat(1100));
  });
});
