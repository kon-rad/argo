import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { pinnedMetadataTransport } from './erc8004.js';
beforeEach(() => { vi.resetAllMocks(); mocks.lookup.mockResolvedValue([{ address:'8.8.8.8',family:4 }]); }); // public-ok: synthetic public/private destination and credential rejection vectors
function response(status = 200, body = '{}', headers: Record<string,string> = {}) {
  const req = Object.assign(new EventEmitter(), { end:vi.fn(), destroy:vi.fn() });
  const res = Object.assign(new EventEmitter(), { statusCode:status, headers, destroy:vi.fn() });
  mocks.request.mockImplementation((_url: unknown,_options: unknown,callback: (value: typeof res) => void) => {
    req.end.mockImplementation(() => { callback(res); if (!res.destroy.mock.calls.length) { res.emit('data',Buffer.from(body)); res.emit('end'); } req.emit('close'); });
    return req;
  });
  return {req,res};
}
describe('DNS-pinned metadata HTTPS transport', () => {
  it('pins the socket to validated DNS while retaining original TLS hostname and disables pooling', async () => {
    response();
    expect(await pinnedMetadataTransport.read(new URL('https://metadata.example.test/a'),1024,100)).toEqual(Buffer.from('{}'));
    const [url, options] = mocks.request.mock.calls[0]!;
    expect(url.hostname).toBe('metadata.example.test'); expect(options.agent).toBe(false);
    const callback = vi.fn(); options.lookup('metadata.example.test',{},callback); expect(callback).toHaveBeenCalledWith(null,'8.8.8.8',4); // public-ok: synthetic public/private destination and credential rejection vectors
    const all = vi.fn(); options.lookup('metadata.example.test',{all:true},all); expect(all).toHaveBeenCalledWith(null,[{address:'8.8.8.8',family:4}]); // public-ok: synthetic public/private destination and credential rejection vectors
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it('blocks private or mixed-public/private DNS before opening an HTTPS connection', async () => {
    for (const answers of [[{address:'127.0.0.1',family:4}],[{address:'8.8.8.8',family:4},{address:'10.1.1.1',family:4}],[]]) { // public-ok: synthetic public/private destination and credential rejection vectors
      mocks.lookup.mockResolvedValueOnce(answers);
      await expect(pinnedMetadataTransport.read(new URL('https://metadata.example.test/a'),1024,100)).rejects.toThrow('DNS is not public');
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('does not follow redirects and rejects compressed/oversized responses', async () => {
    for (const [status,body,headers] of [[302,'', {location:'https://127.0.0.1/'}],[200,'{}', {'content-encoding':'gzip'}],[200,'{}',{'content-length':'2048'}],[200,'x'.repeat(1025),{}]] as const) { // public-ok: synthetic public/private destination and credential rejection vectors
      response(status,body,headers);
      await expect(pinnedMetadataTransport.read(new URL('https://metadata.example.test/a'),1024,100)).rejects.toThrow();
    }
    expect(mocks.request).toHaveBeenCalledTimes(4);
  });
  it('bounds DNS lookup time before requesting metadata', async () => {
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    await expect(pinnedMetadataTransport.read(new URL('https://metadata.example.test/a'),1024,10)).rejects.toThrow('timeout');
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
