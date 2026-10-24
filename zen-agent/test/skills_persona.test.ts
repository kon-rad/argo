import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listPersonas, loadPersona, personaHeader } from '../src/persona.js';
import { discoverSkills, skillBody, skillsIndex, splitFrontmatter } from '../src/skills.js';

function skill(dir: string, name: string, description: string, body = 'Do the thing.') {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`);
}

test('skills: frontmatter, discovery order, body', () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-skills-'));
  const priv = join(root, 'private');
  const shared = join(root, 'shared');
  skill(shared, 'report', 'Shared report skill');
  skill(shared, 'ingest', 'Ingest files');
  skill(priv, 'report', 'Private report skill', 'Private steps.');
  mkdirSync(join(shared, 'not-a-skill'));
  const skills = discoverSkills([priv, shared, join(root, 'missing')]);
  assert.deepEqual(skills.map((s) => [s.name, s.description]), [['report', 'Private report skill'], ['ingest', 'Ingest files']]);
  assert.equal(skillBody(skills[0]!), '# report\n\nPrivate steps.');
  assert.match(skillsIndex(skills), /^- report: Private report skill\n- ingest: Ingest files$/);
  assert.deepEqual(splitFrontmatter('no front').meta, {});
  assert.equal(splitFrontmatter('---\nname: x\n---\nbody').body, 'body');
});

test('personas: roster entry, definition file, playbook; yaml or json', () => {
  const vault = mkdtempSync(join(tmpdir(), 'zen-persona-'));
  const cfgDir = { org: join(vault, 'org.yaml'), definitions: join(vault, 'defs'), memory: join(vault, 'memory') };
  writeFileSync(
    cfgDir.org,
    [
      'version: "1"',
      'agents:',
      '  owner: { runtime: human, role: CEO }',
      '  atlas: { role: engineering lead, team: eng, model: faux/faux-1, expertise: TypeScript, capabilities: [code, review, review] }',
      '  bolt: { role: engineer, team: eng }',
      'teams:',
      '  eng: { name: Engineering, lead: atlas }',
    ].join('\n'),
  );
  mkdirSync(cfgDir.definitions);
  mkdirSync(cfgDir.memory);
  writeFileSync(join(cfgDir.definitions, 'atlas.md'), '---\nname: atlas\n---\nYou plan before you build.\n');
  writeFileSync(join(cfgDir.memory, 'bolt.md'), '# bolt: playbook\n- [m-1 · +1 −0] Run the tests first.\n');

  const atlas = loadPersona({ persona: cfgDir }, 'atlas');
  assert.equal(atlas.role, 'engineering lead');
  assert.equal(atlas.lead, true);
  assert.equal(atlas.reportsTo, null);
  assert.equal(atlas.model, 'faux/faux-1');
  assert.deepEqual(atlas.capabilities, ['code', 'review']);
  assert.equal(atlas.definition, 'You plan before you build.');
  assert.equal(atlas.playbook, null);
  assert.match(personaHeader(atlas), /You are atlas, engineering lead on team Engineering\. You lead the team\./);

  const bolt = loadPersona({ persona: cfgDir }, 'bolt');
  assert.equal(bolt.reportsTo, 'atlas'); // the team lead, when reports_to is not set
  assert.equal(bolt.lead, false);
  assert.match(bolt.playbook!, /Run the tests first/);
  assert.equal(bolt.definition, null);

  assert.throws(() => loadPersona({ persona: cfgDir }, 'owner'), /human/);
  assert.throws(() => loadPersona({ persona: cfgDir }, 'nobody'), /no persona/);
  assert.throws(() => loadPersona({ persona: cfgDir }, 'Bad Name'), /lowercase/);
  assert.deepEqual(listPersonas({ persona: cfgDir }).map((p) => p.name), ['atlas', 'bolt']);

  // A definition file alone is a persona too; JSON rosters work the same.
  writeFileSync(join(cfgDir.definitions, 'solo.md'), 'Solo agent.');
  const solo = loadPersona({ persona: { ...cfgDir, org: join(vault, 'none.json') } }, 'solo');
  assert.equal(solo.role, 'agent');
  assert.equal(solo.definition, 'Solo agent.');
  writeFileSync(join(vault, 'org.json'), JSON.stringify({ agents: { cass: { role: 'writer', runtime: 'hermes' } } }));
  assert.equal(loadPersona({ persona: { ...cfgDir, org: join(vault, 'org.json') } }, 'cass').role, 'writer');
});
