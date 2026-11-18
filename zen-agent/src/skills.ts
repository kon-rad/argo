import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZenConfig } from './config.js';
import { isIgnoredName, packageDigest } from './skillpkg.js';

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
  /** Managed packages only: the source-qualified id, full package digest and Git revision from the view manifest. */
  id?: string;
  digest?: string;
  revision?: string | null;
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

// ---------------------------------------------------------------------------
// Managed skills: a generated per-agent view, pinned into a per-run snapshot
// ---------------------------------------------------------------------------

export type SkillsMode = 'legacy' | 'managed' | 'managed-missing';

export interface ResolvedSkills {
  skills: Skill[];
  mode: SkillsMode;
  /** The exact managed packages this run uses; empty in legacy mode. */
  packages: { name: string; id: string; digest: string; revision: string | null }[];
  rejected: { name: string; reason: string }[];
  snapshot: string | null;
  /** What the filter covers: the catalog and read_skill. File and shell tools are not isolated. */
  support: 'catalog-filtered' | null;
}

export const VIEW_FORMAT = 'secondbrain-skills-view/1';
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

interface ManifestEntry {
  name: string;
  id: string;
  digest: string;
  revision: string | null;
  description: string;
  path: string;
}

/** The view manifest, validated; throws with the reason when it is malformed. */
export function readViewManifest(file: string, expectedAgent?: string): { agent: string; runtime: string; skills: ManifestEntry[] } {
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (!doc || doc['format'] !== VIEW_FORMAT) throw new Error(`not a ${VIEW_FORMAT} manifest`);
  if (typeof doc['agent'] !== 'string' || !NAME.test(doc['agent']) || (expectedAgent && doc['agent'] !== expectedAgent)) throw new Error('manifest agent does not match the requested persona');
  if (doc['runtime'] !== 'zen-agent') throw new Error('manifest runtime must be zen-agent');
  return { agent: doc['agent'], runtime: doc['runtime'], skills: manifestEntries(doc['skills']) };
}

function manifestEntries(raw: unknown): ManifestEntry[] {
  if (!Array.isArray(raw) || raw.length > 500) throw new Error('manifest needs at most 500 skills');
  const seen = new Set<string>();
  return (raw as Record<string, unknown>[]).map((e, i) => {
    const name = e?.['name'];
    const path = e?.['path'];
    const digest = e?.['digest'];
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`skills[${i}]: bad name`);
    if (seen.has(name)) throw new Error(`skills[${i}]: duplicate name ${name}`);
    seen.add(name);
    if (typeof path !== 'string' || !NAME.test(path) || path === '.' || path === '..') throw new Error(`skills[${i}]: bad path`);
    if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new Error(`skills[${i}]: bad digest`);
    const revision = typeof e['revision'] === 'string' ? (e['revision'] as string) : null;
    return {
      name, path, digest, revision,
      id: typeof e['id'] === 'string' ? (e['id'] as string) : name,
      description: typeof e['description'] === 'string' ? (e['description'] as string) : '',
    };
  });
}

/** Copy a package tree (regular files and in-package file symlinks as files), keeping the exec bit. */
function copyPackage(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (isIgnoredName(name)) continue;
    const src = join(from, name);
    const dst = join(to, name);
    const st = statSync(src);
    if (st.isDirectory() && !lstatSync(src).isSymbolicLink()) copyPackage(src, dst);
    else if (st.isFile()) {
      copyFileSync(src, dst);
      chmodSync(dst, st.mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

/** Files 0444 (0555 when executable) and directories 0555, deepest first. */
function freeze(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) freeze(p);
    else chmodSync(p, st.mode & 0o111 ? 0o555 : 0o444);
  }
  chmodSync(dir, 0o555);
}

function thaw(dir: string): void {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (lstatSync(p).isDirectory()) thaw(p);
  }
}

function snapshotRecord(dir: string): string {
  return join(dir, '.snapshot.json');
}

function frontmatterOf(dir: string, fallback: ManifestEntry): Skill {
  const file = join(dir, 'SKILL.md');
  const { meta } = splitFrontmatter(readFileSync(file, 'utf8'));
  const description = typeof meta['description'] === 'string' ? meta['description'].trim() : fallback.description;
  return { name: fallback.name, description, dir, file, id: fallback.id, digest: fallback.digest, revision: fallback.revision };
}

/**
 * The run's skills. Without `managedSkills` (the default) this is `discoverSkills(cfg.skills)` exactly.
 * With it, the persona's generated view `<root>/views/<persona>/zen-agent/manifest.json` is the whole catalog:
 * every package is verified against its full digest and copied into `<snapshots>/<sessionId>.skills/`, made
 * read-only, verified again, and served from there for the rest of the run. A resumed session reuses its snapshot.
 */
