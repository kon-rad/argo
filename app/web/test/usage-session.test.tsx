import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import UsageSession from '../src/routes/usage/UsageSession.js';
import { groupTurns, pairTools, toolSummary } from '../src/routes/usage/steps.js';
import type { AgentStep } from '../src/lib/api.js';

const step = (o: Partial<AgentStep> & Pick<AgentStep, 'id' | 'step'>): AgentStep => ({
  key: String(o.id), ts: null, text: '', length: (o.text ?? '').length, truncated: false, toolName: null, toolCallId: null,
  isError: null, subagent: null, call: null, ...o,
});

const SESSION = {
  id: 1, source: 'claude-code', harness: 'claude-code', profile: null, provider: 'anthropic', host: 'mac', external_id: 's1',
  parent_external_id: null, project: null, title: 'Plan the usage board', first_prompt: 'Build the usage board',
  started_at: '2026-10-13T23:29:00Z', ended_at: '2026-10-13T23:40:00Z', steps: 5, tool_calls: 1, errors: 1, subagents: 1,
  models: ['claude-opus-5-5'], calls: 1, input: 10, cache_write: 100, cache_read: 1000, output: 50, reasoning: 0,
};
const STEPS: AgentStep[] = [
  step({ id: 1, step: 'prompt', ts: '2026-10-13T23:29:00Z', text: 'Build the usage board' }),
  step({ id: 2, step: 'thinking', ts: '2026-10-13T23:29:01Z', text: 'secret plan of attack' }),
  step({ id: 3, step: 'tool_call', ts: '2026-10-13T23:29:02Z', text: '{"command":"git status"}', toolName: 'Bash', toolCallId: 't1',
    call: { model: 'claude-opus-5-5', input: 10, cache_write: 100, cache_read: 1000, output: 50, reasoning: 0 } }),
  step({ id: 4, step: 'response', ts: '2026-10-13T23:29:03Z', text: 'sub says hi', subagent: 'Explore' }),
  step({ id: 5, step: 'tool_result', ts: '2026-10-13T23:29:04.500Z', text: 'fatal: not a git repository', toolCallId: 't1', isError: true }),
  step({ id: 6, step: 'response', ts: '2026-10-13T23:29:05Z', text: 'x'.repeat(20000), length: 30000, truncated: true }),
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); try { localStorage.clear(); } catch { /* none */ } });

function renderWith(body: unknown, path = '/usage/session/mac/s1?source=claude-code', extra?: (u: string) => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    return new Response(JSON.stringify(extra?.(u) ?? body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<QueryClientProvider client={new QueryClient()}>
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/usage/session/:host/:externalId" element={<UsageSession />} /></Routes>
    </MemoryRouter></QueryClientProvider>);
  return fetchMock;
}

describe('session steps', () => {
  it('pairs a tool call with its result and times it', () => {
    const items = pairTools(STEPS);
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool).toMatchObject({ kind: 'tool', pair: { call: { id: 3 }, result: { id: 5 }, durationMs: 2500 } });
    expect(items.filter((i) => i.kind === 'step').map((i) => i.kind === 'step' && i.step.id)).toEqual([1, 2, 4, 6]);
  });

  it('pairs a reused tool call id with the next result after the call, not an earlier one', () => {
    const steps = [
      step({ id: 1, step: 'tool_call', toolName: 'a', toolCallId: 'call_0' }), step({ id: 2, step: 'tool_result', toolCallId: 'call_0', text: 'first' }),
      step({ id: 3, step: 'tool_call', toolName: 'b', toolCallId: 'call_0' }), step({ id: 4, step: 'tool_result', toolCallId: 'call_0', text: 'second' }),
      step({ id: 5, step: 'tool_call', toolName: 'c', toolCallId: 'call_0', subagent: 'Sub' }), step({ id: 6, step: 'tool_result', toolCallId: 'call_0', subagent: 'Sub', text: 'sub' }),
    ];
    const pairs = pairTools(steps).filter((i) => i.kind === 'tool').map((i) => i.kind === 'tool' && [i.pair.call.id, i.pair.result?.id]);
    expect(pairs).toEqual([[1, 2], [3, 4], [5, 6]]);
  });

  it('starts a turn at each main-session prompt only', () => {
    const turns = groupTurns([step({ id: 0, step: 'response', text: 'resumed' }), ...STEPS,
      step({ id: 7, step: 'prompt', text: 'sub prompt', subagent: 'Explore' }), step({ id: 8, step: 'prompt', text: 'next' })]);
    expect(turns.map((t) => t.prompt?.id ?? null)).toEqual([null, 1, 8]);
  });

  it('summarises a tool input', () => {
    expect(toolSummary('{"command":"git status\\nmore"}')).toBe('git status');
    expect(toolSummary('{"file_path":"/a.ts"}')).toBe('/a.ts');
    expect(toolSummary('plain')).toBe('plain');
  });
});

