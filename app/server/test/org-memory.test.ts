import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { agentDatabaseUrl, main } from '../src/cli-org.js';
import { config } from '../src/config.js';
import { query } from '../src/db.js';
import { claimWakeups, createTask, getAgent, importOrg } from '../src/org.js';
import {
  applyAudn,
  blockKeys,
  CORE_BUDGET_CEILING,
  deriveOutcome,
  editMemory,
  episodeSummary,
  extractAgentBlock,
  lineDiff,
  listMemory,
  logExcerpt,
  markCorrected,
  memorySettingsFor,
  memoryStats,
  namesAnotherAgent,
  parseAudn,
  parseMemoryConfig,
  proposeImprovement,
  PROPOSAL_MAX_CHANGED_LINES,
  recordEpisode,
  reflect,
  reflectProviders,
  renderCore,
  retireMemory,
  validateProposal,
  type AgentMemorySettings,
  type Completer,
  type MemoryRow,
} from '../src/org-memory.js';
import { recallMemoryFiles } from '../src/org-powers.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

/**
 * Agent persona memory (docs/agent-memory.md): every finished wake is an episode, the reflect step turns episodes into
 * first-person lessons under a budget, and a lesson that recurs becomes one self-improvement card a human applies.
 * The model is a scripted fake here; the tests cover the writes, the budget, the validator and the gates around it.
 */

const ORG = {
  version: 'memory-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', capabilities: ['review', 'merge'] },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas', capabilities: ['code'] },
    vera: { role: 'Reviewer', team: 'platform', reports_to: 'atlas', capabilities: ['review'] },
    juno: { role: 'Head of Media', team: 'media', reports_to: 'owner' },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' }, media: { name: 'Media', lead: 'juno' } },
  channels: { 'all-hands': { members: '*' }, leads: { members: ['owner', 'atlas', 'juno'] } },
};

const ORG_YAML = `version: memory-1
company: Argo
agents:
  atlas:
    role: Head of Platform
    personality: |
      Calm, exact.
    tools: [Read, Bash]
  rune:
    role: Platform engineer
    model: sonnet
    personality: |
      Direct. Prefers a small PR over a clever one.
    goal: |
      Ship the platform cards with tests.
    tools: [Read, Edit, Bash]
    capabilities: [code]
    wakes_per_day: 8
    knowledge:
      - .agents/skills/platform-notes
  vera:
    role: Reviewer
teams:
  platform:
    name: Platform
    lead: atlas
`;

function fixtureVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'sb-memory-'));
  mkdirSync(join(root, '.agents', 'org', 'memory'), { recursive: true });
  mkdirSync(join(root, '.agents', 'skills', 'platform-notes'), { recursive: true });
  writeFileSync(join(root, '.agents', 'org', 'org.yaml'), ORG_YAML);
  writeFileSync(
    join(root, '.agents', 'org', 'org-agents.json'),
    JSON.stringify({
      defaults: { memory: { core_budget_tokens: 1500 } },
      agents: {
        rune: { wakes_per_day: 8, knowledge: ['.agents/skills/platform-notes'], memory: { core_budget_tokens: 2000, self_improvement: { max_proposals_per_week: 1 } } },
        atlas: { wakes_per_day: 6, memory: { tiers: ['core', 'episodic'], self_improvement: { enabled: false } } },
      },
    }),
  );
  writeFileSync(join(root, '.agents', 'skills', 'platform-notes', 'SKILL.md'), '# platform notes\n\n- Run the tests before the PR.\n- Post one status per wake.\n');
  return root;
}

const vault = fixtureVault();
const settings = (): AgentMemorySettings => memorySettingsFor(vault, 'rune');
const runeBlock = (): string => extractAgentBlock(ORG_YAML, 'rune')!.lines.join('\n');

/** A scripted model: reflections answer from the queue, a proposal prompt answers with the prose change. */
function fakeModel(reflections: string[], proposal?: { target: string; after: string; rationale: string }): Completer {
  const q = [...reflections];
  return async (system) => {
    if (system.includes('Propose the smallest change')) return proposal ? JSON.stringify(proposal) : 'no idea';
    return q.shift() ?? '[{"op":"none"}]';
  };
}

const TEST_DB = process.env.SB_TEST_DB ?? 'secondbrain_test';
const asAgent = (name: string): string => agentDatabaseUrl(`postgres://sb_org@${process.env.PGHOST ?? 'localhost'}:${process.env.PGPORT ?? '5432'}/${TEST_DB}`, name);
async function asSbOrg<T extends pg.QueryResultRow>(agent: string, text: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: asAgent(agent) });
  await c.connect();
  try {
    return (await c.query<T>(text)).rows;
  } finally {
    await c.end();
  }
}

