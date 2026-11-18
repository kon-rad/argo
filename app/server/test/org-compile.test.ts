/**
 * The org compiler (src/org-compile.ts, src/cli-org-compile.ts): the TypeScript port of the
 * vault's `.agents/org/compile.py`. Fixtures use fake names only (the repo is public).
 *
 * Ported from the vault's `.agents/org/test_compile.py`.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentsJson,
  compileOrg,
  legacyRefusal,
  loadOrg,
  orgVersion,
  summaryLine,
  toImportDoc,
  validateOrg,
} from '../src/org-compile.js';
import { cliFor } from '../src/features/registry.js';

const ORG_YAML = [
  'company: Argo',
  'mission_source: nowhere.md#mission',
  'ceo: boss',
  'defaults: {runtime: claude-code, model: sonnet, tools: [Read], knowledge: []}',
  'wake_rules: {dm: true}',
  'order:',
  '  agents: [boss, zed, amy, kit]',
  '  teams: [words, build]',
  'channels:',
  '  all-hands: {members: "*", purpose: notices}',
  '  room: {members: [build, kit]}',
  '',
].join('\n');

const FILES: Record<string, string> = {
  'org.yaml': ORG_YAML,
  'agents/boss.yaml': 'runtime: human\nrole: CEO\nchannels: ["*"]\n',
  'agents/zed.yaml': [
    'team: build',
    'role: Head of Build',
    'reports_to: boss',
    'capabilities: [review]',
    'personality: >',
    '  Calm.',
    'routines:',
    '  - {on: "sun 20:00", do: x}',
    '',
  ].join('\n'),
  'agents/amy.yaml': 'team: build\nrole: Engineer\nreports_to: zed\ncapabilities: [web]\nruntime: hermes\nrepos: [app]\nprojects: [p1]\n',
  'agents/kit.yaml': 'team: words\nrole: Writer\nreports_to: boss\nmodel: haiku\n',
  'teams/words.yaml': 'name: Words\nwork: writing\nlead: kit\nchannels: [words]\n',
  'teams/build.yaml': 'name: Build\nwork: coding\nlead: zed\nchannels: [build]\n',
  'projects/p1.yaml': 'slug: p1\nname: P One\nteam: build\nrepos: [app]\nrisk: high\n',
  'repos/app.yaml': 'url: example\nwork_host: m\n',
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'org-compile-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  }
  return root;
}

/** A vault whose config lives at `<vault>/.agents/org/config`. */
function vault(files: Record<string, string> = FILES): { root: string; cfg: string } {
  const root = writeDir({});
  const cfg = join(root, '.agents', 'org', 'config');
  for (const [rel, text] of Object.entries(files)) {
    const p = join(cfg, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text, 'utf8');
  }
  return { root, cfg };
}

/** loadOrg + validateOrg over a fixture with edits; returns every loader and validation error. */
function errsAfter(edits: Record<string, string | null>, order?: string): string[] {
  const files: Record<string, string> = { ...FILES };
  if (order !== undefined) files['org.yaml'] = order;
  for (const [k, v] of Object.entries(edits)) {
    if (v === null) delete files[k];
    else files[k] = v;
  }
  const { root, cfg } = vault(files);
  const loadErrs: string[] = [];
  const doc = loadOrg(cfg, loadErrs);
  return [...loadErrs, ...validateOrg(doc, root)];
}

describe('org compiler: loader', () => {
  it('assembles the single document in order', () => {
    const { root, cfg } = vault();
    const errs: string[] = [];
    const doc = loadOrg(cfg, errs);
    expect(errs).toEqual([]);
    expect(Object.keys(doc['agents'] as object)).toEqual(['boss', 'zed', 'amy', 'kit']);
    expect(Object.keys(doc['teams'] as object)).toEqual(['words', 'build']);
    expect(Object.keys(doc).slice(0, 8)).toEqual(['company', 'mission_source', 'ceo', 'defaults', 'wake_rules', 'agents', 'teams', 'channels']);
    expect('order' in doc).toBe(false);
    expect(Object.keys(doc['projects'] as object)).toEqual(['p1']);
    expect(Object.keys(doc['repos'] as object)).toEqual(['app']);
    expect(validateOrg(doc, root)).toEqual([]);
  });

  it('keeps the routine `on:` key through the JSON (the YAML 1.1 quirk compile.py documents)', () => {
    const { cfg } = vault();
    const doc = loadOrg(cfg, []);
    expect((agentsJson(doc, 'v')['agents'] as Record<string, { routines: unknown }>)['zed']!.routines).toEqual([{ on: 'sun 20:00', do: 'x' }]);
  });

  it('tracks content: the version changes when a config file does', () => {
    const { cfg } = vault();
    const v1 = orgVersion(cfg);
    expect(orgVersion(cfg)).toBe(v1);
    writeFileSync(join(cfg, 'agents/kit.yaml'), 'team: words\nrole: Editor\nreports_to: boss\n');
    expect(orgVersion(cfg)).not.toBe(v1);
  });

  it('a file missing from order is an error, still loaded so check reports everything', () => {
    const errs = errsAfter({ 'agents/new.yaml': 'team: build\nrole: Engineer\nreports_to: zed\n' });
    expect(errs.some((e) => e.includes('agents/new.yaml is not in org.yaml order.agents'))).toBe(true);
    const { cfg } = vault({ ...FILES, 'agents/new.yaml': 'team: build\nrole: E\nreports_to: zed\n' });
    expect('new' in (loadOrg(cfg, [])['agents'] as object)).toBe(true);
  });

  it('a removed agent still listed in order is an error', () => {
    const errs = errsAfter({ 'agents/amy.yaml': null });
    expect(errs.some((e) => e.includes('order.agents: amy is listed') && e.includes('removed entity still referenced'))).toBe(true);
  });

  it('an `agents:` key in org.yaml is refused', () => {
    const errs = errsAfter({ 'org.yaml': `${ORG_YAML}agents: {}\n` });
    expect(errs.some((e) => e.includes('`agents:` does not belong here'))).toBe(true);
  });

  it('an em-dash anywhere in the config is an error', () => {
    const errs = errsAfter({ 'agents/kit.yaml': 'team: words\nrole: Writer \u2014 words\nreports_to: boss\n' });
    expect(errs).toContain('em-dash in agents/kit.yaml');
  });

  it('a project slug must equal its file name', () => {
    const errs = errsAfter({ 'projects/p1.yaml': 'slug: other\nname: P\n' });
    expect(errs.some((e) => e.includes("projects/p1.yaml: slug 'other'"))).toBe(true);
  });

  it('loadOrg throws when there is no error list', () => {
    const files = { ...FILES };
    delete files['agents/amy.yaml'];
    const { cfg } = vault(files);
    expect(() => loadOrg(cfg)).toThrow();
  });
});

