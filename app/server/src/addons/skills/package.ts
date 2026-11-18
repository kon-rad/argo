import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import yaml from 'js-yaml';

/**
 * One skill package: a folder with SKILL.md plus anything it ships (scripts, references, assets).
 * The digest covers every file, so a changed script changes the package identity, not only the
 * instructions. zen-agent/src/skillpkg.ts implements the same algorithm (a shared test vector in both
 * suites keeps them equal); docs/skills.md states it.
 *
 * Digest v1: files sorted by package-relative POSIX path; sha256 over, per file,
 * `${path}\0${exec ? 'x' : '-'}\0${size}\0${sha256hex(content)}\n`; written `sha256:<hex>`.
 */

export const LIMITS = { files: 1000, fileBytes: 10 * 1024 * 1024, totalBytes: 50 * 1024 * 1024, depth: 12, pathLength: 255 } as const;

/** Never part of a package: VCS metadata, OS litter, caches, installed dependencies. */
const IGNORED = new Set(['.git', '.DS_Store', '__pycache__', 'node_modules']);
const IGNORED_SUFFIX = ['.pyc'];

export function isIgnoredName(name: string): boolean {
  return IGNORED.has(name) || IGNORED_SUFFIX.some((s) => name.endsWith(s));
}

/** Files a package must not carry. The catalog refuses the package without reading them. */
export function isSecretLike(name: string): boolean {
  const n = name.toLowerCase();
  if (n === '.env.example' || n === '.env.sample') return false;
  return n === '.env' || n.startsWith('.env.') || n.endsWith('.pem') || n.endsWith('.key') || n.endsWith('.p12') || n.endsWith('.pfx')
    || n.startsWith('id_rsa') || n.startsWith('id_ed25519') || n.startsWith('id_ecdsa') || n === 'credentials.json'
    || n === 'auth.json' || n === '.credentials.json' || n === '.npmrc' || n === '.netrc' || n === '.pypirc';
}

