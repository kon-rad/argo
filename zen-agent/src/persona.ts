import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZenConfig } from './config.js';
import { splitFrontmatter } from './skills.js';

/**
 * Who the agent is this run. A persona is one agent of the org roster (the
 * compiled `org.json`, or `org.yaml`: name, role, team, reports_to, model,
 * expertise, capabilities), plus its definition file (`<definitions>/<name>.md`,
 * the same file Claude Code runs it with, minus frontmatter) and its playbook
 * (`<memory>/<name>.md`, the lessons it keeps between runs). Any part may be
 * missing; a bare name with a definition file is enough.
 */
export interface Persona {
  name: string;
  role: string;
  team: string | null;
  teamName: string | null;
  reportsTo: string | null;
  lead: boolean;
  model: string | null;
  expertise: string | null;
  capabilities: string[];
  definition: string | null;
  playbook: string | null;
  playbookPath: string;
}

interface OrgAgent {
  runtime?: string;
  role?: string;
  team?: string;
  reports_to?: string;
  model?: string;
  expertise?: string;
  capabilities?: string[];
}
interface OrgDoc {
  agents?: Record<string, OrgAgent>;
  teams?: Record<string, { name?: string; lead?: string }>;
}

export function readOrg(path: string): OrgDoc | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const doc = /\.ya?ml$/.test(path) ? parseYaml(text) : JSON.parse(text);
  return doc && typeof doc === 'object' ? (doc as OrgDoc) : null;
}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function loadPersona(cfg: Pick<ZenConfig, 'persona'>, name: string): Persona {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error(`persona name "${name}": lowercase letters, digits and dashes`);
  const org = readOrg(cfg.persona.org);
  const entry = org?.agents?.[name];
  const defPath = join(cfg.persona.definitions, `${name}.md`);
  const definitionFile = readOptional(defPath);
  if (!entry && definitionFile === null) {
    throw new Error(`no persona "${name}": not in ${cfg.persona.org} and no ${defPath}`);
  }
  if (entry?.runtime === 'human') throw new Error(`${name} is the human on the roster; an agent cannot be it`);
  const definition = definitionFile === null ? null : splitFrontmatter(definitionFile).body.trim() || null;
  const team = entry?.team ?? null;
  const teamDoc = team ? org?.teams?.[team] : undefined;
  const playbookPath = join(cfg.persona.memory, `${name}.md`);
  return {
    name,
    role: entry?.role ?? 'agent',
    team,
    teamName: teamDoc?.name ?? null,
    reportsTo: entry?.reports_to ?? (teamDoc?.lead && teamDoc.lead !== name ? teamDoc.lead : null),
    lead: teamDoc?.lead === name,
    model: entry?.model ?? null,
    expertise: entry?.expertise ?? null,
    capabilities: [...new Set(entry?.capabilities ?? [])],
    definition,
    playbook: readOptional(playbookPath)?.trim() || null,
    playbookPath,
  };
}

export function listPersonas(cfg: Pick<ZenConfig, 'persona'>): { name: string; role: string; team: string | null; runtime: string }[] {
  const org = readOrg(cfg.persona.org);
  return Object.entries(org?.agents ?? {})
    .filter(([, a]) => a.runtime !== 'human')
    .map(([name, a]) => ({ name, role: a.role ?? 'agent', team: a.team ?? null, runtime: a.runtime ?? 'claude-code' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The identity line and the roster facts, as the top of the system prompt. */
export function personaHeader(p: Persona): string {
  const where = [p.team ? `on team ${p.teamName ?? p.team}` : '', p.reportsTo ? `reporting to ${p.reportsTo}` : ''].filter(Boolean).join(', ');
  const lines = [`You are ${p.name}, ${p.role}${where ? ` ${where}` : ''}.${p.lead ? ' You lead the team.' : ''}`];
  if (p.expertise) lines.push(`Expertise: ${p.expertise}`);
  if (p.capabilities.length) lines.push(`Capabilities beyond the board: ${p.capabilities.join(', ')}.`);
  return lines.join('\n');
}
