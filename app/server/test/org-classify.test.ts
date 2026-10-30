import { describe, expect, it, vi } from 'vitest';
import { classifyCard, classifyRules, type ClassifierSettings } from '../src/org-classify.js';

/** The classifier: rules read scope, paths, repos, spec clarity and risk; the model may only make spec clarity stricter. */

describe('classifyRules', () => {
  it('reads one named file, a verification command and no risk', () => {
    const s = classifyRules({ title: 'Default sort on the board', work_type: 'coding', body: 'In `app/web/src/Board.tsx` sort by most recently updated.\n\nVerify: `npm run typecheck`' });
    expect(s).toMatchObject({ work: 'coding', scope: 1, paths: ['app/web/src/Board.tsx'], namedPath: true, specClarity: 'ok', risk: 'normal', riskFlags: [], source: 'rules' });
    expect(s.clarity).toEqual(['verification command', 'path']);
  });

  it('calls a card with no criteria, command, path or URL low clarity', () => {
    const s = classifyRules({ title: 'Make the board better', body: 'It feels slow and cluttered, improve it.' });
    expect(s).toMatchObject({ scope: 0, namedPath: false, specClarity: 'low', clarity: [] });
  });

  it('counts acceptance criteria and a URL as a clear spec', () => {
    expect(classifyRules({ title: 'x', body: 'Acceptance criteria:\n- [ ] the page loads' }).clarity).toEqual(['acceptance criteria']);
    expect(classifyRules({ title: 'x', body: 'See https://example.com/spec for the layout.' }).clarity).toEqual(['url']);
    expect(classifyRules({ title: 'x', contract: { verification: 'curl the health URL' } }).specClarity).toBe('ok');
  });

  it('counts distinct files, a directory as two, and ignores prose slashes and URLs', () => {
    const s = classifyRules({ title: 'Refactor', body: 'Touch server/src/a.ts and server/src/b.ts, then a.ts again, and/or the whole `web/src/` tree. Not https://x.io/c.ts.' });
    expect(s.paths).toEqual(['server/src/a.ts', 'server/src/b.ts', 'a.ts', 'web/src/']);
    expect(s.scope).toBe(5);
  });

  it('takes contract scope entries as paths', () => {
    expect(classifyRules({ title: 'x', contract: { scope: ['db/migrations/'] } })).toMatchObject({ paths: ['db/migrations/'], scope: 2, riskFlags: ['migration'] });
  });

  it('counts repos from the card and the text, and treats more than one as multi-file', () => {
    const s = classifyRules({ title: 'Bump the client', repo: 'acme/app', body: 'Also update github.com/acme/sdk and run with --repo app.' });
    expect(s.repos).toBe(2);
    expect(s.scope).toBe(2);
  });

  it('flags risk by keyword and by path', () => {
    expect(classifyRules({ title: 'Add a migration for users' }).riskFlags).toEqual(['migration']);
    expect(classifyRules({ title: 'Rotate the API key and the db password' }).riskFlags).toEqual(['secret']);
    expect(classifyRules({ title: 'Stripe refunds', body: 'then deploy to production' }).riskFlags).toEqual(['payment', 'deploy', 'prod']);
    expect(classifyRules({ title: 'Fix login redirect' }).riskFlags).toEqual(['auth']);
    expect(classifyRules({ title: 'Edit', body: 'Change `server/.env.example` and db/migrations/0001_init.sql' }).riskFlags).toEqual(['migration', 'secret']);
    expect(classifyRules({ title: 'Edit', body: 'server/src/auth/session.ts' }).riskFlags).toEqual(['auth']);
  });

  it('does not flag look-alike words', () => {
    const s = classifyRules({ title: 'Product page copy', body: 'The author wants a key insight and a git checkout of main.' });
    expect(s).toMatchObject({ risk: 'normal', riskFlags: [] });
  });
});

describe('classifyCard with the model step', () => {
  const cfg: ClassifierSettings = { mode: 'model', model: 'small', baseUrl: 'http://localhost:11434/v1', timeoutMs: 50 };
  const clear = { title: 'Edit', work_type: 'coding', body: 'Change server/src/a.ts; verify with `npm test`.' };
  const reply = (content: string, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;

  it('defaults to rules and never calls the model', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect((await classifyCard(clear, undefined, f)).source).toBe('rules');
    expect((await classifyCard(clear, { mode: 'rules' }, f)).source).toBe('rules');
    expect(f).not.toHaveBeenCalled();
  });

  it('lets the model lower clarity, and posts to /v1/chat/completions', async () => {
    const f = reply('{"spec_clarity": "low", "why": "no done condition"}');
    const s = await classifyCard(clear, cfg, f);
    expect(s).toMatchObject({ specClarity: 'low', clarity: [], source: 'model', risk: 'normal' });
    expect((f as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('keeps the rules reading when the model agrees', async () => {
    expect(await classifyCard(clear, cfg, reply('{"spec_clarity": "ok"}'))).toMatchObject({ specClarity: 'ok', source: 'model' });
  });

  it('never asks the model to raise a low reading', async () => {
    const f = reply('{"spec_clarity": "ok"}');
    const s = await classifyCard({ title: 'Make it better' }, cfg, f);
    expect(s).toMatchObject({ specClarity: 'low', source: 'rules' });
    expect(f).not.toHaveBeenCalled();
  });

  it('falls back to rules on bad JSON, an unknown answer, an HTTP error, a network error and a timeout', async () => {
    expect(await classifyCard(clear, cfg, reply('sure, it is fine'))).toMatchObject({ specClarity: 'ok', source: 'rules', note: expect.stringMatching(/bad JSON/) });
    expect(await classifyCard(clear, cfg, reply('{"spec_clarity": "great"}'))).toMatchObject({ source: 'rules', note: expect.stringMatching(/no spec_clarity/) });
    expect(await classifyCard(clear, cfg, reply('{}', 500))).toMatchObject({ source: 'rules', note: expect.stringMatching(/HTTP 500/) });
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await classifyCard(clear, cfg, down)).toMatchObject({ source: 'rules', note: expect.stringMatching(/failed/) });
    const slow = vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
    expect(await classifyCard(clear, cfg, slow)).toMatchObject({ specClarity: 'ok', source: 'rules', note: expect.stringMatching(/timed out/) });
  });

  it('falls back to rules when model or baseUrl is unset', async () => {
    expect(await classifyCard(clear, { mode: 'model' })).toMatchObject({ source: 'rules', note: expect.stringMatching(/unset/) });
  });
});