export interface PackageFile { path: string; size: number; exec: boolean; sha256: string; abs: string }
export type PackageScan = { ok: true; digest: string; files: PackageFile[]; bytes: number } | { ok: false; error: string };

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export function digestOf(files: Pick<PackageFile, 'path' | 'size' | 'exec' | 'sha256'>[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path}\0${f.exec ? 'x' : '-'}\0${f.size}\0${f.sha256}\n`);
  }
  return `sha256:${h.digest('hex')}`;
}

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Check resolved targets too: an innocent alias must not import ignored files or credentials. */
export function packageFileAllowed(root: string, path: string): boolean {
  return path !== root && inside(root, path)
    && !relative(root, path).split(sep).some((part) => isSecretLike(part) || isIgnoredName(part));
}

/**
 * Walk and hash a package. Rejects (never follows out of the package) symlinks that resolve outside it,
 * directory symlinks, special files and secret-like files; bounded by LIMITS.
 */
export function scanPackage(dir: string, opts: { rejectIgnored?: boolean } = {}): PackageScan {
  let root: string;
  try {
    root = realpathSync(dir);
    if (!statSync(root).isDirectory()) return { ok: false, error: 'not a directory' };
  } catch (err) {
    return { ok: false, error: `unreadable: ${(err as NodeJS.ErrnoException).code ?? 'error'}` };
  }
  const files: PackageFile[] = [];
  let bytes = 0;
  const walk = (abs: string, depth: number): string | null => {
    if (depth > LIMITS.depth) return `deeper than ${LIMITS.depth} levels`;
    let entries: string[];
    try { entries = readdirSync(abs).sort(); } catch { return `unreadable folder ${relative(root, abs) || '.'}`; }
    for (const name of entries) {
      if (isIgnoredName(name)) {
        if (opts.rejectIgnored) return `ignored package member ${relative(root, join(abs, name))}`;
        continue;
      }
      const p = join(abs, name);
      const rel = relative(root, p).split(sep).join('/');
      if (rel.length > LIMITS.pathLength) return `path too long: ${rel.slice(0, 60)}...`;
      if (isSecretLike(name)) return `secret-like file ${rel} (packages must not carry credentials)`;
      let st = lstatSync(p);
      let real = p;
      if (st.isSymbolicLink()) {
        try { real = realpathSync(p); } catch { return `dangling symlink ${rel}`; }
        if (!inside(root, real)) return `symlink escapes package: ${rel}`;
        if (!packageFileAllowed(root, real)) return `symlink targets a credential or ignored path: ${rel}`;
        st = statSync(real);
        if (st.isDirectory()) return `directory symlink not supported: ${rel}`;
      }
      if (st.isDirectory()) {
        const err = walk(p, depth + 1);
        if (err) return err;
        continue;
      }
      if (!st.isFile()) return `not a regular file: ${rel}`;
      if (st.size > LIMITS.fileBytes) return `file over ${LIMITS.fileBytes} bytes: ${rel}`;
      bytes += st.size;
      if (bytes > LIMITS.totalBytes) return `package over ${LIMITS.totalBytes} bytes`;
      if (files.length >= LIMITS.files) return `more than ${LIMITS.files} files`;
      const content = readFileSync(real);
      files.push({ path: rel, size: content.length, exec: (st.mode & 0o111) !== 0, sha256: sha256(content), abs: real });
    }
    return null;
  };
  const err = walk(root, 0);
  if (err) return { ok: false, error: err };
  if (!files.some((f) => f.path === 'SKILL.md')) return { ok: false, error: 'package has no SKILL.md' };
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, digest: digestOf(files), files, bytes };
}

// ---- SKILL.md metadata ----

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
export interface Frontmatter { meta: Record<string, unknown>; body: string; error: string | null }

export function splitFrontmatter(text: string): Frontmatter {
  const m = FRONT.exec(text);
  if (!m) return { meta: {}, body: text, error: 'no YAML frontmatter' };
  try {
    const meta = yaml.safeLoad(m[1]!);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { meta: {}, body: text.slice(m[0].length), error: 'frontmatter is not a mapping' };
    return { meta: meta as Record<string, unknown>, body: text.slice(m[0].length), error: null };
  } catch (err) {
    return { meta: {}, body: text.slice(m[0].length), error: `frontmatter YAML: ${(err as Error).message.split('\n')[0]}` };
  }
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

export interface SkillMeta {
  name: string | null;
  description: string;
  version: string | null; owner: string | null; license: string | null;
  depends: string[]; requires: { bins: string[]; env: string[] };
  errors: string[]; warnings: string[];
}

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Agent Skills frontmatter (`name`, `description`) plus optional management metadata under `metadata:`
 * (`version`, `owner`, `depends`, `requires: { bins, env }`), which keeps the package valid for any
 * other Agent Skills client.
 */
export function readMeta(skillMd: string, folder: string): SkillMeta {
  const fm = splitFrontmatter(skillMd);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (fm.error) errors.push(fm.error);
  const m = fm.meta;
  const name = str(m['name']);
  if (!name) errors.push('frontmatter has no name');
  else if (!NAME_RE.test(name)) errors.push(`name "${name}" must be lowercase letters, digits, dot, dash or underscore`);
  else if (name !== folder) warnings.push(`name "${name}" differs from its folder "${folder}"`);
  const description = str(m['description']) ?? '';
  if (!description) errors.push('frontmatter has no description');
  else if (description.length > 1024) warnings.push('description is longer than 1024 characters');
  const md = m['metadata'] && typeof m['metadata'] === 'object' && !Array.isArray(m['metadata']) ? (m['metadata'] as Record<string, unknown>) : {};
  const req = md['requires'] && typeof md['requires'] === 'object' ? (md['requires'] as Record<string, unknown>) : {};
  const env = strList(req['env']);
  for (const e of env) if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(e)) errors.push(`metadata.requires.env: "${e}" is not an environment variable name`);
  const bins = strList(req['bins']);
  for (const b of bins) if (!/^[A-Za-z0-9._+-]{1,64}$/.test(b)) errors.push(`metadata.requires.bins: "${b}" is not a program name`);
  const depends = strList(md['depends']);
  for (const d of depends) if (!NAME_RE.test(d)) errors.push(`metadata.depends: "${d}" is not a skill name`);
  return {
    name, description, version: str(md['version'] ?? m['version']), owner: str(md['owner']), license: str(m['license']),
    depends, requires: { bins, env: env.filter((e) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(e)) }, errors, warnings,
  };
}

/** Text or binary, by a NUL byte in the first 8 KB or invalid UTF-8. */
export function isText(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(head.length < buf.length ? buf.subarray(0, Math.max(0, head.length - 4)) : head); return true; } catch { return false; }
}
