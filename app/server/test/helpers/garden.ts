import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** A throwaway vault from a path → content map. */
export async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sb-garden-'));
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
  return root;
}

/** The same, committed as a git repo so `git mv` and `git status` work. */
export async function gitVault(files: Record<string, string>): Promise<string> {
  const root = await vault(files);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 'test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 'test' } });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  return root;
}