describe('UsageSession', () => {
  it('shows the prompt, a tool card with its failed result, tokens, the subagent and loads full text on demand', async () => {
    const fetchMock = renderWith({ session: SESSION, runs: [], steps: STEPS, next: null }, undefined,
      (u) => (u.includes('/usage/messages/6') && u.includes('part=6') ? { id: 6, raw: {}, text: 'FULL TEXT HERE' } : null));
    await waitFor(() => expect(screen.getByText('Plan the usage board')).toBeTruthy());
    expect(screen.getByText('Build the usage board')).toBeTruthy();
    expect(screen.getByText('git status')).toBeTruthy();
    expect(screen.getByText('✗ error')).toBeTruthy();
    expect(screen.getByText('2.5 s')).toBeTruthy();
    expect(screen.getByText('fatal: not a git repository')).toBeTruthy();
    expect(screen.getByText(/claude-opus-5-5 · in 10 · cache w 100/)).toBeTruthy();
    expect(screen.getByText('subagent: Explore')).toBeTruthy();
    expect(screen.queryByText('secret plan of attack')).toBeNull();     // thinking hidden by default
    fireEvent.click(screen.getByRole('checkbox', { name: 'thinking' }));
    expect(screen.getByText('secret plan of attack')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /show full text/i }));
    await waitFor(() => expect(screen.getByText('FULL TEXT HERE')).toBeTruthy());
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/usage/agent-sessions/mac/s1');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('source=claude-code');
    expect(document.body.textContent).not.toContain('$');
    expect(document.body.textContent).not.toContain('USD');
  });

  it('loads the next page of a long session', async () => {
    const fetchMock = renderWith(null, undefined, (u) => (u.includes('offset=500')
      ? { session: SESSION, runs: [], steps: [step({ id: 900, step: 'response', text: 'page two' })], next: null }
      : { session: SESSION, runs: [], steps: STEPS.slice(0, 1), next: 500 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('page two')).toBeTruthy());
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('offset=500'))).toBe(true);
  });

  it('shows cost in USD for a hermes session', async () => {
    renderWith({ session: { ...SESSION, source: 'hermes', harness: 'hermes', profile: 'main', provider: 'openrouter', cost_usd: 1.5 }, runs: [], steps: [], next: null },
      '/usage/session/mac/s1?source=hermes');
    await waitFor(() => expect(screen.getByText('Plan the usage board')).toBeTruthy());
    expect(document.body.textContent).toContain('1.50 USD');
    expect(document.body.textContent).toContain('via openrouter');
  });

  it('shows a run with its verify result', async () => {
    const run = { run_id: 'r1', agent_name: null, task_id: 't9', lane: 'cc-a', started_at: null, num_turns: 3, subtype: 'success',
      verify_name: 'tests', verify_passed: true, verify_metric: null, verify_output: 'ok' };
    renderWith({ session: SESSION, runs: [run], steps: [], next: null });
    await waitFor(() => expect(document.body.textContent).toContain('Verify tests: passed'));
  });
});
