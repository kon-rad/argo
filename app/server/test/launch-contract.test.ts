import { expect, it } from 'vitest';
import { boardEnvelope, launchSchema } from '../src/usage/launchContract.js';
const base = { v: 1, runId: 'run-1', source: 'codex', runtime: 'codex', sessionId: null,
  entrypoint: 'cli', trigger: 'cron', channel: 'telegram', persona: null, personaOrigin: null, taskIds: ['t_1234abcd'] };
it('keeps independent launch dimensions and rejects forged identity and unknown versions', () => {
  expect(launchSchema.parse(base)).toEqual(base);
  for (const change of [{ v: 2 }, { source: 'hermes' }, { host: 'other' }, { taskIds: ['made-up'] }, { runId: '' }]) {
    expect(launchSchema.safeParse({ ...base, ...change }).success).toBe(false);
  }
});
it('accepts a leading board launch envelope, excluding ordinary references, URLs and quotes', () => {
  expect(boardEnvelope('Board card t_1234abcd: Example\nDo the work.')).toEqual({ id: 't_1234abcd', title: 'Example' });
  for (const text of ['Discuss Board card t_1234abcd: Example', '> Board card t_1234abcd: Example',
    '```\nBoard card t_1234abcd: Example\n```', 'https://example.com/board/t_1234abcd', '[Replying to: Board card t_1234abcd: Example]']) {
    expect(boardEnvelope(text)).toBeNull();
  }
});

it('accepts a compiled headless envelope but excludes fenced headings inside it', () => {
  const prefix = '# guide, Engineer\n\nYou are **guide**, Engineer.\n# How this run works (cc-card, headless)\n';
  expect(boardEnvelope(prefix+'Board card t_1234abcd: Example')).toEqual({id:'t_1234abcd',title:'Example'});
  expect(boardEnvelope(prefix+'```\nBoard card t_1234abcd: Example\n```')).toBeNull();
});
