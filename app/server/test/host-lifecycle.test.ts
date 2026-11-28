import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enrollWorker, readEnrollment, serviceDefinition } from '../src/hosts/lifecycle.js';

const homes: string[] = [];
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'host-lifecycle-'));
  homes.push(dir);
  return dir;
}
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('private host enrollment', () => {
  it('validates HTTPS before sending a one-use code', async () => {
    const send = vi.fn();
    await expect(enrollWorker(home(), 'http://board.example', 'sample-code', send)).rejects.toThrow(/HTTPS/);
    expect(send).not.toHaveBeenCalled();
  });
  it('persists a protected enrollment and preserves an existing machine identity', async () => {
    const dir = home();
    const send = vi.fn(async () => Response.json({ machine: 'sample', token: 'sample-token' }));
    await enrollWorker(dir, 'https://board.example', 'sample-code', send);
    expect(readEnrollment(dir)).toEqual({ origin: 'https://board.example', machine: 'sample', token: 'sample-token' });
    const file = join(dir, '.config', 'secondbrain', 'host-worker', 'enrollment.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    await expect(enrollWorker(dir, 'https://board.example', 'other', send)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    chmodSync(file, 0o644);
    expect(() => readEnrollment(dir)).toThrow(/permission/i);
  });
  it('allows retry when the server refuses a code', async () => {
    const dir = home();
    await expect(enrollWorker(dir, 'https://board.example', 'bad', async () => new Response(null, {status: 403}))).rejects.toThrow(/403/);
    await enrollWorker(dir, 'https://board.example', 'good', async () => Response.json({machine: 'sample', token: 'ok'}));
    expect(readEnrollment(dir).machine).toBe('sample');
  });
});
describe('OS service definitions', () => {
  it('uses the built worker entry directly and keeps credentials out of both user services', () => {
    const dir = home();
    const entry = join(dir, 'Engine & tools', 'cli-host-worker.js');
    const mac = serviceDefinition('darwin', dir, '/opt/bin/node', entry);
    expect(mac.contents).toContain('Engine &amp; tools');
    expect(mac.contents).toContain('--enrolled');
    expect(mac.contents).toContain('ExitTimeOut');
    const linux = serviceDefinition('linux', dir, '/opt/bin/node', entry);
    expect(linux.contents).toContain('Restart=on-failure');
    expect(linux.contents).toContain('TimeoutStopSec=240');
    expect(linux.contents).toContain('"'+entry+'"');
    for (const service of [mac, linux]) expect(service.contents).not.toMatch(/SECONDBRAIN_HOST_TOKEN|enrollment.json/);
  });
});