describe('org compiler: dangling references', () => {
  it('the clean fixture has no errors', () => {
    expect(errsAfter({})).toEqual([]);
  });
  it('an agent repo removed', () => {
    expect(errsAfter({ 'repos/app.yaml': null })).toContain("agents/amy.yaml: repo 'app' does not exist (repos/app.yaml is missing: removed entity still referenced?)");
  });
  it('a project repo removed', () => {
    expect(errsAfter({ 'repos/app.yaml': null }).some((e) => e.includes("projects/p1.yaml: repo 'app' does not exist"))).toBe(true);
  });
  it('an agent project removed', () => {
    expect(errsAfter({ 'projects/p1.yaml': null }).some((e) => e.includes("agents/amy.yaml: project 'p1' does not exist"))).toBe(true);
  });
  it('a project team removed', () => {
    expect(errsAfter({ 'projects/p1.yaml': 'slug: p1\nname: P\nteam: gone\n' }).some((e) => e.includes("projects/p1.yaml: team 'gone' does not exist"))).toBe(true);
  });
  it('a team file removed while agents are on it', () => {
    const order = ORG_YAML.replace('[words, build]', '[words]');
    expect(errsAfter({ 'teams/build.yaml': null }, order).some((e) => e.includes('zed: unknown team build (teams/build.yaml is missing'))).toBe(true);
  });
  it('a team lead removed', () => {
    const order = ORG_YAML.replace('[boss, zed, amy, kit]', '[boss, amy, kit]');
    const errs = errsAfter({ 'agents/zed.yaml': null, 'agents/amy.yaml': 'team: build\nrole: E\nreports_to: boss\n' }, order);
    expect(errs.some((e) => e.includes('team build: lead zed does not exist'))).toBe(true);
  });
  it('a channel member removed', () => {
    const order = ORG_YAML.replace('[boss, zed, amy, kit]', '[boss, zed, amy]').replace('[words, build]', '[build]');
    expect(errsAfter({ 'agents/kit.yaml': null, 'teams/words.yaml': null }, order).some((e) => e.includes('channel room: unknown member kit'))).toBe(true);
  });
  it('a bad risk class', () => {
    expect(errsAfter({ 'projects/p1.yaml': 'slug: p1\nname: P\nrisk: spicy\n' }).some((e) => e.includes("risk 'spicy'"))).toBe(true);
  });
});

