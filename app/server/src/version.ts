import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What this build is: the package version, and the commit where we can see one. */
export interface BuildInfo {
  version: string;
  /** Full commit, or null when neither a build file nor git can say. */
  commit: string | null;
  commitShort: string | null;
  /** ISO time the deploy built this copy, null on a laptop. */
  builtAt: string | null;
}

const UNKNOWN_VERSION = '0.0.0';

function readVersion(appRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/**
 * What `deploy.sh` wrote when it built this copy. A deployed app has no `.git`
 * (the deploy ships source with rsync and excludes it), so the commit has to
 * arrive with the build.
 */
function readBuildFile(appRoot: string): Partial<BuildInfo> {
  try {
    const raw = JSON.parse(readFileSync(join(appRoot, 'data', 'build-info.json'), 'utf8')) as Partial<BuildInfo>;
    return {
      version: typeof raw.version === 'string' && raw.version ? raw.version : undefined,
      commit: typeof raw.commit === 'string' && raw.commit ? raw.commit : undefined,
      builtAt: typeof raw.builtAt === 'string' && raw.builtAt ? raw.builtAt : undefined,
    };
  } catch {
    return {};
  }
}

function fromGit(appRoot: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', ['-C', appRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return out || null;
  } catch {
    return null; // no git, not a checkout, or it took too long: the app still runs
  }
}

/**
 * The version and commit the app shows in its info panel. A deploy wins over
 * git: it is the copy that is actually serving. On a laptop there is no build
 * file, so the checkout answers instead.
 */
export function readBuildInfo(appRoot: string): BuildInfo {
  const file = readBuildFile(appRoot);
  const commit = file.commit ?? fromGit(appRoot, ['rev-parse', 'HEAD']);
  return {
    version: file.version ?? readVersion(appRoot),
    commit: commit ?? null,
    commitShort: commit ? commit.slice(0, 7) : null,
    builtAt: file.builtAt ?? null,
  };
}
