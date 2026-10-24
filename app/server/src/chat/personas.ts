import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../db.js';

/**
 * Who answers. The default assistant always exists; every agent of the org
 * module's chart (`org_agents`, imported from the vault's org file) is a
 * persona too, so the same cast the message board shows can be asked
 * questions here. An agent's definition is the compiled file Claude Code
 * runs it with, `.claude/agents/<name>.md` in the vault, minus its
 * frontmatter; when there is none, the role and expertise from the chart
 * stand in.
 */

export interface Persona {
  id: string;
  name: string;
  role: string;
  team: string | null;
  /** True for the built-in assistant. */
  builtin: boolean;
}

export interface PersonaDefinition extends Persona {
  prompt: string | null;
}

export const DEFAULT_PERSONA: Persona = { id: 'default', name: 'Second brain', role: 'The vault\'s assistant', team: null, builtin: true };

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export async function listPersonas(): Promise<Persona[]> {
  let agents: Persona[] = [];
  try {
    const { rows } = await query<{ name: string; role: string; team_slug: string | null }>(
      `SELECT name, role, team_slug FROM org_agents
       WHERE retired_at IS NULL AND runtime <> 'human' ORDER BY team_slug NULLS LAST, name`,
    );
    agents = rows.map((r) => ({ id: r.name, name: r.name, role: r.role, team: r.team_slug, builtin: false }));
  } catch {
    // No org tables on this schema, or no org at all: only the default persona.
  }
  return [DEFAULT_PERSONA, ...agents];
}

export async function personaDefinition(vaultRoot: string, id: string): Promise<PersonaDefinition | null> {
  if (id === DEFAULT_PERSONA.id) return { ...DEFAULT_PERSONA, prompt: null };
  if (!NAME.test(id)) return null;
  type Row = { name: string; role: string; team_slug: string | null; expertise: string | null };
  let row: Row | undefined;
  try {
    const { rows } = await query<Row>(
      `SELECT name, role, team_slug, expertise FROM org_agents WHERE name = $1 AND retired_at IS NULL AND runtime <> 'human'`,
      [id],
    );
    row = rows[0];
  } catch {
    return null;
  }
  if (!row) return null;
  const file = await readFile(join(vaultRoot, '.claude', 'agents', `${id}.md`), 'utf8').catch(() => null);
  const prompt = file
    ? file.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
    : [row.role, row.expertise ? `Expertise: ${row.expertise}` : ''].filter(Boolean).join('\n');
  return { id, name: row.name, role: row.role, team: row.team_slug, builtin: false, prompt: prompt || null };
}
