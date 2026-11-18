import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { RootInfo, SkillCandidate, SkillSource } from '@secondbrain/contracts/skills';
import { lastRevision, pathState, rootGit, toPosix, type RootGit } from './git.js';
import { NAME_RE, readMeta, scanPackage, type PackageFile } from './package.js';

/**
 * The catalog: every package in the configured roots, read from the filesystem (no index). Roots are
 * explicit: the vault's private `.agents/skills`, the legacy categorized `.hermes/skills`, the engine's
 * `skills/` and any external roots the vault lists. Home directories and plugin caches are never crawled.
 *
 * All candidates are kept. The effective one per name follows the runtimes' existing precedence
 * (private, then engine, then legacy, then external roots in listed order); the rest are shown as
 * shadowed, so a private override and the package it replaces are visible together.
 */

export interface RootSpec {
  id: string;
  source: SkillSource;
  /** Shown to the owner instead of an absolute path. */
  label: string;
  path: string;
  /** `categorized`: `<root>/<category>/<name>/SKILL.md` (plus flat entries). */
  layout: 'flat' | 'categorized';
}

export interface Candidate extends SkillCandidate {
  /** Absolute package folder (real path). Server-side only; never sent to a client. */
  dir: string;
  packageFiles: PackageFile[];
  rootId: string;
  gitTop: string | null;
  gitRel: string | null;
}

export interface Catalog {
  roots: RootInfo[];
  candidates: Candidate[];
  /** name -> candidates, effective first. */
  byName: Map<string, Candidate[]>;
  generatedAt: string;
}

export const MAX_PACKAGES_PER_ROOT = 2000;
const PRECEDENCE: Record<SkillSource, number> = { private: 0, engine: 1, legacy: 2, external: 3 };

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

interface Found { folder: string; category: string | null; entry: string }

function listPackages(spec: RootSpec): { found: Found[]; error: string | null } {
  const found: Found[] = [];
  let names: string[];
  try { names = readdirSync(spec.path).sort(); } catch (err) { return { found, error: `unreadable: ${(err as NodeJS.ErrnoException).code ?? 'error'}` }; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const entry = join(spec.path, name);
    let isDir = false;
    try { isDir = statSync(entry).isDirectory(); } catch { isDir = lstatSync(entry).isSymbolicLink(); /* dangling link: report it */ }
    if (!isDir) continue;
    if (existsSync(join(entry, 'SKILL.md')) || spec.layout === 'flat') {
      if (spec.layout === 'flat' && !existsSync(join(entry, 'SKILL.md')) && !lstatSync(entry).isSymbolicLink()) continue;
      found.push({ folder: name, category: null, entry });
    } else {
      let inner: string[] = [];
      try { inner = readdirSync(entry).sort(); } catch { continue; }
      for (const sub of inner) {
        if (sub.startsWith('.')) continue;
        const p = join(entry, sub);
        try { if (!statSync(p).isDirectory() || !existsSync(join(p, 'SKILL.md'))) continue; } catch { continue; }
        found.push({ folder: sub, category: name, entry: p });
      }
    }
    if (found.length > MAX_PACKAGES_PER_ROOT) return { found: found.slice(0, MAX_PACKAGES_PER_ROOT), error: `more than ${MAX_PACKAGES_PER_ROOT} packages; the rest are not listed` };
  }
  return { found, error: null };
}

function candidateId(spec: RootSpec, f: Found): string {
  const leaf = f.category ? `${f.category}/${f.folder}` : f.folder;
  return spec.source === 'external' ? `${spec.id}:${leaf}` : `${spec.source}:${leaf}`;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); }
  }));
  return out;
}

