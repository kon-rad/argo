import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assemble, buildSystemPrompt, clip, estimateTokens } from '../src/context.js';
import type { Persona } from '../src/persona.js';

test('clip respects the token cap and marks the cut', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} of the rules`).join('\n');
  const c = clip(text, 50);
  assert.ok(c.truncated);
  assert.ok(estimateTokens(c.text) <= 60);
  assert.match(c.text, /truncated at 50 tokens/);
  assert.deepEqual(clip('short', 50), { text: 'short', truncated: false });
  assert.deepEqual(clip(text, 0), { text, truncated: false });
});

test('assemble records a stat per non-empty part and wraps parts in tags', () => {
  const a = assemble([
    { name: 'identity', text: 'You are x.', cap: 0 },
    { name: 'rules', text: 'Be brief.', cap: 100 },
    { name: 'playbook', text: '', cap: 100 },
  ]);
  assert.deepEqual(a.parts.map((p) => p.name), ['identity', 'rules']);
  assert.match(a.prompt, /^You are x\.\n\n<rules>\nBe brief\.\n<\/rules>$/);
  assert.equal(a.tokens, estimateTokens(a.prompt));
});

test('buildSystemPrompt puts persona, rules, playbook, skills and environment in named parts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zen-ctx-'));
  writeFileSync(join(dir, 'AGENTS.md'), '# Rules\nNo secrets in messages.');
  const persona: Persona = {
    name: 'atlas', role: 'engineering lead', team: 'eng', teamName: 'Engineering', reportsTo: 'owner', lead: true, model: null,
    expertise: 'TypeScript', capabilities: ['code', 'review'], definition: 'You review before you build.', playbook: '- [m-1 · +2 −0] Ask for the PR URL.', playbookPath: '',
  };
  const a = buildSystemPrompt({
    persona,
    rulesFiles: [join(dir, 'missing.md'), join(dir, 'AGENTS.md')],
    skills: [{ name: 'company-report', description: 'Report on the tracker. '.repeat(30), dir: '/s/company-report', file: '/s/company-report/SKILL.md' }],
    caps: { rules: 1000, persona: 1000, playbook: 1000, skills: 1000 },
    environment: { model: 'faux/faux-1' },
  });
  assert.deepEqual(a.parts.map((p) => p.name), ['identity', 'persona', 'rules', 'playbook', 'skills', 'environment']);
  assert.match(a.prompt, /You are atlas, engineering lead on team Engineering, reporting to owner\. You lead the team\./);
  assert.match(a.prompt, /Capabilities beyond the board: code, review/);
  assert.match(a.prompt, /<rules>\n# Rules/);
  assert.match(a.prompt, /- company-report: Report on the tracker\.[^\n]*…\n/);
  assert.match(a.prompt, /<environment>\nmodel: faux\/faux-1/);
  const none = buildSystemPrompt({ persona: null, rulesFiles: [], skills: [], caps: {}, environment: {} });
  assert.match(none.prompt, /careful agent/);
  assert.deepEqual(none.parts.map((p) => p.name), ['identity']);
});
