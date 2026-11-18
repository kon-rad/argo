import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { AssignmentCell, Lifecycle, Reason, SkillsMode, SupportLevel } from '@secondbrain/contracts/skills';
import type { Catalog, Candidate } from './catalog.js';
import { NAME_RE } from './package.js';

/**
 * The assignment policy: one YAML file in the vault's Git history (default `.agents/skills-policy.yaml`).
 * Git is its history and review route; nothing in Postgres edits it. Without the file, or with
 * `mode: legacy`, every runtime keeps discovering its whole skill folder exactly as before.
 *
 *   version: 1
 *   mode: managed            # legacy (the default) | managed
 *   org:    { grant: [fact-check], deny: [] }
 *   teams:  { media: { grant: [video-edit] } }
 *   agents: { writer-1: { grant: [ingest], deny: [video-edit] } }
 *   lifecycle: { old-skill: { status: deprecated, replacement: new-skill, note: "..." } }
 *   pins:   { report: "engine:report" }   # deploy this candidate instead of the effective one
 *
 * Denial wins over every grant at every level. `*` grants (or denies) every catalogued name.
 * A `knowledge:` path in the org config that names a skill is a reference, never a grant.
 */

const Ref = z.string().refine((s) => s === '*' || NAME_RE.test(s), { message: 'a skill name or * (pick a source under pins, not here)' });
const Scope = z.object({ grant: z.array(Ref).default([]), deny: z.array(Ref).default([]) }).strict().prefault({});
export const PolicySchema = z.object({
  version: z.literal(1),
  mode: z.enum(['legacy', 'managed']).default('legacy'),
  org: Scope,
  teams: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), Scope).default({}),
  agents: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), Scope).default({}),
  lifecycle: z.record(z.string().regex(NAME_RE), z.object({
    status: z.enum(['active', 'deprecated', 'disabled', 'removed']),
    replacement: z.string().regex(NAME_RE).optional(),
    note: z.string().max(500).optional(),
    since: z.string().max(40).optional(),
  }).strict()).default({}),
  pins: z.record(z.string().regex(NAME_RE), z.string().min(3).max(200)).default({}),
}).strict();
export type Policy = z.infer<typeof PolicySchema>;

export interface LoadedPolicy {
  policy: Policy;
  mode: SkillsMode;
  exists: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
  digest: string | null;
  text: string | null;
}

export const EMPTY_POLICY: Policy = PolicySchema.parse({ version: 1 });