export async function buildCatalog(specs: RootSpec[], opts: { git?: boolean } = {}): Promise<Catalog> {
  const useGit = opts.git ?? true;
  const realRoots = specs.map((s) => { try { return realpathSync(s.path); } catch { return null; } });
  const gits = new Map<string, RootGit | null>();
  const roots: RootInfo[] = [];
  const candidates: Candidate[] = [];

  for (const [i, spec] of specs.entries()) {
    const real = realRoots[i];
    if (!real) { roots.push({ id: spec.id, source: spec.source, label: spec.label, exists: false, packages: 0, revision: null, git: false, error: null }); continue; }
    const g = useGit ? await rootGit(real) : null;
    gits.set(real, g);
    const { found, error } = listPackages({ ...spec, path: real });
    roots.push({ id: spec.id, source: spec.source, label: spec.label, exists: true, packages: found.length, revision: g?.head ?? null, git: !!g, error });
    for (const f of found) {
      const id = candidateId(spec, f);
      const errors: string[] = [];
      const warnings: string[] = [];
      let dir = f.entry;
      let linkTarget: string | null = null;
      try {
        const realDir = realpathSync(f.entry);
        if (realDir !== join(real, relative(real, f.entry))) {
          // The package folder itself is a link (a `link-skills` link into the engine, say): it must land in a configured root.
          if (!realRoots.some((r) => r && inside(r, realDir))) errors.push('package link points outside the configured skill roots');
          else linkTarget = realDir;
        }
        dir = realDir;
      } catch {
        errors.push('dangling link');
      }
      let meta = readMeta('', f.folder);
      let scan: ReturnType<typeof scanPackage> | null = null;
      if (!errors.length) {
        const md = join(dir, 'SKILL.md');
        try {
          if (lstatSync(md).isSymbolicLink() && !inside(dir, realpathSync(md))) errors.push('SKILL.md is a symlink out of the package');
          else meta = readMeta(readFileSync(md, 'utf8').slice(0, 256 * 1024), f.folder);
        } catch { errors.push('SKILL.md unreadable'); }
        scan = scanPackage(dir);
        if (!scan.ok) errors.push(scan.error);
      }
      errors.push(...meta.errors);
      warnings.push(...meta.warnings);
      const name = meta.name && NAME_RE.test(meta.name) ? meta.name : f.folder.toLowerCase();
      candidates.push({
        id, name, source: spec.source, root: spec.label, relPath: f.category ? `${f.category}/${f.folder}` : f.folder, category: f.category,
        description: meta.description, valid: errors.length === 0, errors, warnings,
        digest: scan?.ok ? scan.digest : null, files: scan?.ok ? scan.files.length : 0, bytes: scan?.ok ? scan.bytes : 0,
        revision: null, dirty: null, tracked: null, linkOf: linkTarget, effective: false, shadowedBy: null,
        metadata: { version: meta.version, owner: meta.owner, license: meta.license, depends: meta.depends, requires: meta.requires },
        dir, packageFiles: scan?.ok ? scan.files : [], rootId: spec.id, gitTop: null, gitRel: null,
      });
    }
  }

  // Links: name the candidate whose real folder the link lands on, or keep a vault-relative hint.
  for (const c of candidates) {
    if (!c.linkOf) continue;
    const target = candidates.find((o) => o !== c && o.dir === c.linkOf && !o.linkOf);
    c.linkOf = target ? target.id : 'outside-catalog';
  }

  // Git provenance from the repository that actually holds the files (a link's target, for a link).
  await pool(candidates, 8, async (c) => {
    if (!useGit || !c.valid && !c.digest) return;
    const realRoot = [...gits.keys()].filter((r) => inside(r, c.dir)).sort((a, b) => b.length - a.length)[0];
    const g = realRoot ? gits.get(realRoot) : null;
    if (!g) return;
    const st = pathState(g, c.dir);
    c.gitTop = g.top;
    c.gitRel = st.rel;
    c.tracked = st.tracked;
    c.dirty = st.dirty;
    c.revision = st.tracked ? await lastRevision(g.top, st.rel) : null;
  });

  const order = new Map(specs.map((s, i) => [s.id, i]));
  const byName = new Map<string, Candidate[]>();
  for (const c of candidates) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  for (const [, list] of byName) {
    list.sort((a, b) => PRECEDENCE[a.source] - PRECEDENCE[b.source] || (order.get(a.rootId)! - order.get(b.rootId)!) || (a.id < b.id ? -1 : 1));
    const top = list[0]!;
    top.effective = true;
    for (const other of list.slice(1)) other.shadowedBy = top.id;
  }
  return { roots, candidates, byName, generatedAt: new Date().toISOString() };
}

/** Distinct packages among a name's candidates: a link and its target are one package. */
export function distinctPackages(list: Candidate[]): number {
  return new Set(list.map((c) => c.dir)).size;
}

export function publicCandidate(c: Candidate): SkillCandidate {
  const { dir: _d, packageFiles: _f, rootId: _r, gitTop: _t, gitRel: _g, ...rest } = c;
  return rest;
}

export function rootSpecs(vaultRoot: string, engineSkills: string | null, s: { privateRoot: string; legacyRoot: string | null; externalRoots: { id: string; path: string; label?: string }[] }, resolvePath: (p: string) => string): RootSpec[] {
  const specs: RootSpec[] = [{ id: 'private', source: 'private', label: toPosix(s.privateRoot), path: resolvePath(s.privateRoot), layout: 'flat' }];
  if (engineSkills) specs.push({ id: 'engine', source: 'engine', label: 'engine skills/', path: engineSkills, layout: 'flat' });
  if (s.legacyRoot) specs.push({ id: 'legacy', source: 'legacy', label: toPosix(s.legacyRoot), path: resolvePath(s.legacyRoot), layout: 'categorized' });
  for (const r of s.externalRoots) specs.push({ id: `external:${r.id}`, source: 'external', label: r.label ?? `external ${r.id}`, path: resolvePath(r.path), layout: 'flat' });
  void vaultRoot;
  return specs;
}
