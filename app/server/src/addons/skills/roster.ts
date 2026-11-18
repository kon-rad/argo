import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
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
  if (existsSync(compiled)) {
    try {
      const doc = obj(JSON.parse(readFileSync(compiled, 'utf8')));
      agents = obj(doc['agents']);
      teams = obj(doc['teams']);
    } catch (err) {
      error = `org.json does not parse: ${(err as Error).message}`;
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
  if (!Object.keys(agents).length) {
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
