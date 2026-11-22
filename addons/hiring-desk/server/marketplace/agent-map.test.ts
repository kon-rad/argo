import { describe, expect, it } from 'vitest';
import { parseAgentMap, resolveAgent } from './agent-map.js';
import { categorizeRequest } from './categorize.js';

const L1 = '10000000-0000-4000-8000-000000000001', L2 = '10000000-0000-4000-8000-000000000002';
const A1 = '20000000-0000-4000-8000-000000000001', A2 = '20000000-0000-4000-8000-000000000002';

describe('trusted agent map', () => {
  it('parses an empty setting as no mapping and rejects malformed entries at boot', () => {
    expect(parseAgentMap(undefined)).toEqual([]);
    expect(parseAgentMap('')).toEqual([]);
    expect(() => parseAgentMap('{')).toThrow(/JSON array/);
    expect(() => parseAgentMap('{}')).toThrow(/JSON array/);
    expect(() => parseAgentMap(JSON.stringify([{ localAgent: 'akira' }]))).toThrow(/listingId or an agentId/);
    expect(() => parseAgentMap(JSON.stringify([{ listingId: 'not-a-uuid', localAgent: 'akira' }]))).toThrow(/listingId/);
    expect(() => parseAgentMap(JSON.stringify([{ listingId: L1, localAgent: 'Akira Display Name' }]))).toThrow(/localAgent/);
    expect(() => parseAgentMap(JSON.stringify([{ listingId: L1, localAgent: 'akira', agentName: 'Akira' }]))).toThrow(/unknown keys/);
    expect(parseAgentMap(JSON.stringify([{ listingId: L1.toUpperCase(), localAgent: 'akira' }]))).toEqual([{ listingId: L1, localAgent: 'akira' }]);
  });

  it('maps by listing, by agent, or by both keys together', () => {
    const map = parseAgentMap(JSON.stringify([{ listingId: L1, localAgent: 'akira' }, { agentId: A2, localAgent: 'echo' }]));
    expect(resolveAgent(map, { listingId: L1, agentId: null })).toEqual({ state: 'mapped', localAgent: 'akira' });
    expect(resolveAgent(map, { listingId: L2, agentId: A2 })).toEqual({ state: 'mapped', localAgent: 'echo' });
    const both = parseAgentMap(JSON.stringify([{ listingId: L1, agentId: A1, localAgent: 'akira' }]));
    expect(resolveAgent(both, { listingId: L1, agentId: A1 })).toEqual({ state: 'mapped', localAgent: 'akira' });
  });

  it('reports a missing mapping instead of guessing', () => {
    const map = parseAgentMap(JSON.stringify([{ listingId: L1, localAgent: 'akira' }]));
    const result = resolveAgent(map, { listingId: L2, agentId: A1 });
    expect(result.state).toBe('missing');
    expect(resolveAgent([], { listingId: L1, agentId: null }).state).toBe('missing');
  });

  it('does not map a listing pinned to one Cybazaar agent when the request names another agent', () => {
    const map = parseAgentMap(JSON.stringify([{ listingId: L1, agentId: A1, localAgent: 'akira' }]));
    const other = resolveAgent(map, { listingId: L1, agentId: A2 });
    expect(other.state).toBe('missing');
    expect(resolveAgent(map, { listingId: L1, agentId: null }).state).toBe('missing');
  });

  it('reports ambiguity when two entries name different local agents', () => {
    const duplicate = parseAgentMap(JSON.stringify([{ listingId: L1, localAgent: 'akira' }, { listingId: L1, localAgent: 'echo' }]));
    expect(resolveAgent(duplicate, { listingId: L1, agentId: null })).toMatchObject({ state: 'ambiguous' });
    const crossKey = parseAgentMap(JSON.stringify([{ listingId: L1, localAgent: 'akira' }, { agentId: A1, localAgent: 'echo' }]));
    expect(resolveAgent(crossKey, { listingId: L1, agentId: A1 })).toMatchObject({ state: 'ambiguous' });
    const same = parseAgentMap(JSON.stringify([{ listingId: L1, localAgent: 'akira' }, { agentId: A1, localAgent: 'akira' }]));
    expect(resolveAgent(same, { listingId: L1, agentId: A1 })).toEqual({ state: 'mapped', localAgent: 'akira' });
  });

  it('never assigns a request whose identity changed after import', () => {
    const map = parseAgentMap(JSON.stringify([{ listingId: L1, localAgent: 'akira' }]));
    expect(resolveAgent(map, { listingId: L1, agentId: null, identityConflict: true }).state).toBe('conflict');
  });
});

describe('request categorization', () => {
  it('puts each lifecycle state and linked card status in one view', () => {
    expect(categorizeRequest('submitted', null)).toBe('inbox');
    expect(categorizeRequest('accepted', 'triage')).toBe('active');
    expect(categorizeRequest('accepted', null)).toBe('active');
    expect(categorizeRequest('in_progress', 'running')).toBe('active');
    expect(categorizeRequest('in_progress', 'review')).toBe('review');
    expect(categorizeRequest('revision_requested', 'done')).toBe('review');
    expect(categorizeRequest('revision_requested', 'ready')).toBe('active');
    expect(categorizeRequest('completed', 'done')).toBe('closed');
    expect(categorizeRequest('rejected', null)).toBe('closed');
    expect(categorizeRequest('cancelled', 'triage')).toBe('closed');
  });
});
