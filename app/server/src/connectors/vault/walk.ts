import { readdir, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';

export interface WalkEntry {
  path: string;        // vault-relative, POSIX separators
  parentPath: string;  // '' at the root
  name: string;
  ext: string;         // lowercased, includes the dot; '' when there is none
  sizeBytes: number;
  mtimeMs: number;
}

export interface SkippedDir {
  path: string;
  rule: string;
}

export interface WalkResult {
  files: WalkEntry[];
  skippedDirs: SkippedDir[];
}

/**
 * Two rule shapes, distinguished by a leading slash:
 *
 * - `node_modules` matches that directory NAME at any depth. Two checked-out
 *   repos inside Areas/ hold 110k of this vault's 122k files, and none of
 *   their node_modules sit at a path we could have listed up front.
 * - `/app` matches only that path from the vault root. The app's own source
 *   tree has to be excluded, but `app` as a name rule also silently swallowed
 *   `Areas/school/video-editor/app` — a real project folder. A rule
 *   that hides notes without saying so is worse than no rule.
 */
export const DEFAULT_SKIP_DIRS: readonly string[] = [
  '/app', 'node_modules', '.git', '.venv', 'venv', '.obsidian',
  '.parked-agent', '__pycache__', '.next', 'dist', 'build', '.cache',
];

const SKIP_FILES = new Set(['.DS_Store']);

/**
 * Credentials never enter the index, and therefore can never be served by
 * /api/raw — the index is that endpoint's allowlist. This list is deliberately
 * NOT part of `skipDirs`: a filter a caller can replace is a filter that will
 * one day be replaced, and this vault's .env holds thirteen live API keys.
 *
 * `.env.example` goes too. Telling a real .env from a safe sample means
 * reading it, and the payoff for getting that right is one uninteresting file.
 */
const SECRET_FILE_RE =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pgpass|id_rsa|id_ecdsa|id_ed25519|.*\.(?:pem|key|p12|pfx|keystore|jks))$/i;

export function isSecretFile(name: string): boolean {
  return SECRET_FILE_RE.test(name);
}

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'));

export async function walkVault(
  root: string,
  opts: { skipDirs?: readonly string[] } = {},
): Promise<WalkResult> {
  const rules = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const skipNames = new Set(rules.filter((r) => !r.startsWith('/')));
  const skipPaths = new Set(rules.filter((r) => r.startsWith('/')).map((r) => r.slice(1)));
  const files: WalkEntry[] = [];
  const skippedDirs: SkippedDir[] = [];

  async function descend(absDir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      // A directory that vanished or is unreadable is not worth failing a scan for.
      return;
    }

    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

      // Symlinks are never followed: a link back up the tree turns the walk
      // into an infinite loop, and a link outside the vault indexes files the
      // path guard would later refuse to serve.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        const rule = skipNames.has(entry.name)
          ? `dirname:${entry.name}`
          : skipPaths.has(rel)
            ? `path:/${rel}`
            : null;
        if (rule !== null) {
          // Deliberately not counting what is inside: counting means walking it,
          // which is the entire thing being avoided.
          skippedDirs.push({ path: rel, rule });
          continue;
        }
        await descend(join(absDir, entry.name), rel);
        continue;
      }

      if (!entry.isFile() || SKIP_FILES.has(entry.name) || isSecretFile(entry.name)) continue;

      let stat_;
      try {
        stat_ = await stat(join(absDir, entry.name));
      } catch {
        continue;
      }

      files.push({
        path: toPosix(rel),
        parentPath: toPosix(relDir),
        name: entry.name,
        ext: extname(entry.name).toLowerCase(),
        sizeBytes: stat_.size,
        mtimeMs: stat_.mtimeMs,
      });
    }
  }

  await descend(root, '');
  return { files, skippedDirs };
}
