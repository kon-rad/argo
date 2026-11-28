import { expect, it, vi } from 'vitest';
import { runOwnerCommand } from '../src/hosts/owner-client.js';

const session = {origin: 'https://board.example', cookie: '__Host-sb_session=' + 'a'.repeat(43)};
const id = '9abe20c7-2229-4962-b2a2-c8861fa2f1b5';

it('submits the same caller-supplied key and exact stdin on retries', async () => {
  const send = vi.fn(async () => Response.json({id}));
  for (let n = 0; n < 2; n++)
    expect(await runOwnerCommand(['submit', 'count', 'stable-key'], session, async () => 'one two three\n', send)).toEqual({id});
  for (const [url, init] of send.mock.calls as unknown as [string, RequestInit][]) {
    expect(url).toBe('https://board.example/api/host-pilot/requests');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({command: 'count', text: 'one two three\n', requestKey: 'stable-key'});
  }
});

it('rejects unsafe origins and malformed IDs before reading input or sending credentials', async () => {
  const send = vi.fn();
  for (const origin of ['http://board.example', 'https://u@localhost', 'https://board.example/path'])
    await expect(runOwnerCommand(['list'], {...session, origin}, vi.fn(), send)).rejects.toThrow();
  await expect(runOwnerCommand(['describe','../requests'], session, vi.fn(), send)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

it('only returns a result for a successful run', async () => {
  const run = (state: string) => runOwnerCommand(['result', id], session, vi.fn(),
    async () => Response.json({state, result: state === 'succeeded' ? {count: 3} : null}));
  expect(await run('succeeded')).toEqual({count: 3});
  await expect(run('queued')).rejects.toThrow(/queued/);
});
