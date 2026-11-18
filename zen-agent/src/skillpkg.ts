import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Package digest v1: the full content identity of one skill package (SKILL.md plus every script,
 * reference and asset). The engine's skills manager computes the same bytes (app/server/src/addons/skills),
 * so a digest recorded in a run trace can be compared with the library and a machine's acknowledgement.
 *
 * Over the files sorted by relative POSIX path, sha256 of `${rel}\0${x|-}\0${size}\0${sha256hex(content)}\n`.
 * Ignored: `.git`, `.DS_Store`, `__pycache__`, `node_modules`, `*.pyc`. A secret-like file, a symlink that
 * leaves the package, a directory symlink, a special file or a package over the limits makes it invalid;
 * secret-like files are never read.
 */
export const LIMITS = { files: 1000, fileBytes: 10 * 1024 * 1024, totalBytes: 50 * 1024 * 1024, depth: 12 };

export interface PackageFile {
  path: string;
  size: number;
  exec: boolean;
  sha256: string;
}
export type PackageResult = { ok: true; digest: string; files: PackageFile[] } | { ok: false; error: string };

const IGNORED = new Set(['.git', '.DS_Store', '__pycache__', 'node_modules']);

export function isIgnoredName(name: string): boolean {
  return IGNORED.has(name) || name.endsWith('.pyc');
}

export function isSecretName(name: string): boolean {
  const n = name.toLowerCase();
  if (n === '.env.example') return false;
  return (
    n === '.env' || n.startsWith('.env.') || n.endsWith('.pem') || n.endsWith('.key') || n.startsWith('id_rsa') ||
    n.startsWith('id_ed25519') || n === 'credentials.json' || n.endsWith('.p12') || n === '.npmrc' || n === '.netrc'
  );
}

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

class Invalid extends Error {}

export function packageDigest(dir: string): PackageResult {
  let root: string;
  try {
    root = realpathSync(dir);
    if (!statSync(root).isDirectory()) return { ok: false, error: 'package is not a directory' };
  } catch (err) {
    return { ok: false, error: `package unreadable: ${(err as Error).message}` };
  }
  const found: { rel: string; abs: string }[] = [];
  const walk = (abs: string, depth: number): void => {
    if (depth > LIMITS.depth) throw new Invalid(`package deeper than ${LIMITS.depth} levels`);
    for (const name of readdirSync(abs).sort()) {
      if (isIgnoredName(name)) continue;
      const path = join(abs, name);
      const rel = relative(root, path).split(sep).join('/');
      if (isSecretName(name)) throw new Invalid(`secret-like file not allowed in a package: ${rel}`);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(path);
        } catch {
          throw new Invalid(`dangling symlink: ${rel}`);
        }
        if (!inside(root, target)) throw new Invalid(`symlink escapes package: ${rel}`);
        const tst = statSync(target);
        if (tst.isDirectory()) throw new Invalid(`directory symlink not supported: ${rel}`);
        if (!tst.isFile()) throw new Invalid(`not a regular file: ${rel}`);
        found.push({ rel, abs: path });
      } else if (st.isDirectory()) {
        walk(path, depth + 1);
      } else if (st.isFile()) {
        found.push({ rel, abs: path });
      } else {
        throw new Invalid(`not a regular file: ${rel}`);
      }
      if (found.length > LIMITS.files) throw new Invalid(`more than ${LIMITS.files} files`);
    }
  };
  try {
    walk(root, 0);
    found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const acc = createHash('sha256');
    const files: PackageFile[] = [];
    let total = 0;
    for (const f of found) {
      const st = statSync(f.abs);
      if (st.size > LIMITS.fileBytes) throw new Invalid(`file over ${LIMITS.fileBytes} bytes: ${f.rel}`);
      total += st.size;
      if (total > LIMITS.totalBytes) throw new Invalid(`package over ${LIMITS.totalBytes} bytes`);
      const body = readFileSync(f.abs);
      const sha256 = createHash('sha256').update(body).digest('hex');
      const exec = (st.mode & 0o111) !== 0;
      acc.update(`${f.rel}\0${exec ? 'x' : '-'}\0${body.length}\0${sha256}\n`);
      files.push({ path: f.rel, size: body.length, exec, sha256 });
    }
    if (!files.some((f) => f.path === 'SKILL.md')) return { ok: false, error: 'package has no SKILL.md' };
    return { ok: true, digest: `sha256:${acc.digest('hex')}`, files };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    return { ok: false, error: `package unreadable: ${(err as Error).message}` };
  }
}