describe('org compiler: roster validation (in memory)', () => {
  function base(): { doc: Record<string, any>; root: string } {
    const { root, cfg } = vault();
    return { doc: loadOrg(cfg, []), root };
  }

  it('rejects a reserved name and an unknown runtime', () => {
    const { doc, root } = base();
    doc['agents']['builder'] = { runtime: 'claude-code', team: 'build', role: 'X', reports_to: 'zed' };
    doc['agents']['zed']['runtime'] = 'gpt';
    const errs = validateOrg(doc, root);
    expect(errs).toContain('builder: collides with a Claude lane or Hermes profile');
    expect(errs).toContain('zed: unknown runtime gpt');
  });

  it('rejects a bad routing mode and routed-on-a-merge-holder', () => {
    const { doc, root } = base();
    doc['agents']['amy']['routing'] = 'sometimes';
    doc['agents']['zed']['capabilities'] = ['review', 'merge'];
    doc['agents']['zed']['routing'] = 'routed';
    const errs = validateOrg(doc, root);
    expect(errs.some((e) => e.includes("amy: routing 'sometimes'"))).toBe(true);
    expect(errs.some((e) => e.includes('zed: routing routed on a merge or deploy holder'))).toBe(true);
  });

  it('rejects an unknown capability, a Hermes code holder and a second single-holder', () => {
    const { doc, root } = base();
    doc['agents']['amy']['capabilities'] = ['code'];
    doc['agents']['zed']['capabilities'] = ['review', 'dispatch'];
    doc['agents']['kit']['capabilities'] = ['dispatch'];
    const errs = validateOrg(doc, root);
    expect(errs).toContain("amy: a Hermes bot can't hold code");
    expect(errs).toContain('capability dispatch is held by zed, kit; one bot only');
  });

  it('rejects a CURRENT/ knowledge path and a missing reports_to', () => {
    const { doc, root } = base();
    doc['agents']['zed']['knowledge'] = ['CURRENT/todo-master.md'];
    delete doc['agents']['kit']['reports_to'];
    const errs = validateOrg(doc, root);
    expect(errs).toContain('zed: CURRENT/ in knowledge');
    expect(errs).toContain('kit: missing reports_to');
  });

  it('summarises the roster', () => {
    const { doc } = base();
    expect(summaryLine(doc)).toContain('agents=3 (+1 human) teams=2 shared_channels=2 projects=1 repos=1');
  });
});

describe('org compiler: routing mode and import document', () => {
  it('writes fixed for leads and merge/deploy holders, routed for the rest', () => {
    const { cfg } = vault();
    const doc = loadOrg(cfg, []);
    const got = Object.fromEntries(
      Object.entries(agentsJson(doc, 'v')['agents'] as Record<string, { routing: string }>).map(([n, a]) => [n, a.routing]),
    );
    expect(got).toEqual({ zed: 'fixed', amy: 'routed', kit: 'fixed' });
  });

  it('builds the import document in the shape cli-org plan|apply read', () => {
    const { cfg } = vault();
    const doc = loadOrg(cfg, []);
    const out = toImportDoc(doc, 'v9');
    expect(out['version']).toBe('v9');
    expect(out['ceo']).toBe('boss');
    const agents = out['agents'] as Record<string, Record<string, unknown>>;
    expect(agents['boss']).toEqual({ runtime: 'human', role: 'CEO', channels: ['*'] });
    expect(agents['amy']!['runtime']).toBe('hermes');
    expect(agents['amy']!['model']).toBe('sonnet'); // falls back to defaults.model
    expect(agents['kit']!['model']).toBe('haiku');
    expect((out['teams'] as Record<string, unknown>)['words']).toEqual({ name: 'Words', lead: 'kit', channels: ['words'] });
    expect(((out['channels'] as Record<string, Record<string, unknown>>)['all-hands'])!['members']).toBe('*');
  });
});

describe('org compiler: compile writes the outputs', () => {
  it('writes org.json, org-agents.json and one prompt per claude-code/hermes bot, idempotently', () => {
    const { root } = vault();
    const first = compileOrg(root);
    expect(first.errors).toEqual([]);
    expect(existsSync(join(root, '.agents', 'org', 'org.json'))).toBe(true);
    expect(existsSync(join(root, '.agents', 'org', 'org-agents.json'))).toBe(true);
    for (const n of ['zed', 'amy', 'kit']) expect(existsSync(join(root, '.claude', 'agents', `${n}.md`))).toBe(true);
    expect(existsSync(join(root, '.claude', 'agents', 'boss.md'))).toBe(false); // human: no prompt
    const org = JSON.parse(readFileSync(join(root, '.agents', 'org', 'org.json'), 'utf8'));
    expect(Object.keys(org.agents)).toEqual(['boss', 'zed', 'amy', 'kit']);
    expect(org.version).toBe(first.version);
    // A second run changes nothing: writeIfChanged makes it idempotent.
    expect(compileOrg(root).changed).toEqual([]);
  });

  it('--check validates and writes nothing', () => {
    const { root } = vault();
    const r = compileOrg(root, { check: true });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual([]);
    expect(existsSync(join(root, '.agents', 'org', 'org.json'))).toBe(false);
  });

  it('reports errors and writes nothing when the config is broken', () => {
    const files = { ...FILES };
    delete files['repos/app.yaml'];
    const { root } = vault(files);
    const r = compileOrg(root);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.changed).toEqual([]);
    expect(existsSync(join(root, '.agents', 'org', 'org.json'))).toBe(false);
  });

  it('refuses while the legacy single org.yaml exists', () => {
    const { root } = vault();
    writeFileSync(join(root, '.agents', 'org.yaml'), 'agents: {}\n');
    expect(legacyRefusal(root)).toBeTruthy();
    expect(() => compileOrg(root)).toThrow(/legacy org file/);
  });
});

describe('org compiler: CLI wiring', () => {
  it('registers the org-compile command in the engine manifest', () => {
    const found = cliFor('org-compile');
    expect(found?.feature?.name).toBe('org');
    expect(found?.cli.entry).toBe('cli-org-compile.js');
  });
});
