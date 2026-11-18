import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadFile } from '../src/lib/uploads.js';

const MiB = 1024 ** 2;
const PART = 64 * MiB;

/** A fake XHR: records each PUT url, fails the ones listed in `failures` (url -> statuses to answer in turn). */
let puts: string[] = [];
let failures = new Map<string, number[]>();
class FakeXhr {
  status = 0;
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  private url = '';
  open(_m: string, url: string) { this.url = url; }
  abort() {}
  send() {
    puts.push(this.url);
    queueMicrotask(() => {
      const next = failures.get(this.url)?.shift();
      this.status = next ?? 200;
      if (next === 0) this.onerror?.();
      else this.onload?.();
    });
  }
}

let created = 0;
let completed = 0;
let done: number[] = [];
function api(path: string, init?: RequestInit): unknown {
  if (path.endsWith('/uploads') && init?.method === 'POST') {
    created++;
    return { upload: { id: 'u1', status: 'uploading' }, partSize: PART, partCount: 3 };
  }
  if (/\/uploads\/u1$/.test(path)) return { upload: { id: 'u1', status: 'uploading' }, partSize: PART, partCount: 3, donePartNumbers: done };
  if (path.endsWith('/parts')) {
    const nums = (JSON.parse(String(init?.body)) as { partNumbers: number[] }).partNumbers;
    return { urls: Object.fromEntries(nums.map((n) => [String(n), `https://b2.test/part/${n}`])) };
  }
  if (path.endsWith('/complete')) { completed++; return { upload: { id: 'u1', status: 'uploaded' } }; }
  throw new Error(`unexpected ${path}`);
}

beforeEach(() => {
  puts = []; failures = new Map(); created = 0; completed = 0; done = [];
  localStorage.clear();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) =>
    new Response(JSON.stringify(api(String(u), init)), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// A 150 MiB File without allocating it: slice() only needs a size.
const bigFile = (): File => {
  const f = new File(['x'], 'day 1.mp4', { type: 'video/mp4' });
  Object.defineProperty(f, 'size', { value: 150 * MiB });
  f.slice = () => new Blob(['x']);
  return f;
};
const meta = { destDir: 'Areas/x/vlogs', description: '', tags: [], toM1: false };

async function run(file: File) {
  const p = uploadFile(file, meta, () => {}, new AbortController().signal);
  await vi.runAllTimersAsync();
  return p;
}

describe('uploadFile', () => {
  it('sends every part once, then completes', async () => {
    await run(bigFile());
    expect([...puts].sort()).toEqual(['https://b2.test/part/1', 'https://b2.test/part/2', 'https://b2.test/part/3']);
    expect(created).toBe(1);
    expect(completed).toBe(1);
  });

  it('retries a part that fails on the network and then succeeds', async () => {
    failures.set('https://b2.test/part/2', [0, 503]);
    await run(bigFile());
    expect(puts.filter((u) => u.endsWith('/2')).length).toBe(3);
    expect(completed).toBe(1);
  });

  it('gives up on a part the server rejects outright (400)', async () => {
    failures.set('https://b2.test/part/1', [400]);
    const p = uploadFile(bigFile(), meta, () => {}, new AbortController().signal);
    const caught = p.then(() => null, (e: Error) => e);
    await vi.runAllTimersAsync();
    expect((await caught)?.message).toMatch(/400/);
    expect(completed).toBe(0);
  });

  it('resumes: reuses the upload and skips parts the bucket already holds', async () => {
    puts = []; created = 0; done = [1, 2];
    const f = bigFile();
    localStorage.setItem(`sb-upload:${f.name}:${f.size}:${f.lastModified}:${meta.destDir}`, 'u1');
    await run(f);
    expect(created).toBe(0);
    expect(puts).toEqual(['https://b2.test/part/3']);
  });
});
