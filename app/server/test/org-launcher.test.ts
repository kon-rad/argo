import { expect, it, vi } from 'vitest';
import { runLauncher, type LauncherAdapter } from '../src/org-runtime/launcher.js';

const assignment = {runtime:'codex',model:'example-model',provider:null};
const before = {...assignment,model:'example-old'};
function fixture() {
  let version = 0;
  const inspect = () => ({assignment:version ? assignment : before, version, healthy:true, activePollers:1, selectedPollerHealthy:true});
  const adapter: LauncherAdapter = {
    inspect:async () => inspect(), preflight:async () => true,
    apply:vi.fn(async v => { version = v; }), verify:async () => inspect(),
  };
  return adapter;
}
it('retries a verified version without repeating the host mutation', async () => {
  const a = fixture();
  for (let i=0;i<2;i++) expect(await runLauncher('telegram-poller',1,assignment,a)).toBe('verified');
  expect(a.apply).toHaveBeenCalledTimes(1);
});
it('fails closed on missing support, duplicate pollers, or an inactive route', async () => {
  expect(await runLauncher('cron-job',1,assignment,undefined)).toBe('unsupported');
  for (const kind of ['telegram-poller','default-route'] as const) {
    const a = fixture();
    const state = {...await a.inspect(),activePollers:2,selectedPollerHealthy:false};
    a.inspect = async () => state;
    expect(await runLauncher(kind,1,assignment,a)).toBe('unhealthy');
    expect(a.apply).not.toHaveBeenCalled();
  }
});
it('requires actual matching readback and suppresses private adapter exceptions', async () => {
  const a = fixture();
  const old = await a.inspect();
  a.verify = async () => old;
  expect(await runLauncher('telegram-gateway',1,assignment,a)).toBe('unhealthy');
  a.verify = async () => { throw Error('private diagnostic'); };
  expect(await runLauncher('telegram-gateway',1,assignment,a)).toBe('failed');
});
it('preserves independent host changes and rejects a host already on a newer version', async () => {
  const a = fixture();
  expect(await runLauncher('cron-job',1,assignment,a,{...before,model:'different'})).toBe('drifted');
  const state = await a.inspect();
  a.inspect = async () => ({...state,version:2});
  expect(await runLauncher('cron-job',1,assignment,a)).toBe('stale');
  expect(a.apply).not.toHaveBeenCalled();
});
it('leaves the old gateway running when credential preflight fails', async () => {
  const a = fixture();
  a.preflight = async () => false;
  expect(await runLauncher('telegram-gateway',1,assignment,a)).toBe('unhealthy');
  expect(a.apply).not.toHaveBeenCalled();
  expect((await a.inspect()).assignment).toEqual(before);
});
