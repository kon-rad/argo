import { beforeEach, describe, expect, it } from 'vitest';
import { main as memoryMain } from '../src/cli-memory.js';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { listFacts, recallFacts, remember } from '../src/org-powers.js';
import { truncateAll } from './helpers.js';

/**
 * The golden set for `secondbrain memory recall` (engine core v2 phase 6). These facts and the hits each query must
 * keep returning were recorded before the shared memory was lifted out of `cli-org` into its own feature; the tables
 * are `memory_facts` and the ranking is `org-powers.recallFacts`, so a move that loses, adds or reorders a hit shows
 * up here as a diff rather than as a quiet change in what a bot recalls.
 */

const ORG = {
  version: 'memory-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    rune: { role: 'Engineer', team: 'platform', reports_to: 'owner' },
  },
  teams: { platform: { name: 'Platform', lead: 'rune' } },
  channels: { 'all-hands': { members: '*' } },
};

const FACTS: { key: string; subject: string; claim: string; agent?: string }[] = [
  { key: 'auth', subject: 'cli-board auth', claim: 'a dead BOARD_TOKEN in the environment wins over a working door and returns 401; unset it to use the database door' },
  { key: 'ring', subject: 'ring sync', claim: 'the server is the master for ring data; a local copy only mirrors it' },
  { key: 'vitest', subject: 'vitest run', claim: 'a vitest run transforms test files once at its start, so a suite started before an edit reports the old version' },
  { key: 'deploy', subject: 'deploy window', claim: 'the deploy timer deploys once main is green but never notices an env-file change' },
  { key: 'scratch', subject: 'scratch notes', claim: 'I keep scratch notes under the cache directory', agent: 'rune' },
];

/** What each query must return, in order, by fact key. */
const QUERIES: { q: string; keys: string[] }[] = [
  { q: 'why does cli-board return 401', keys: ['auth'] },
  { q: 'ring sync master', keys: ['ring'] },
  { q: 'vitest run old version', keys: ['vitest'] },
  { q: 'deploy env-file change', keys: ['deploy'] },
  { q: 'scratch notes', keys: ['scratch'] },
  { q: 'unicorn rainbow glitter nonsense', keys: [] },
];

beforeEach(async () => {
  await truncateAll();
  await importOrg(ORG);
});

describe('memory recall golden set', () => {
  it('returns the same hits, in the same order, for every recorded query', async () => {
    const owner = { name: 'owner' };
    const id = new Map<string, number>();
    for (const f of FACTS) id.set(f.key, (await remember(owner, { subject: f.subject, claim: f.claim, source: 'docs/memory.md', agent: f.agent })).id);

    for (const { q, keys } of QUERIES) {
      const hits = await recallFacts(q);
      expect(hits.map((h) => h.ref), q).toEqual(keys.map((k) => `fact #${id.get(k)}`));
    }
  });

  it('tags a fact as one agent\'s and filters on it, without hiding the company-wide ones', async () => {
    const owner = { name: 'owner' };
    for (const f of FACTS) await remember(owner, { subject: f.subject, claim: f.claim, source: 'docs/memory.md', agent: f.agent });
    expect((await listFacts({ agent: 'rune' })).map((f) => f.subject)).toEqual(['scratch notes']);
    expect((await listFacts({ agent: 'rune' })).every((f) => f.agent === 'rune')).toBe(true);
    expect((await listFacts({})).length).toBe(FACTS.length);
    expect((await listFacts({})).filter((f) => f.agent === null).length).toBe(FACTS.length - 1);
  });

  it('refuses an agent that is not on the roster', async () => {
    await expect(remember({ name: 'owner' }, { subject: 'x', claim: 'y', source: 'z', agent: 'nobody' })).rejects.toThrow(/no active agent/);
    expect((await query(`SELECT 1 FROM memory_facts`)).rowCount).toBe(0);
  });
});

describe('the memory CLI', () => {
  it('remembers, lists, recalls and retires, and rejects an unknown flag', async () => {
    const lines: string[] = [];
    const out = (s: string): void => lines.push(s);
    expect(await memoryMain(['remember', 'deploy window', 'the timer never notices an env change', '--source', 'docs/memory.md'], out)).toBe(0);
    expect(lines.join('\n')).toMatch(/fact #\d+ saved/);

    lines.length = 0;
    expect(await memoryMain(['list', '--subject', 'deploy', '--json'], out)).toBe(0);
    const listed = JSON.parse(lines.join('\n')) as { id: number; subject: string }[];
    expect(listed.map((f) => f.subject)).toEqual(['deploy window']);

    lines.length = 0;
    expect(await memoryMain(['stats'], out)).toBe(0);
    expect(lines.join('\n')).toMatch(/1 current facts/);

    await expect(memoryMain(['list', '--wat'], out)).rejects.toThrow(/unknown flag --wat/);

    lines.length = 0;
    expect(await memoryMain(['retire', String(listed[0]!.id), 'no longer true'], out)).toBe(0);
    expect(lines.join('\n')).toBe(`fact #${listed[0]!.id} closed`);
    expect((await listFacts({ all: true }))[0]!.valid_to).not.toBeNull();
  });
});