export function parsePolicy(text: string | null): LoadedPolicy {
  if (text === null) return { policy: EMPTY_POLICY, mode: 'legacy', exists: false, valid: true, errors: [], warnings: [], digest: null, text: null };
  const digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  let raw: unknown;
  try { raw = yaml.safeLoad(text); } catch (err) {
    return { policy: EMPTY_POLICY, mode: 'managed', exists: true, valid: false, errors: [`YAML: ${(err as Error).message.split('\n')[0]}`], warnings: [], digest, text };
  }
  const parsed = PolicySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    // A policy that says managed but does not parse fails closed: nothing is granted and nothing is deployed from it.
    const said = raw && typeof raw === 'object' && (raw as { mode?: unknown }).mode === 'legacy' ? 'legacy' : 'managed';
    return { policy: EMPTY_POLICY, mode: said, exists: true, valid: false, errors: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`), warnings: [], digest, text };
  }
  return { policy: parsed.data, mode: parsed.data.mode, exists: true, valid: true, errors: [], warnings: [], digest, text };
}

export function loadPolicyFile(path: string): LoadedPolicy {
  return parsePolicy(existsSync(path) ? readFileSync(path, 'utf8') : null);
}

/** Checks that need the catalog and the roster: unknown names, teams, agents, pins. Warnings, not errors. */
export function policyWarnings(p: Policy, catalog: Catalog, agents: string[], teams: string[]): string[] {
  const out: string[] = [];
  const known = (n: string) => n === '*' || catalog.byName.has(n);
  const refs: [string, string][] = [];
  for (const n of [...p.org.grant, ...p.org.deny]) refs.push(['org', n]);
  for (const [t, s] of Object.entries(p.teams)) { if (!teams.includes(t)) out.push(`teams.${t}: no such team in the roster`); for (const n of [...s.grant, ...s.deny]) refs.push([`teams.${t}`, n]); }
  for (const [a, s] of Object.entries(p.agents)) { if (!agents.includes(a)) out.push(`agents.${a}: no such agent in the roster`); for (const n of [...s.grant, ...s.deny]) refs.push([`agents.${a}`, n]); }
  for (const [where, n] of refs) if (!known(n)) out.push(`${where}: "${n}" is not in any skill root`);
  for (const [n, id] of Object.entries(p.pins)) {
    const list = catalog.byName.get(n) ?? [];
    if (!list.some((c) => c.id === id)) out.push(`pins.${n}: no candidate ${id}`);
  }
  for (const [n, l] of Object.entries(p.lifecycle)) if (l.replacement && !catalog.byName.has(l.replacement)) out.push(`lifecycle.${n}.replacement: "${l.replacement}" is not in any skill root`);
  return out;
}

export function lifecycleOf(p: Policy, name: string): Lifecycle {
  const l = p.lifecycle[name];
  return { status: l?.status ?? 'active', replacement: l?.replacement ?? null, note: l?.note ?? null };
}

/** The candidate a managed deployment uses for a name: a pin if set, else the effective one. */
export function selectedCandidate(p: Policy, catalog: Catalog, name: string): { candidate: Candidate | null; error: string | null } {
  const list = catalog.byName.get(name) ?? [];
  if (!list.length) return { candidate: null, error: `no package named ${name} in any skill root` };
  const pin = p.pins[name];
  if (pin) {
    const c = list.find((x) => x.id === pin);
    return c ? { candidate: c, error: null } : { candidate: null, error: `pinned candidate ${pin} is missing` };
  }
  return { candidate: list[0]!, error: null };
}

export interface RosterAgent { name: string; team: string | null; runtime: string; knowledge: string[] }

export const SUPPORT: Record<string, { level: SupportLevel; note: string }> = {
  'zen-agent': { level: 'catalog-filtered', note: 'Catalog and read_skill are filtered to the managed snapshot; file and shell tools can still read other folders.' },
  'claude-code': { level: 'catalog-only', note: 'A generated skills folder to point the runtime at; global and project skill folders stay visible and files stay readable.' },
  hermes: { level: 'catalog-only', note: 'A generated folder for skills.external_dirs; profile-local skills stay visible and files stay readable.' },
  codex: { level: 'catalog-only', note: 'A generated folder for a workspace .agents/skills; other project and user skill folders stay visible and files stay readable. Native Codex loading is not isolated by this manager.' },
};
export function supportFor(runtime: string): { level: SupportLevel; note: string } {
  return SUPPORT[runtime] ?? { level: 'none', note: 'No skills adapter for this runtime: it sees whatever its own configuration loads.' };
}

/** Skill names a `knowledge:` path points into, for a reference marker. */
export function knowledgeSkills(paths: string[], names: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of paths) {
    const segs = raw.replace(/\\/g, '/').split('/').filter(Boolean);
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i] !== 'skills') continue;
      for (const cand of [segs[i + 1], segs[i + 2]]) if (cand && names.has(cand)) out.add(cand);
    }
  }
  return out;
}

/**
 * One agent's effective assignments with the reason for each. Managed: grants from org, team and agent,
 * minus denials at any level (denial wins), minus disabled/removed lifecycle, minus packages that are
 * missing or invalid. Legacy: every name, state `legacy`.
 */
export function resolveAgent(agent: RosterAgent, loaded: LoadedPolicy, catalog: Catalog): Map<string, AssignmentCell> {
  const names = [...catalog.byName.keys()];
  const refs = knowledgeSkills(agent.knowledge, new Set(names));
  const cells = new Map<string, AssignmentCell>();
  const cell = (skill: string): AssignmentCell => {
    let c = cells.get(skill);
    if (!c) { c = { agent: agent.name, skill, state: 'not-assigned', reasons: [], reference: refs.has(skill), deprecated: false, loaded: null }; cells.set(skill, c); }
    return c;
  };
  for (const r of refs) cell(r).reasons.push({ level: 'knowledge', kind: 'note', detail: 'named in this agent\'s knowledge paths (a reference, not a grant)' });

  if (loaded.mode === 'legacy') {
    for (const n of names) {
      const c = cell(n);
      c.state = 'legacy';
      c.reasons.unshift({ level: 'legacy', kind: 'note', detail: 'no managed policy: the runtime discovers every skill in its folders' });
      c.deprecated = loaded.policy.lifecycle[n]?.status === 'deprecated';
    }
    return cells;
  }
  if (!loaded.valid) {
    for (const n of names) {
      const c = cell(n);
      c.state = 'unavailable';
      c.reasons.unshift({ level: 'policy', kind: 'deny', detail: 'the policy file does not parse; nothing is granted until it is fixed' });
    }
    return cells;
  }

  const p = loaded.policy;
  const scopes: { level: Reason['level']; label: string; s: { grant: string[]; deny: string[] } }[] = [{ level: 'org', label: 'organization', s: p.org }];
  if (agent.team && p.teams[agent.team]) scopes.push({ level: 'team', label: `team ${agent.team}`, s: p.teams[agent.team]! });
  if (p.agents[agent.name]) scopes.push({ level: 'agent', label: `agent ${agent.name}`, s: p.agents[agent.name]! });
  const expand = (list: string[]) => (list.includes('*') ? names : list);
  const granted = new Set<string>();
  const denied = new Set<string>();
  for (const { level, label, s } of scopes) {
    for (const n of expand(s.grant)) { granted.add(n); cell(n).reasons.push({ level, kind: 'grant', detail: `granted to ${label}${s.grant.includes('*') ? ' (all skills)' : ''}` }); }
    for (const n of expand(s.deny)) { denied.add(n); cell(n).reasons.push({ level, kind: 'deny', detail: `denied for ${label}${s.deny.includes('*') ? ' (all skills)' : ''}` }); }
  }
  for (const n of granted) {
    const c = cell(n);
    if (denied.has(n)) { c.state = 'denied'; continue; }
    const life = lifecycleOf(p, n);
    if (life.status === 'disabled' || life.status === 'removed') {
      c.state = 'unavailable';
      c.reasons.push({ level: 'lifecycle', kind: 'deny', detail: `${life.status}${life.note ? `: ${life.note}` : ''}` });
      continue;
    }
    const sel = selectedCandidate(p, catalog, n);
    if (!sel.candidate) { c.state = 'unavailable'; c.reasons.push({ level: 'package', kind: 'deny', detail: sel.error! }); continue; }
    if (!sel.candidate.valid || !sel.candidate.digest) {
      c.state = 'unavailable';
      c.reasons.push({ level: 'package', kind: 'deny', detail: `package ${sel.candidate.id} is invalid: ${sel.candidate.errors.join('; ')}` });
      continue;
    }
    c.state = 'assigned';
    if (life.status === 'deprecated') {
      c.deprecated = true;
      c.reasons.push({ level: 'lifecycle', kind: 'note', detail: `deprecated${life.replacement ? `; use ${life.replacement}` : ''}${life.note ? `: ${life.note}` : ''}` });
    }
  }
  for (const n of denied) if (!granted.has(n)) cell(n).state = 'denied';
  // Dependencies are reported, never granted implicitly.
  for (const c of cells.values()) {
    if (c.state !== 'assigned') continue;
    const sel = selectedCandidate(p, catalog, c.skill).candidate;
    for (const d of sel?.metadata.depends ?? []) {
      const dc = cells.get(d);
      if (!dc || dc.state !== 'assigned') c.reasons.push({ level: 'package', kind: 'note', detail: `depends on ${d}, which this agent is not assigned` });
    }
  }
  return cells;
}

/** Skills that list `name` under metadata.depends (effective candidates only). */
export function dependentsOf(catalog: Catalog, name: string): string[] {
  const out: string[] = [];
  for (const [n, list] of catalog.byName) if (n !== name && list[0]?.metadata.depends.includes(name)) out.push(n);
  return out.sort();
}

/** Every policy line that grants a name: org, team or agent, for the removal check. */
export function grantsOf(p: Policy, name: string): string[] {
  const out: string[] = [];
  if (p.org.grant.includes(name) || p.org.grant.includes('*')) out.push('org.grant');
  for (const [t, s] of Object.entries(p.teams)) if (s.grant.includes(name) || s.grant.includes('*')) out.push(`teams.${t}.grant`);
  for (const [a, s] of Object.entries(p.agents)) if (s.grant.includes(name) || s.grant.includes('*')) out.push(`agents.${a}.grant`);
  if (p.pins[name]) out.push(`pins.${name}`);
  return out;
}
