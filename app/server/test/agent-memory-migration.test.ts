import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { truncateAll } from './helpers.js';

/**
 * The drop-agent-memory migration (engine core v2 phase 6): the per-bot persona store `org_agent_memory` is exported
 * into `memory_facts` (tagged with its owner's name) and then dropped. The test recreates the table from the
 * migration's own down section, seeds a couple of rows, runs the up section, and checks the rows landed with `agent`
 * set and the table is gone. The episodes table is untouched.
 */

const MIGRATION = readFileSync(join(import.meta.dirname, '..', '..', 'db', 'migrations', '1756000016900_drop-agent-memory.sql'), 'utf8');
const [UP, DOWN] = MIGRATION.split('-- Down Migration');
if (!UP || !DOWN) throw new Error('the migration file has no -- Down Migration marker');

const ORG = {
  version: 'mig-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner' },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas' },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' } },
  channels: { 'all-hands': { members: '*' } },
};

describe('drop-agent-memory migration', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });

  it('exports every persona row into memory_facts with agent set, then drops the table', async () => {
    // Recreate the table from the migration's down section, as it stood before this change.
    await query(DOWN!);
    expect((await query<{ t: string | null }>(`SELECT to_regclass('public.org_agent_memory') AS t`)).rows[0]!.t).toBe('org_agent_memory');

    await query(
      `INSERT INTO org_agent_memory (agent_name, kind, content, evidence_episode_ids, occurrences, active, retired_why) VALUES
        ('rune',  'friction', 'I retry npm ci on the server and it starves it.', '{}', 3, true,  NULL),
        ('atlas', 'lesson',   'I read the diff before the description.',          '{7}', 1, false, 'the rule moved to the skill')`,
    );

    await query(UP!);

    // The table is gone.
    expect((await query<{ t: string | null }>(`SELECT to_regclass('public.org_agent_memory') AS t`)).rows[0]!.t).toBeNull();

    // Both rows landed in memory_facts, tagged with their owner.
    const { rows } = await query<{ subject: string; claim: string; source: string; author: string; confidence: string; agent: string; valid_to: Date | null; retired_by: string | null; retired_why: string | null }>(
      `SELECT subject, claim, source, author, confidence, agent, valid_to, retired_by, retired_why FROM memory_facts ORDER BY agent`,
    );
    expect(rows).toEqual([
      {
        subject: 'atlas · lesson',
        claim: 'I read the diff before the description.',
        source: 'episode:7',
        author: 'summaries',
        confidence: 'inferred',
        agent: 'atlas',
        valid_to: expect.any(Date),
        retired_by: 'persona-export',
        retired_why: 'the rule moved to the skill',
      },
      {
        subject: 'rune · friction ×3',
        claim: 'I retry npm ci on the server and it starves it.',
        source: 'persona-export',
        author: 'summaries',
        confidence: 'inferred',
        agent: 'rune',
        valid_to: null,
        retired_by: null,
        retired_why: null,
      },
    ]);
  });

  it('leaves the episodic table in place', async () => {
    expect((await query<{ t: string | null }>(`SELECT to_regclass('public.org_agent_episodes') AS t`)).rows[0]!.t).toBe('org_agent_episodes');
  });
});