/** The CLI reads the vault root from config, parsed at import: point it at the fixture for the call. */
async function withVault<T>(fn: () => Promise<T>): Promise<T> {
  const prev = config.vaultRoot;
  (config as { vaultRoot: string }).vaultRoot = vault;
  try {
    return await fn();
  } finally {
    (config as { vaultRoot: string }).vaultRoot = prev;
  }
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('agent persona memory', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });
  afterAll(() => {
    /* the fixture vault is in the OS temp dir */
  });

  describe('config', () => {
    it('defaults work for a stranger and per-agent blocks merge over the defaults', () => {
      const d = parseMemoryConfig({});
      expect(d).toMatchObject({ tiers: ['core', 'episodic', 'semantic'], core_budget_tokens: 1500, reflect: { enabled: true, min_turns: 2, model: 'cheap' }, self_improvement: { enabled: true, repeat_threshold: 2, max_proposals_per_week: 1, requires_ship_gate: true } });
      const rune = memorySettingsFor(vault, 'rune');
      expect(rune.memory.core_budget_tokens).toBe(2000);
      expect(rune.knowledge).toEqual(['.agents/skills/platform-notes']);
      const atlas = memorySettingsFor(vault, 'atlas');
      expect(atlas.memory.tiers).toEqual(['core', 'episodic']);
      expect(atlas.memory.self_improvement.enabled).toBe(false);
      expect(atlas.memory.core_budget_tokens).toBe(1500);
      // No compiled file at all: defaults, no throw.
      expect(memorySettingsFor(mkdtempSync(join(tmpdir(), 'sb-empty-')), 'rune').memory.reflect.enabled).toBe(true);
    });

    it('rejects a budget over the ceiling, a bad target and a disabled ship gate', () => {
      expect(() => parseMemoryConfig({ core_budget_tokens: CORE_BUDGET_CEILING + 1 })).toThrow(/core_budget_tokens is at most 4000/);
      expect(() => parseMemoryConfig({ self_improvement: { targets: ['other_agent_prompt'] } })).toThrow(/targets/);
      expect(() => parseMemoryConfig({ self_improvement: { requires_ship_gate: false } })).toThrow(/requires_ship_gate/);
      expect(() => parseMemoryConfig({ self_improvement: { repeat_threshold: 1 } })).toThrow(/repeat_threshold/);
    });

    it('resolves the reflect model: off, cheap (local first), or provider/model', () => {
      expect(reflectProviders('cheap', { ORG_REFLECT_MODEL: 'off' })).toEqual([]);
      expect(reflectProviders('off', {})).toEqual([]);
      const cheap = reflectProviders('cheap', {});
      expect(cheap[0]?.id).toBe('ollama');
      expect(() => reflectProviders('nonsense', {})).toThrow(/cheap, off, or <provider>\/<model>/);
      // An explicit provider wins over the operator's cheap, never over off.
      expect(reflectProviders('ollama/qwen3:4b', {}).map((p) => `${p.id}/${p.model}`)).toEqual(['ollama/qwen3:4b']);
      expect(reflectProviders('ollama/qwen3:4b', { ORG_REFLECT_MODEL: 'off' })).toEqual([]);
    });
  });

  describe('episodes', () => {
    it('derives the outcome and writes a mechanical first-person summary', () => {
      expect(deriveOutcome({ exit: 1 })).toBe('error');
      expect(deriveOutcome({ exit: 0, result: 'blocked: waiting on the owner' })).toBe('blocked');
      expect(deriveOutcome({ result: 'changes requested by vera' })).toBe('request_changes');
      expect(deriveOutcome({ noReport: true })).toBe('no_report');
      expect(deriveOutcome({ outcome: 'done', exit: 2 })).toBe('done');
      expect(episodeSummary({ task: 't_000001', outcome: 'done', result: 'status: PR 12 opened\nmore' })).toBe('Worked card t_000001. Finished. status: PR 12 opened');
      expect(episodeSummary({ reason: 'chat', outcome: 'error' })).toBe('Worked a chat. Ended in an error.');
    });

    it('records one episode per run, idempotently, and wake-done records it with the card from the wakeup', async () => {
      const rune = await getAgent('rune');
      const a = await recordEpisode(rune, { run: 'r-1', task: 't_abc123', turns: 4, cost: 0.12, result: 'done' });
      const b = await recordEpisode(rune, { run: 'r-1', task: 't_abc123', turns: 9 });
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      expect(b.episode.id).toBe(a.episode.id);
      expect(a.episode).toMatchObject({ reason: 'task', outcome: 'done', turn_count: 4, cost_usd: '0.1200', summary: 'Worked card t_abc123. Finished. done' });

      const card = (await createTask(await getAgent('owner'), { assignee: 'rune', title: 'Build the thing' }, null)).task_id;
      const ws = await claimWakeups('rune', 'run-9');
      expect(ws).toHaveLength(1);
      const out: string[] = [];
      await withEnv({ ORG_REFLECT_MODEL: 'off' }, () => withVault(async () => {
        expect(await main(['wake-done', String(ws[0]!.id), '--run', 'run-9', '--exit', '0', '--result', 'status: built', '--turns', '7', '--cost', '0.3', '--duration', '120'], (s) => out.push(s))).toBe(0);
      }));
      expect(out.join('\n')).toMatch(/done 1 wakeup/);
      // The run left no status post, so wake-done posted the fallback and the episode says so.
      expect(out.join('\n')).toMatch(/episode #\d+ recorded \(no_report, 7 turns\)/);
      expect(out.join('\n')).toMatch(/reflect: skipped \(no reflect model/);
      const { rows } = await query<{ task_id: string; wakeup_ids: number[]; reason: string; duration_s: number }>(`SELECT task_id, wakeup_ids, reason, duration_s FROM org_agent_episodes WHERE run_id = 'run-9'`);
      expect(rows[0]).toMatchObject({ task_id: card, wakeup_ids: [String(ws[0]!.id)], reason: 'task', duration_s: 120 });
    });

    it('excerpts tool calls from a JSONL transcript and command lines from a text log', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sb-log-'));
      const jsonl = join(dir, 'run.jsonl');
      writeFileSync(jsonl, [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking aloud at length' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '3 failed' }] } }),
      ].join('\n'));
      const ex = logExcerpt(jsonl);
      expect(ex).toContain('> Bash {"command":"npm test"}');
      expect(ex).toContain('3 failed');
      expect(ex).not.toContain('thinking aloud');
      const txt = join(dir, 'run.log');
      writeFileSync(txt, 'hello\n$ npm ci\nERROR: ENOSPC\nprose\n');
      expect(logExcerpt(txt)).toBe('$ npm ci\nERROR: ENOSPC');
      expect(logExcerpt(join(dir, 'missing'))).toBe('');
    });
  });

  describe('AUDN', () => {
    it('parses ops out of prose, drops bad ones and caps the list', () => {
      expect(parseAudn('Sure. [{"op":"none"}]')).toEqual([{ op: 'none' }]);
      expect(parseAudn('<think>hmm</think>```json\n{"ops":[{"op":"add","kind":"lesson","content":"I write the test first."},{"op":"update","id":"4"},{"op":"explode"}]}\n```')).toEqual([
        { op: 'add', kind: 'lesson', content: 'I write the test first.' },
        { op: 'update', id: 4 },
      ]);
      expect(parseAudn('nothing here')).toEqual([]);
      expect(parseAudn(JSON.stringify(Array.from({ length: 9 }, () => ({ op: 'none' }))))).toHaveLength(6);
    });

    it('keeps a memory first-person: another agent is named only in a handoff', () => {
      const roster = ['owner', 'atlas', 'rune', 'vera'];
      expect(namesAnotherAgent('I should hand off the deploy to atlas sooner.', 'rune', roster)).toBeNull();
      expect(namesAnotherAgent('vera reviews my PRs within a day.', 'rune', roster)).toBe('vera');
      expect(namesAnotherAgent("atlas's standup was late", 'rune', roster)).toBe('atlas');
      expect(namesAnotherAgent('I under-scope cards without an acceptance test.', 'rune', roster)).toBeNull();
    });

    it('add, bump, supersede, close; ops on other rows or about other agents are dropped', async () => {
      const rune = await getAgent('rune');
      const vera = await getAgent('vera');
      const roster = ['owner', 'atlas', 'rune', 'vera', 'juno'];
      const e1 = (await recordEpisode(rune, { run: 'e1', turns: 3 })).episode;
      const e2 = (await recordEpisode(rune, { run: 'e2', turns: 3 })).episode;
      const e3 = (await recordEpisode(rune, { run: 'e3', turns: 3 })).episode;
      const theirs = (await applyAudn(vera, (await recordEpisode(vera, { run: 'v1' })).episode.id, [{ op: 'add', kind: 'lesson', content: 'I read the diff before the description.' }], roster)).added[0]!;

      const r1 = await applyAudn(rune, e1.id, [
        { op: 'add', kind: 'friction', content: 'I retry npm ci on the server and it starves it.' },
        { op: 'add', kind: 'lesson', content: 'vera does the reviews on Tuesdays.' },
        { op: 'none' },
      ], roster);
      expect(r1.added).toHaveLength(1);
      expect(r1.dropped).toEqual(['add: names vera (a memory is about my own work)']);
      const friction = r1.added[0]!;
      expect(friction).toMatchObject({ kind: 'friction', occurrences: 1, evidence_episode_ids: [e1.id], active: true });

      // The same text again is a bump, not a duplicate; an update by id too.
      const r2 = await applyAudn(rune, e2.id, [{ op: 'add', kind: 'friction', content: 'I retry npm ci on the server, and it starves it' }], roster);
      expect(r2.added).toHaveLength(0);
      expect(r2.bumped[0]).toMatchObject({ id: friction.id, occurrences: 2, evidence_episode_ids: [e1.id, e2.id] });
      const r3 = await applyAudn(rune, e2.id, [{ op: 'update', id: friction.id }, { op: 'update', id: theirs.id }, { op: 'delete', id: 999999, reason: 'x' }], roster);
      expect(r3.bumped[0]).toMatchObject({ id: friction.id, occurrences: 3, evidence_episode_ids: [e1.id, e2.id] });
      expect(r3.dropped).toEqual([`update #${theirs.id}: not one of my active memories`, 'delete #999999: not one of my active memories']);

      // New wording supersedes: a new row carries the count and evidence, the old one closes and stays.
      const r4 = await applyAudn(rune, e3.id, [{ op: 'update', id: friction.id, content: 'I never run npm ci on the server; it starves the box. The Mac only.' }], roster);
      const sup = r4.superseded[0]!;
      expect(sup).toMatchObject({ supersedes: friction.id, occurrences: 4, kind: 'friction', evidence_episode_ids: [e1.id, e2.id, e3.id] });
      const old = (await listMemory('rune', { all: true })).find((m) => m.id === friction.id)!;
      expect(old).toMatchObject({ active: false, retired_why: `superseded by #${sup.id}` });

      const r5 = await applyAudn(rune, e3.id, [{ op: 'delete', id: sup.id, reason: 'the server got more RAM' }], roster);
      expect(r5.retired).toEqual([sup.id]);
      expect(await listMemory('rune')).toEqual([]);
      expect((await listMemory('rune', { all: true })).find((m) => m.id === sup.id)!.retired_why).toBe('the server got more RAM');
      // vera's row was never touched.
      expect((await listMemory('vera'))[0]!.occurrences).toBe(1);
    });
  });

  describe('the core block', () => {
    const row = (id: number, occurrences: number, updated: string, kind: MemoryRow['kind'] = 'lesson'): MemoryRow => ({
      id, agent_name: 'rune', kind, content: `Lesson number ${id}, which is a sentence of ordinary length about how I do my work.`, evidence_episode_ids: [], occurrences,
      active: true, retired_why: null, supersedes: null, promoted_to_proposal: false, proposal_task_id: null, proposed_at: null, created_at: new Date(updated), updated_at: new Date(updated),
    });

    it('keeps the most-seen lines first, then the most recent, under the budget', () => {
      const rows = [row(1, 1, '2026-10-01'), row(2, 5, '2026-09-01', 'friction'), row(3, 3, '2026-10-10'), row(4, 3, '2026-10-20', 'anti_pattern'), row(5, 1, '2026-10-21')];
      const full = renderCore('rune', rows, 4000);
      expect(full.kept).toEqual([2, 4, 3, 5, 1]);
      expect(full.dropped).toEqual([]);
      expect(full.text).toMatch(/^# rune: core memory/);
      expect(full.text).toContain('## Friction\n- [m-2 ×5 · 2026-09-01]');
      expect(full.text.indexOf('## Lessons')).toBeLessThan(full.text.indexOf('## Anti-patterns'));
      const tight = renderCore('rune', rows, 160);
      expect(tight.kept).toEqual([2, 4, 3]);
      expect(tight.dropped).toEqual([5, 1]);
      expect(tight.text).not.toContain('m-1 ');
      // The header alone fits any sane budget; a budget too small for one line keeps nothing.
      expect(renderCore('rune', rows, 10).kept).toEqual([]);
    });
  });

  describe('reflect', () => {
    it('skips the model for a short run, a quiet agent and a capped day, but always records the episode', async () => {
      const rune = await getAgent('rune');
      const atlas = await getAgent('atlas');
      let calls = 0;
      const model: Completer = async () => (calls++, '[{"op":"add","kind":"lesson","content":"I learned."}]');
      const short = await reflect(rune, { run: 's1', turns: 1, vaultRoot: vault, completer: model });
      expect(short).toMatchObject({ created: true, reflected: false, skipped: 'run too short (1 < 2 turns)' });
      expect(existsSync(join(vault, '.agents', 'org', 'memory', 'rune', 'core.md'))).toBe(true);
      const quiet = await reflect(atlas, { run: 'a1', turns: 9, vaultRoot: vault, completer: model });
      expect(quiet.skipped).toBe('semantic tier is off for this agent');
      const noModel = await reflect(rune, { run: 's2', turns: 9, vaultRoot: vault, completer: null });
      expect(noModel.skipped).toMatch(/no reflect model/);
      const capped = await reflect(rune, { run: 's3', turns: 9, vaultRoot: vault, completer: model, maxPerDay: 0 });
      expect(capped.skipped).toBe('daily reflect cap reached (0)');
      expect(calls).toBe(0);
      expect((await query(`SELECT 1 FROM org_agent_episodes`)).rowCount).toBe(4);
      // A model that fails is logged and skipped; the episode is kept and can be reflected on later.
      const failing = await reflect(rune, { run: 's4', turns: 9, vaultRoot: vault, completer: async () => { throw new Error('connection refused'); } });
      expect(failing.skipped).toBe('reflect model failed: connection refused');
      const again = await reflect(rune, { run: 's4', turns: 9, vaultRoot: vault, completer: model });
      expect(again).toMatchObject({ created: false, reflected: true, applied: { added: [expect.objectContaining({ content: 'I learned.' })] } });
      expect((await reflect(rune, { run: 's4', turns: 9, vaultRoot: vault, completer: model })).skipped).toBe('run s4 was already reflected on');
    });

    it('two wakes with the same friction: lesson, bump, core block, then one proposal card a human must apply', async () => {
      const rune = await getAgent('rune');
      const after = runeBlock().replace('Direct. Prefers a small PR over a clever one.', 'Direct. Prefers a small PR over a clever one. Before building, I write the acceptance test the card implies and post it on the card.');
      const model = fakeModel(
        [
          '[{"op":"add","kind":"friction","content":"I get sent back when the card has no acceptance test; I should write one before building."}]',
          '[{"op":"update","id":"FIRST"}]',
        ],
        { target: '.agents/org/org.yaml', after, rationale: 'I keep getting corrected because I build before the test exists; my prompt should tell me to write it first.' },
      );
      // The second reflection names the row by id; the fake learns it after the first pass.
      const first = await reflect(rune, { run: 'w1', task: 't_aaa111', turns: 12, result: 'changes requested by vera', vaultRoot: vault, completer: model });
      expect(first.reflected).toBe(true);
      expect(first.applied!.added).toHaveLength(1);
      const row = first.applied!.added[0]!;
      expect(first.proposals).toEqual([]);
      const core = readFileSync(join(vault, '.agents', 'org', 'memory', 'rune', 'core.md'), 'utf8');
      expect(core).toContain(`- [m-${row.id} ×1 ·`);
      expect(core).toContain('## Friction');
      expect(recallMemoryFiles(vault, 'acceptance test card').some((h) => h.ref === `.agents/org/memory/rune/core.md:${core.split('\n').findIndex((l) => l.includes(`m-${row.id}`)) + 1}` && h.title === 'rune')).toBe(true);

      const second = await reflect(rune, { run: 'w2', task: 't_bbb222', turns: 10, result: 'changes requested again', vaultRoot: vault, completer: async (sys, usr) => (await model(sys, usr)).replace('FIRST', String(row.id)) });
      expect(second.applied!.bumped[0]).toMatchObject({ id: row.id, occurrences: 2 });
      expect(second.proposals).toHaveLength(1);
      const p = second.proposals[0]!;
      expect(p.refused).toBeNull();
      expect(p.target).toEqual({ kind: 'own_prompt', path: '.agents/org/org.yaml' });
      expect(p.diff).toContain('+      Direct. Prefers a small PR over a clever one. Before building, I write the acceptance test');
      expect(p.diff).not.toContain('+    tools');
      const { rows: cards } = await query<{ id: string; kind: string; assignee: string | null; created_by: string; body: string; title: string; status: string }>(`SELECT id, kind, assignee, created_by, body, title, status FROM cards`);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ id: p.card!.id, kind: 'improve', assignee: null, created_by: 'rune' });
      expect(cards[0]!.title).toMatch(/^self-improvement: rune, I get sent back/);
      expect(cards[0]!.body).toContain('```diff');
      expect(cards[0]!.body).toContain('A bot never applies a change to itself');
      expect(cards[0]!.body).toContain(`episodes #${first.episode.id}, #${second.episode.id}`);
      const mem = (await listMemory('rune'))[0]!;
      expect(mem).toMatchObject({ id: row.id, promoted_to_proposal: true, proposal_task_id: p.card!.id });
      expect(mem.proposed_at).not.toBeNull();
      // Nothing in the vault changed: the proposal is a card, not an edit.
      expect(readFileSync(join(vault, '.agents', 'org', 'org.yaml'), 'utf8')).toBe(ORG_YAML);

      // A third repeat does not re-propose (already filed), and another friction hits the weekly cap.
      const third = await reflect(rune, { run: 'w3', turns: 10, vaultRoot: vault, completer: async () => `[{"op":"update","id":${row.id}}]` });
      expect(third.proposals).toEqual([]);
      const other = await applyAudn(rune, third.episode.id, [{ op: 'add', kind: 'anti_pattern', content: 'I paste whole logs into statuses.' }], ['rune']);
      const fourth = await reflect(rune, { run: 'w4', turns: 10, vaultRoot: vault, completer: async () => `[{"op":"update","id":${other.added[0]!.id}}]` });
      expect(fourth.proposals[0]).toMatchObject({ memory_id: other.added[0]!.id, card: null, refused: 'refused: 1 proposal(s) a week already filed' });

      // The agent page shows all of it.
      const res = await request(createApp({ modules: ALL_MODULES, vaultRoot: vault })).get('/api/org/agents/rune').expect(200);
      expect(res.body.core).toContain('# rune: core memory');
      expect(res.body.core_path).toBe('.agents/org/memory/rune/core.md');
      expect(res.body.memory_rows.map((m: MemoryRow) => m.id)).toEqual([row.id, other.added[0]!.id]);
      expect(res.body.episodes).toHaveLength(4);
      expect(res.body.proposals[0]).toMatchObject({ id: row.id, proposal_task_id: p.card!.id, card_status: cards[0]!.status });
      expect(res.body.memory_stats).toMatchObject({ episodes: 4, memory: { active: 2 }, proposals: 1 });
      expect(res.body.memory_config.core_budget_tokens).toBe(2000);
    });
  });

  describe('the proposal validator', () => {
    const s = settings();
    const own = { kind: 'own_prompt' as const, path: '.agents/org/org.yaml' };

    it('reads the agent block and its keys out of org.yaml', () => {
      const b = extractAgentBlock(ORG_YAML, 'rune')!;
      expect(b.lines[0]).toBe('  rune:');
      expect(b.lines.at(-1)).toBe('      - .agents/skills/platform-notes');
      expect([...blockKeys(b.lines).keys()]).toEqual(['role', 'model', 'personality', 'goal', 'tools', 'capabilities', 'wakes_per_day', 'knowledge']);
      expect(extractAgentBlock(ORG_YAML, 'nobody')).toBeNull();
      expect(extractAgentBlock('teams:\n  x:\n    lead: a\n', 'rune')).toBeNull();
    });

    it('allows prose only, and names the field it refuses', () => {
      const before = runeBlock();
      const ok = validateProposal('rune', s, own, before, before.replace('Ship the platform cards with tests.', 'Ship the platform cards with tests, smallest diff first.'));
      expect(ok.changed).toBe(2);
      expect(ok.diff).toMatch(/^--- a\/\.agents\/org\/org\.yaml\n\+\+\+ b\//);
      expect(() => validateProposal('rune', s, own, before, before.replace('tools: [Read, Edit, Bash]', 'tools: [Read, Edit, Bash, WebFetch]'))).toThrow(/refused: the diff touches "tools"/);
      expect(() => validateProposal('rune', s, own, before, before.replace('capabilities: [code]', 'capabilities: [code, deploy]'))).toThrow(/touches "capabilities"/);
      expect(() => validateProposal('rune', s, own, before, before.replace('wakes_per_day: 8', 'wakes_per_day: 80'))).toThrow(/touches "wakes_per_day"/);
      expect(() => validateProposal('rune', s, own, before, before.replace('model: sonnet', 'model: opus'))).toThrow(/touches "model"/);
      expect(() => validateProposal('rune', s, own, before, `${before}\n    permission_mode: bypass`)).toThrow(/touches "permission_mode"/);
      expect(() => validateProposal('rune', s, own, before, before.replace('  rune:', '  atlas:'))).toThrow(/renames the agent block/);
      expect(() => validateProposal('rune', s, own, before, before)).toThrow(/changes nothing/);
      expect(() => validateProposal('rune', s, own, before, '   ')).toThrow(/empties the target/);
      const rewrite = before.replace('Direct. Prefers a small PR over a clever one.', Array.from({ length: PROPOSAL_MAX_CHANGED_LINES }, (_, i) => `      Line ${i} of a brand new personality.`).join('\n'));
      expect(() => validateProposal('rune', s, own, before, rewrite)).toThrow(/a patch of at most 40, not a rewrite/);
    });

    it('a skill target must be a markdown file under the agent\'s own knowledge, never a harness file', () => {
      const skill = { kind: 'own_skills' as const, path: '.agents/skills/platform-notes/SKILL.md' };
      const before = readFileSync(join(vault, skill.path), 'utf8');
      expect(validateProposal('rune', s, skill, before, `${before}- Write the acceptance test first.\n`).changed).toBe(1);
      expect(() => validateProposal('rune', s, { kind: 'own_skills', path: 'AGENTS.md' }, 'a', 'b')).toThrow(/harness or owner file/);
      expect(() => validateProposal('rune', s, { kind: 'own_skills', path: '.agents/guard.local.json' }, 'a', 'b')).toThrow(/harness or owner file/);
      expect(() => validateProposal('rune', s, { kind: 'own_skills', path: '.claude/agents/rune.md' }, 'a', 'b')).toThrow(/harness or owner file/);
      expect(() => validateProposal('rune', s, { kind: 'own_skills', path: '.agents/skills/other-bot/SKILL.md' }, 'a', 'b')).toThrow(/outside rune's knowledge paths/);
      expect(() => validateProposal('rune', s, { kind: 'own_skills', path: '.agents/skills/platform-notes/../../../AGENTS.md' }, 'a', 'b')).toThrow(/harness or owner file|not a vault-relative/);
      expect(() => validateProposal('rune', s, { kind: 'own_skills', path: '/etc/passwd' }, 'a', 'b')).toThrow(/not a vault-relative path/);
      expect(() => validateProposal('rune', s, { kind: 'own_skills', path: '.agents/skills/platform-notes/run.sh' }, 'a', 'b')).toThrow(/not a markdown file/);
      const noSkills: AgentMemorySettings = { ...s, memory: parseMemoryConfig({ self_improvement: { targets: ['own_prompt'] } }) };
      expect(() => validateProposal('rune', noSkills, skill, before, `${before}x`)).toThrow(/own_skills is not in this agent's self_improvement.targets/);
    });

    it('diffs lines and counts the changed ones', () => {
      const d = lineDiff('a\nb\nc', 'a\nB\nc\nd', 'f.md');
      expect(d.changed).toBe(3);
      expect(d.text).toBe('--- a/f.md\n+++ b/f.md\n a\n-b\n+B\n c\n+d');
    });

    it('propose-improvement gates: threshold, kind, a closed row, dry run, and the CLI exit code', async () => {
      const rune = await getAgent('rune');
      const ep = (await recordEpisode(rune, { run: 'p1', turns: 5 })).episode;
      const { added } = await applyAudn(rune, ep.id, [{ op: 'add', kind: 'friction', content: 'I forget to run the leak check before a PR.' }], ['rune']);
      const row = added[0]!;
      const answer = { target: '.agents/skills/platform-notes/SKILL.md', after: '# platform notes\n\n- Run the tests before the PR.\n- Run scripts/check-public.sh before the PR.\n- Post one status per wake.\n', rationale: 'I keep forgetting the leak check; my notes should list it.' };
      expect((await proposeImprovement(rune, row.id, { vaultRoot: vault, answer })).refused).toBe('refused: seen 1×, the threshold is 2');
      await query(`UPDATE org_agent_memory SET occurrences = 2 WHERE id = $1`, [row.id]);
      const dry = await proposeImprovement(rune, row.id, { vaultRoot: vault, answer, dryRun: true });
      expect(dry).toMatchObject({ refused: null, card: null, target: { kind: 'own_skills', path: answer.target } });
      expect(dry.diff).toContain('+- Run scripts/check-public.sh before the PR.');
      expect((await proposeImprovement(rune, row.id, { vaultRoot: vault, answer: { ...answer, target: '.agents/skills/other/SKILL.md' } })).refused).toMatch(/not one of rune's own files/);
      expect((await proposeImprovement(rune, row.id, { vaultRoot: vault, completer: async () => 'I would rather not' })).refused).toBe('refused: the model gave no usable proposal');
      expect((await proposeImprovement(rune, row.id, { vaultRoot: vault, completer: null })).refused).toBe('refused: no model to draft the proposal');
      // atlas has self-improvement off.
      const atlas = await getAgent('atlas');
      const ar = (await applyAudn(atlas, (await recordEpisode(atlas, { run: 'a9' })).episode.id, [{ op: 'add', kind: 'friction', content: 'I over-delegate.' }], ['atlas'])).added[0]!;
      await query(`UPDATE org_agent_memory SET occurrences = 3 WHERE id = $1`, [ar.id]);
      expect((await proposeImprovement(atlas, ar.id, { vaultRoot: vault, answer })).refused).toBe('refused: self_improvement is off for this agent');
      await expect(proposeImprovement(rune, ar.id, { vaultRoot: vault, answer })).rejects.toThrow(/no memory #\d+ for rune/);

      const out: string[] = [];
      await withEnv({ ORG_REFLECT_MODEL: 'off' }, () => withVault(async () => {
        expect(await main(['propose-improvement', 'rune', '--memory-id', String(row.id)], (s) => out.push(s))).toBe(3);
        expect(await main(['propose-improvement', 'rune', '--memory-id', String(row.id), '--json'], (s) => out.push(s))).toBe(3);
      }));
      expect(out.join('\n')).toMatch(/not proposed: refused: no model/);
      expect(JSON.parse(out.at(-1)!)).toMatchObject({ memory_id: row.id, card: null });
      const filed = await proposeImprovement(rune, row.id, { vaultRoot: vault, answer });
      expect(filed.card).not.toBeNull();
      expect((await proposeImprovement(rune, row.id, { vaultRoot: vault, answer })).refused).toMatch(/already filed a proposal/);
    });
  });

  describe('editing, stats, security', () => {
    it('the owner or the lead corrects a line (superseding it); a bot cannot, not even its own', async () => {
      const rune = await getAgent('rune');
      const ep = (await recordEpisode(rune, { run: 'm1' })).episode;
      const row = (await applyAudn(rune, ep.id, [{ op: 'add', kind: 'preference', content: 'I like long PR descriptions.' }], ['rune'])).added[0]!;
      await expect(editMemory(rune, row.id, 'x')).rejects.toThrow(/can't edit rune's memory/);
      await expect(editMemory(await getAgent('juno'), row.id, 'x')).rejects.toThrow(/can't edit rune's memory/);
      const fixed = await editMemory(await getAgent('atlas'), row.id, 'I keep PR descriptions to what changed and why.');
      expect(fixed).toMatchObject({ supersedes: row.id, occurrences: 1, kind: 'preference' });
      expect((await listMemory('rune', { all: true })).find((m) => m.id === row.id)).toMatchObject({ active: false, retired_why: `edited by atlas: superseded by #${fixed.id}` });
      await expect(editMemory(await getAgent('owner'), row.id, 'again')).rejects.toThrow(/already closed/);
      expect(await retireMemory(await getAgent('owner'), fixed.id, 'not a preference, a rule')).toBe('rune');
      expect(await listMemory('rune')).toEqual([]);
      const out: string[] = [];
      await withEnv({ ORG_AGENT: 'owner' }, () => withVault(async () => {
        expect(await main(['memory', 'rune', '--all'], (s) => out.push(s))).toBe(0);
        expect(await main(['memory', 'stats', 'rune'], (s) => out.push(s))).toBe(0);
        expect(await main(['memory', 'episodes', 'rune'], (s) => out.push(s))).toBe(0);
        expect(await main(['memory', 'retire', String(fixed.id), 'already closed'], (s) => out.push(s)).catch((e: Error) => e.message)).toMatch(/already closed/);
      }));
      expect(out.join('\n')).toContain(`#${fixed.id} [preference, ×1`);
      expect(out.join('\n')).toMatch(/rune, last 14 days: 1 episodes/);
      expect(out.join('\n')).toMatch(/#\d+ .* owner {3}done.*run m1/);
    });

    it('stats: corrections and cost per completed card, from the episodes', async () => {
      const rune = await getAgent('rune');
      await recordEpisode(rune, { run: 'c1', task: 't_c00001', outcome: 'done', cost: 0.5, turns: 10 });
      await recordEpisode(rune, { run: 'c2', task: 't_c00002', outcome: 'done', cost: 1.5, turns: 20 });
      await recordEpisode(rune, { run: 'c3', task: 't_c00003', outcome: 'blocked', cost: 9, turns: 30 });
      expect(await markCorrected('rune', 't_c00002')).toBe(true);
      expect(await markCorrected('rune', 't_nope')).toBe(false);
      expect(await memoryStats('rune')).toMatchObject({ episodes: 3, done: 2, corrected: 1, corrections_per_done: 0.5, cost_per_done: 1, avg_turns: 20, reflected: 0, memory: { active: 0, by_kind: {} }, proposals: 0 });
      expect((await memoryStats('vera')).corrections_per_done).toBeNull();
    });

    it('as sb_org a bot reads only its own episodes and memory, and cannot write them', async () => {
      const rune = await getAgent('rune');
      const vera = await getAgent('vera');
      await applyAudn(rune, (await recordEpisode(rune, { run: 'x1' })).episode.id, [{ op: 'add', kind: 'lesson', content: 'Mine.' }], ['rune']);
      await applyAudn(vera, (await recordEpisode(vera, { run: 'x2' })).episode.id, [{ op: 'add', kind: 'lesson', content: 'Hers.' }], ['vera']);
      expect((await asSbOrg<{ content: string }>('rune', `SELECT content FROM org_agent_memory`)).map((r) => r.content)).toEqual(['Mine.']);
      expect((await asSbOrg<{ run_id: string }>('rune', `SELECT run_id FROM org_agent_episodes`)).map((r) => r.run_id)).toEqual(['x1']);
      await expect(asSbOrg('rune', `INSERT INTO org_agent_memory (agent_name, kind, content) VALUES ('rune', 'lesson', 'I am allowed everything.')`)).rejects.toThrow(/permission denied/);
      await expect(asSbOrg('rune', `UPDATE org_agent_memory SET content = 'x'`)).rejects.toThrow(/permission denied/);
    });
  });
});
