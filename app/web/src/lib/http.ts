export type Params = Record<string, string | number | boolean | undefined>;

export function url(path: string, params?: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return `/api${path}${qs ? `?${qs}` : ''}`;
}

/** Fired when any protected call answers 401, so the shell clears its cache and shows login. */
export const AUTH_EXPIRED_EVENT = 'secondbrain:auth-expired';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function request<T>(path: string, params?: Params, init?: RequestInit): Promise<T> {
  const res = await fetch(url(path, params), { credentials: 'same-origin', ...init });
  if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(res.status, body?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Vault paths are slash-separated and go straight into the browser route. */
export const fileHref = (path: string): string =>
  `/file/${path.split('/').map(encodeURIComponent).join('/')}`;
