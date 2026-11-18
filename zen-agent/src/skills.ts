import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Skills in the Agent Skills layout: `<dir>/<name>/SKILL.md` with a YAML
 * frontmatter carrying `name` and `description`. The system prompt lists
 * names and descriptions only; the `read_skill` tool loads a body on demand,
 * so an unused skill costs a line per turn, not a page.
 */
export interface Skill {
  name: string;
  description: string;
  dir: string;
  file: string;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = FRONT.exec(text);
  if (!m) return { meta: {}, body: text };
  let meta: unknown = {};
  try {
    meta = parseYaml(m[1]!);
  } catch {
    meta = {};
  }
  return { meta: meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}, body: text.slice(m[0].length) };
}

export function discoverSkills(dirs: string[]): Skill[] {
  const seen = new Map<string, Skill>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillDir = join(dir, entry);
      const file = join(skillDir, 'SKILL.md');
      try {
        if (!statSync(skillDir).isDirectory() || !existsSync(file)) continue;
      } catch {
        continue; // a dangling symlink
      }
      const { meta } = splitFrontmatter(readFileSync(file, 'utf8'));
      const name = typeof meta['name'] === 'string' && meta['name'].trim() ? meta['name'].trim() : entry;
      if (seen.has(name)) continue; // first dir wins: a private skill shadows a shared one
      const description = typeof meta['description'] === 'string' ? meta['description'].trim() : '';
      seen.set(name, { name, description, dir: skillDir, file });
    }
  }
  return [...seen.values()];
}

export function skillBody(skill: Skill): string {
  return splitFrontmatter(readFileSync(skill.file, 'utf8')).body.trim();
}

/** One line per skill, descriptions clipped: this is what every turn pays for. */
export function skillsIndex(skills: Skill[], maxDescription = 240): string {
  return skills
    .map((s) => {
      const d = s.description.replace(/\s+/g, ' ');
      return `- ${s.name}: ${d.length > maxDescription ? d.slice(0, maxDescription - 1) + '…' : d}`;
    })
    .join('\n');
}