export function resolveSkills(cfg: Pick<ZenConfig, 'skills' | 'sessionsDir'> & { managedSkills?: ZenConfig['managedSkills'] }, persona: string | null, sessionId: string, resume?: { managed: boolean; snapshot: string | null; snapshotSession: string } | null): ResolvedSkills {
  const m = cfg.managedSkills ?? null;
  const legacy = (): ResolvedSkills => ({ skills: discoverSkills(cfg.skills), mode: 'legacy', packages: [], rejected: [], snapshot: null, support: null });
  const missing = (reason: string): ResolvedSkills => ({ skills: [], mode: 'managed-missing', packages: [], rejected: reason ? [{ name: '*', reason }] : [], snapshot: null, support: 'catalog-filtered' });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(sessionId)) return m ? missing('invalid session identity') : legacy();
  const snapshotSession = resume?.managed ? resume.snapshotSession : sessionId;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(snapshotSession)) return missing('invalid managed snapshot session identity');
  const snapDir = resume?.managed && resume.snapshot ? resume.snapshot : join(m?.snapshots ?? cfg.sessionsDir, `${snapshotSession}.skills`);
  // Resumed: the snapshot the session started with, unchanged by later syncs.
  let hasSnapshot = false;
  try {
    const st = lstatSync(snapDir);
    if (!st.isDirectory() || st.isSymbolicLink()) return missing('managed snapshot is not a regular directory');
    hasSnapshot = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return missing('managed snapshot cannot be inspected');
  }
  if (hasSnapshot) {
    try {
      const recordStat = lstatSync(snapshotRecord(snapDir));
      if (!recordStat.isFile() || recordStat.isSymbolicLink() || recordStat.size > 1_000_000) throw new Error('snapshot record is not a bounded regular file');
      const rec = JSON.parse(readFileSync(snapshotRecord(snapDir), 'utf8')) as Record<string, unknown>;
      if (rec['format'] !== 'zen-skills-snapshot/1' || rec['persona'] !== persona || rec['sessionId'] !== snapshotSession) throw new Error('snapshot identity does not match this session and persona');
      const entries = manifestEntries(rec['packages']);
      if (!Array.isArray(rec['rejected']) || rec['rejected'].some((r) => !r || typeof r.name !== 'string' || typeof r.reason !== 'string')) throw new Error('invalid snapshot rejection record');
      const skills: Skill[] = [];
      for (const p of entries) {
        const dir = join(snapDir, p.name);
        const d = packageDigest(dir);
        if (!d.ok || d.digest !== p.digest) throw new Error(`snapshot package ${p.name} failed validation`);
        skills.push(frontmatterOf(dir, p));
      }
      return { skills, mode: 'managed', rejected: rec['rejected'] as { name: string; reason: string }[], snapshot: snapDir, support: 'catalog-filtered',
        packages: skills.map((s) => ({ name: s.name, id: s.id!, digest: s.digest!, revision: s.revision ?? null })) };
    } catch (err) { return missing(`managed snapshot is invalid: ${(err as Error).message}`); }
  }

  if (resume?.managed) return missing('original managed snapshot is missing; restore it before resuming this session');
  if (!m) return legacy();
  if (!persona) return m.enforce ? missing('no persona: a managed run needs one') : legacy();
  const view = join(m.root, 'views', persona, 'zen-agent');
  const manifestFile = join(view, 'manifest.json');
  if (!existsSync(manifestFile)) return m.enforce ? missing(`no managed view for ${persona}`) : legacy();

  let entries: ManifestEntry[];
  try {
    entries = readViewManifest(manifestFile, persona).skills;
  } catch (err) {
    return missing(`managed view for ${persona} is invalid: ${(err as Error).message}`);
  }
  const rejected: { name: string; reason: string }[] = [];
  const kept: ManifestEntry[] = [];
  const staging = `${snapDir}.staging-${process.pid}`;
  thaw(staging);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const e of entries) {
    const src = join(view, e.path);
    const d = packageDigest(src);
    if (!d.ok) { rejected.push({ name: e.name, reason: d.error }); continue; }
    if (d.digest !== e.digest) { rejected.push({ name: e.name, reason: `package digest ${d.digest} does not match the manifest ${e.digest}` }); continue; }
    const dst = join(staging, e.name);
    copyPackage(realpathSync(src), dst);
    const again = packageDigest(dst);
    if (!again.ok || again.digest !== e.digest) {
      rejected.push({ name: e.name, reason: 'package changed while it was copied' });
      thaw(dst);
      rmSync(dst, { recursive: true, force: true });
      continue;
    }
    freeze(dst);
    kept.push(e);
  }
  // The record sits beside the packages; it is written before the directory is frozen.
  writeFileSync(snapshotRecord(staging), JSON.stringify({ format: 'zen-skills-snapshot/1', persona, sessionId, packages: kept, rejected }, null, 2));
  chmodSync(snapshotRecord(staging), 0o444);
  chmodSync(staging, 0o555);
  mkdirSync(dirname(snapDir), { recursive: true });
  if (existsSync(snapDir)) {
    // Another launcher may have completed this session while we copied. Never replace its identity.
    thaw(staging); rmSync(staging, { recursive: true, force: true });
    return resolveSkills(cfg, persona, sessionId);
  }
  try { renameSync(staging, snapDir); }
  catch (err) {
    thaw(staging); rmSync(staging, { recursive: true, force: true });
    return missing(`cannot activate the session snapshot: ${(err as Error).message}`);
  }
  const skills = kept.map((e) => frontmatterOf(join(snapDir, e.name), e));
  return {
    skills, mode: 'managed', rejected, snapshot: snapDir, support: 'catalog-filtered',
    packages: kept.map((e) => ({ name: e.name, id: e.id, digest: e.digest, revision: e.revision })),
  };
}
