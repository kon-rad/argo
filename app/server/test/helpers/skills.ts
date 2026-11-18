import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A fake vault with every catalog case: private override, engine link, legacy categories, invalid and escaping packages. */

// Git identity for commits made by the fixture and by `skills apply`.
process.env.GIT_AUTHOR_NAME = 'Fixture';
process.env.GIT_AUTHOR_EMAIL = 'fixture@example.com'; // public-ok: RFC 2606 fixture identity
process.env.GIT_COMMITTER_NAME = 'Fixture';
process.env.GIT_COMMITTER_EMAIL = 'fixture@example.com'; // public-ok: RFC 2606 fixture identity

export function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

export function skillMd(name: string, description: string, extra = '', body = `# ${name}\n\nDo the thing.\n`): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}`;
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export interface SkillsFixture { base: string; vault: string; engine: string; outside: string }

export function skillsFixture(opts: { git?: boolean; base?: string } = {}): SkillsFixture {
  const base = opts.base ?? mkdtempSync(join(tmpdir(), 'sb-skills-'));
  const vault = join(base, 'vault');
  const engine = join(base, 'engine', 'skills');
  const outside = join(base, 'outside');
  const priv = join(vault, '.agents', 'skills');
  // engine
  write(join(engine, 'report', 'SKILL.md'), skillMd('report', 'Engine report skill.'));
  write(join(engine, 'ingest', 'SKILL.md'), skillMd('ingest', 'Ingest one source.'));
  // private: an override of report, a link-skills link to ingest, a skill with a script and a dependency
  write(join(priv, 'report', 'SKILL.md'), skillMd('report', 'Private report skill.'));
  symlinkSync(join('..', '..', '..', 'engine', 'skills', 'ingest'), join(priv, 'ingest'));
  write(join(priv, 'clip', 'SKILL.md'), skillMd('clip', 'Cut a clip.', 'metadata:\n  requires:\n    bins: [definitely-not-a-real-program-xyz]\n    env: [FIXTURE_CLIP_KEY]\n  depends: [report]\n'));
  write(join(priv, 'clip', 'scripts', 'cut.sh'), '#!/bin/sh\necho cut\n', 0o755);
  // invalid metadata
  write(join(priv, 'broken', 'SKILL.md'), '---\nname: broken\n---\n\nNo description.\n');
  write(join(priv, 'bad-yaml', 'SKILL.md'), '---\nname: [unclosed\ndescription: x\n---\nbody\n');
  // escapes and secrets
  write(join(outside, 'secret.txt'), 'outside content\n');
  write(join(outside, 'pkg', 'SKILL.md'), skillMd('pkg', 'Outside package.'));
  write(join(priv, 'leaky', 'SKILL.md'), skillMd('leaky', 'Has an escaping link.'));
  symlinkSync(join(outside, 'secret.txt'), join(priv, 'leaky', 'notes.txt'));
  write(join(priv, 'creds', 'SKILL.md'), skillMd('creds', 'Carries a secret.'));
  write(join(priv, 'creds', '.env'), 'TOKEN=not-read\n');
  symlinkSync(join(outside, 'pkg'), join(priv, 'outside'));
  // legacy categorized tree
  write(join(vault, '.hermes', 'skills', 'media', 'report', 'SKILL.md'), skillMd('report', 'Legacy report skill.'));
  write(join(vault, '.hermes', 'skills', 'media', 'video', 'SKILL.md'), skillMd('video', 'Legacy video skill.'));
  // roster
  write(join(vault, '.agents', 'org', 'org.json'), JSON.stringify({
    agents: {
      owner: { runtime: 'human', role: 'CEO' },
      alpha: { runtime: 'zen-agent', role: 'writer', team: 'media' },
      beta: { runtime: 'claude-code', role: 'engineer', team: 'eng' },
      gamma: { runtime: 'hermes', role: 'ops', team: 'eng' },
    },
    teams: { media: { name: 'Media', lead: 'alpha' }, eng: { name: 'Engineering', lead: 'beta' } },
  }));
  write(join(vault, '.agents', 'org', 'config', 'agents', 'alpha.yaml'), 'role: writer\nknowledge:\n  - .agents/skills/video\n  - Notes/plan.md\n');
  if (opts.git ?? true) {
    sh(engine, 'init', '-q', '-b', 'main');
    sh(engine, 'add', '-A');
    sh(engine, 'commit', '-q', '-m', 'fixture engine');
    sh(vault, 'init', '-q', '-b', 'main');
    sh(vault, 'add', '-A');
    sh(vault, 'commit', '-q', '-m', 'fixture');
  }
  return { base, vault, engine, outside };
}

export const SETTINGS = {
  authorityOrigin: 'https://skills.test',
  policyFile: '.agents/skills-policy.yaml', privateRoot: '.agents/skills', legacyRoot: '.hermes/skills', externalRoots: [],
  draftsDir: '.agents/skill-drafts', changesDir: '.agents/skill-changes', staleAfterHours: 24,
};

export const MANAGED_POLICY = `# fixture policy
version: 1
mode: managed
org:
  grant: [report]
teams:
  media:
    grant: [clip, video]
  eng:
    grant: [ingest]
agents:
  alpha:
    deny: [video]
  gamma:
    grant: [broken]
`;
