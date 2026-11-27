import { describe, expect, it, vi } from 'vitest';
import { runHostCommandOnce } from '../src/hosts/worker.js';

const origin = 'https://board.example';
const lease = { attempt: 'test-run', generation: 2, command: 'count', handler: 'word-count', text: ' one\ntwo  three ' };
const offered = () => Response.json({ lease });
const ok = () => new Response(null, { status: 204 });

describe('host command worker', () => {
  it('authenticates, acknowledges the lease, and submits one result', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(offered()).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
    expect(await runHostCommandOnce(origin, 'test-token', send)).toBe(true);
    const calls = send.mock.calls;
    expect(calls.map(([url]) => String(url).split('/').pop())).toEqual(['poll', 'start', 'finish']);
    for (const [, init] of calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
      expect(init?.redirect).toBe('error');
    }
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ attempt: 'test-run', generation: 2, pid: process.pid });
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toEqual({ attempt: 'test-run', generation: 2, outcome: 'succeeded', count: 3 });
  });

  it('returns idle when no eligible lease exists', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ lease: null }));
    expect(await runHostCommandOnce(origin, 'test-token', send)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stops if the server rejects the start receipt', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(offered()).mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(runHostCommandOnce(origin, 'test-token', send)).rejects.toThrow('409');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries delivery of an identical result after a lost acknowledgement', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(offered()).mockResolvedValueOnce(ok()).mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(ok());
    await runHostCommandOnce(origin, 'test-token', send);
    expect(send.mock.calls[2]?.[1]?.body).toBe(send.mock.calls[3]?.[1]?.body);
    expect(send.mock.calls.map(([url]) => String(url).split('/').pop())).toEqual(['poll', 'start', 'finish', 'finish']);
  });

  it('makes one poll when reservation delivery is ambiguous', async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network'));
    await expect(runHostCommandOnce(origin, 'test-token', send)).rejects.toThrow('confirm poll');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('bounds receipt retries and leaves an ambiguous start for reconciliation', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(offered()).mockRejectedValue(new TypeError('network'));
    await expect(runHostCommandOnce(origin, 'test-token', send)).rejects.toThrow('confirm start');
    expect(send.mock.calls.map(([url]) => String(url).split('/').pop())).toEqual(['poll', 'start', 'start', 'start']);
  });

  it('refuses a cleartext remote origin before sending credentials', async () => {
    const send = vi.fn<typeof fetch>();
    await expect(runHostCommandOnce('http://board.example', 'test-token', send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects unrecognized handlers before starting', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ lease: { ...lease, handler: 'unknown' } }));
    await expect(runHostCommandOnce(origin, 'test-token', send)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
