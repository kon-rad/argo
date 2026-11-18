import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { RosterAgent } from './policy.js';

/**
 * The agents a policy resolves for: the compiled roster (`.agents/org/org.json`) for name, team and
 * runtime, and the source config (`.agents/org/config/agents/<name>.yaml`, `org.yaml` defaults) for
 * `knowledge:` paths, which the compiled roster does not carry. Humans are left out. A vault with no
 * org config has no agents; that is an empty matrix, not an error.
 */
export interface Roster { agents: RosterAgent[]; teams: string[]; error: string | null }

const AGENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const obj = (v: unknown): Obj => isObj(v) ? v : {};
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function readYaml(path: string): Obj {
  try { return obj(yaml.safeLoad(readFileSync(path, 'utf8'))); } catch { return {}; }
}

export function loadRoster(vaultRoot: string): Roster {
  const orgDir = join(vaultRoot, '.agents', 'org');
  const configDir = join(orgDir, 'config');
  let agents: Obj = {};
  let teams: Obj = {};
  let error: string | null = null;
  const compiled = join(orgDir, 'org.json');
  const compiledPresent = (() => { try { lstatSync(compiled); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== 'ENOENT'; } })();
  if (compiledPresent) {
    try {
      const st = lstatSync(compiled);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('compiled roster must be a regular file');
      const doc: unknown = JSON.parse(readFileSync(compiled, 'utf8'));
      if (!isObj(doc) || !isObj(doc['agents']) || (doc['teams'] !== undefined && !isObj(doc['teams']))) throw new Error('expected agents and teams objects');
      for (const [name, agent] of Object.entries(doc['agents'])) {
        if (!AGENT.test(name) || !isObj(agent)) throw new Error(`invalid agent entry ${name}`);
        if (agent['runtime'] !== undefined && (typeof agent['runtime'] !== 'string' || !['claude-code', 'hermes', 'codex', 'zen-agent', 'human'].includes(agent['runtime']))) throw new Error(`invalid runtime for ${name}`);
        if (agent['team'] !== undefined && agent['team'] !== null && typeof agent['team'] !== 'string') throw new Error(`invalid team for ${name}`);
        if (agent['knowledge'] !== undefined && (!Array.isArray(agent['knowledge']) || agent['knowledge'].some(x => typeof x !== 'string'))) throw new Error(`invalid knowledge paths for ${name}`);
      }
      for (const [name, team] of Object.entries(doc['teams'] ?? {})) if (!isObj(team)) throw new Error(`invalid team entry ${name}`);
      agents = doc['agents']; teams = obj(doc['teams']);
    } catch (err) {
      agents = {}; teams = {};
      error = `org.json is invalid: ${(err as Error).message}`;
    }
  }
  const defaults = obj(readYaml(join(configDir, 'org.yaml'))['defaults']);
  const fromConfig: Record<string, Obj> = {};
  const agentsDir = join(configDir, 'agents');
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).sort()) {
      const m = /^([a-z0-9][a-z0-9-]{0,31})\.ya?ml$/.exec(f);
      if (m) fromConfig[m[1]!] = readYaml(join(agentsDir, f));
    }
  }
  if (!compiledPresent) {
    agents = fromConfig;
    const teamsDir = join(configDir, 'teams');
    if (existsSync(teamsDir)) for (const f of readdirSync(teamsDir)) { const m = /^(.+)\.ya?ml$/.exec(f); if (m) teams[m[1]!] = {}; }
  }
  const out: RosterAgent[] = [];
  for (const [name, raw] of Object.entries(agents)) {
    const a = obj(raw);
    if (!AGENT.test(name) || a['runtime'] === 'human') continue;
    const cfg = fromConfig[name] ?? {};
    out.push({
      name,
      team: typeof a['team'] === 'string' ? a['team'] : typeof cfg['team'] === 'string' ? (cfg['team'] as string) : null,
      runtime: typeof a['runtime'] === 'string' ? a['runtime'] : typeof cfg['runtime'] === 'string' ? (cfg['runtime'] as string) : 'claude-code',
      knowledge: [...strs(defaults['knowledge']), ...strs(cfg['knowledge']), ...strs(a['knowledge'])],
    });
  }
  out.sort((x, y) => x.name.localeCompare(y.name));
  return { agents: out, teams: Object.keys(teams).sort(), error };
}
