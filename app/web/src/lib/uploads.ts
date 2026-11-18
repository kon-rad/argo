import { ApiError, request } from './api.js';

export interface UploadDestination {
  label: string;
  path: string;
  keywords: string[];
}

export type UploadStatus = 'uploading' | 'uploaded' | 'ingesting' | 'stored' | 'failed' | 'aborted';

export interface UploadRecord {
  id: string;
  filename: string;
  size_bytes: number;
  dest_dir: string;
  description: string;
  tags: string[];
  status: UploadStatus;
  b2_path: string | null;
  stub_path: string | null;
  error: string | null;
  to_m1: boolean;
  m1_status: 'pending' | 'pulling' | 'done' | 'failed' | null;
  m1_path: string | null;
  m1_error: string | null;
  created_at: string;
  completed_at: string | null;
}

interface StartResponse {
  upload: UploadRecord;
  partSize: number;
  partCount: number;
  donePartNumbers?: number[];
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

export const uploadsApi = {
  config: () => request<{ destinations: UploadDestination[]; maxBytes: number }>('/uploads/config'),
  suggest: (q: string) => request<{ destination: UploadDestination | null }>('/uploads/suggest', { q }),
  list: () => request<{ uploads: UploadRecord[] }>('/uploads'),
  get: (id: string) => request<StartResponse>(`/uploads/${id}`),
  create: (body: {
    filename: string;
    size: number;
    contentType?: string;
    destDir: string;
    description: string;
    tags: string[];
    toM1: boolean;
  }) => request<StartResponse>('/uploads', undefined, post(body)),
  parts: (id: string, partNumbers: number[]) =>
    request<{ urls: Record<string, string> }>(`/uploads/${id}/parts`, undefined, post({ partNumbers })),
  complete: (id: string) => request<{ upload: UploadRecord }>(`/uploads/${id}/complete`, undefined, post({})),
  abort: (id: string) => request<{ upload: UploadRecord }>(`/uploads/${id}/abort`, undefined, post({})),
  retry: (id: string) => request<{ upload: UploadRecord }>(`/uploads/${id}/retry`, undefined, post({})),
  toM1: (id: string) => request<{ upload: UploadRecord }>(`/uploads/${id}/m1`, undefined, post({})),
};

// ---- the chunked uploader ---------------------------------------------------------------------------------------

const CONCURRENCY = 4;
const PRESIGN_BATCH = 16;
const ATTEMPTS = 6;

export interface UploadProgress {
  id: string;
  sentBytes: number;
  totalBytes: number;
  partsDone: number;
  partCount: number;
}

const fingerprint = (f: File, destDir: string): string => `sb-upload:${f.name}:${f.size}:${f.lastModified}:${destDir}`;

function remember(key: string, id: string | null): void {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {
    /* private window or blocked storage: the upload still works, it just can't resume after a reload */
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** PUT one part to its presigned URL; progress is bytes of this part. Rejects with `retryable` on network errors and 5xx/403/408/429. */
function putPart(url: string, blob: Blob, onBytes: (n: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(Object.assign(new Error(`part upload answered ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(Object.assign(new Error('network error during part upload'), { status: 0 }));
    xhr.ontimeout = xhr.onerror;
    const onAbort = (): void => {
      xhr.abort();
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.send(blob);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Sends `file` to the bucket in parts, 4 at a time, and asks the server to finish it. A part that fails is retried
 * with a fresh URL; a reload or a dropped connection resumes from the parts B2 already holds.
 */
export async function uploadFile(
  file: File,
  meta: { destDir: string; description: string; tags: string[]; toM1: boolean },
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal,
): Promise<UploadRecord> {
  const key = fingerprint(file, meta.destDir);
  let start: StartResponse | null = null;
  const prior = recall(key);
  if (prior) {
    start = await uploadsApi.get(prior).catch(() => null);
    if (start && start.upload.status !== 'uploading') start = null;
  }
  if (!start) {
    start = await uploadsApi.create({
      filename: file.name,
      size: file.size,
      contentType: file.type || undefined,
      destDir: meta.destDir,
      description: meta.description,
      tags: meta.tags,
      toM1: meta.toM1,
    });
    start.donePartNumbers = [];
  }
  const { upload, partSize, partCount } = start;
  remember(key, upload.id);

  const done = new Set(start.donePartNumbers ?? []);
  const sizeOf = (n: number): number => (n < partCount ? partSize : file.size - partSize * (partCount - 1));
  const inFlight = new Map<number, number>();
  let sentDone = [...done].reduce((a, n) => a + sizeOf(n), 0);
  const report = (): void => {
    const flying = [...inFlight.values()].reduce((a, b) => a + b, 0);
    onProgress({ id: upload.id, sentBytes: sentDone + flying, totalBytes: file.size, partsDone: done.size, partCount });
  };
  report();

  const queue: number[] = [];
  for (let n = 1; n <= partCount; n++) if (!done.has(n)) queue.push(n);
  const urls = new Map<number, string>();

  async function presign(n: number): Promise<string> {
    if (!urls.has(n)) {
      const batch = [n, ...queue.filter((q) => q !== n && !urls.has(q)).slice(0, PRESIGN_BATCH - 1)];
      const res = await uploadsApi.parts(upload.id, batch);
      for (const [k, v] of Object.entries(res.urls)) urls.set(Number(k), v);
    }
    return urls.get(n)!;
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const n = queue.shift();
      if (n === undefined) return;
      const blob = file.slice((n - 1) * partSize, (n - 1) * partSize + sizeOf(n));
      for (let attempt = 1; ; attempt++) {
        try {
          await putPart(await presign(n), blob, (b) => { inFlight.set(n, b); report(); }, signal);
          break;
        } catch (err) {
          inFlight.delete(n);
          urls.delete(n);
          const status = (err as { status?: number }).status;
          const retryable = status === undefined ? false : status === 0 || status === 403 || status === 408 || status === 429 || status >= 500;
          if ((err as Error).name === 'AbortError' || !retryable || attempt >= ATTEMPTS) throw err;
          await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        }
      }
      inFlight.delete(n);
      done.add(n);
      sentDone += sizeOf(n);
      report();
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
  const finished = await uploadsApi.complete(upload.id);
  remember(key, null);
  return finished.upload;
}

export function isAbort(err: unknown): boolean {
  return (err as Error)?.name === 'AbortError';
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
