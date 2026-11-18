import type { HttpGet } from '../collect.js';

/**
 * HTTP for the API collectors. Calls that carry a key or token go through
 * Node's fetch, not curl, so the secret never sits on a process's command line
 * where `ps` would show it. Every error message passes through `redact` before
 * it is returned, logged or stored.
 */

export const fetchGet: HttpGet = async (url, headers = {}) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  return { status: res.status, body: await res.text() };
};

const SECRET_PARAMS = /([?&](?:access_token|input_token|code|key|client_secret|token)=)[^&\s"']+/gi;

/** Removes the given secrets and any token-shaped query parameter from a message. */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  // A value seen in a token parameter is a secret wherever else it appears in the message.
  const matches = [...text.matchAll(SECRET_PARAMS)];
  const seen = matches.flatMap((m) => {
    const raw = m[0].slice(m[1]!.length);
    return [raw, decodeURIComponentSafe(raw)];
  });
  const values = [...new Set([
    ...secrets.filter((s): s is string => Boolean(s && s.length >= 4)),
    ...seen.filter((s) => s.length > 0),
  ])].sort((a, b) => b.length - a.length);
  const pattern = values.length > 0
    ? new RegExp(values.map(escapeRegExp).join('|'), 'g')
    : null;
  const replaceSecrets = (value: string) => pattern ? value.replace(pattern, '[redacted]') : value;

  let out = '';
  let offset = 0;
  for (const match of matches) {
    const index = match.index!;
    out += replaceSecrets(text.slice(offset, index));
    out += `${match[1]}[redacted]`;
    offset = index + match[0].length;
  }
  return out + replaceSecrets(text.slice(offset));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export class ApiError extends Error {}

/** GET a JSON API; a non-200 answer or bad JSON becomes an ApiError with the API's own message, redacted. */
export async function getJson<T>(get: HttpGet, url: string, what: string, secrets: readonly (string | undefined)[], headers: Record<string, string> = {}): Promise<T> {
  let r: { status: number; body: string };
  try {
    r = await get(url, headers);
  } catch (err) {
    throw new ApiError(redact(`${what}: ${(err as Error).message}`, secrets));
  }
  let body: unknown;
  try {
    body = JSON.parse(r.body);
  } catch {
    throw new ApiError(redact(`${what}: HTTP ${r.status}, not JSON`, secrets));
  }
  if (r.status !== 200) {
    const e = (body as { error?: { message?: string; errors?: { reason?: string }[] } }).error;
    const reason = e?.errors?.map((x) => x.reason).filter(Boolean).join(',');
    throw new ApiError(redact(`${what}: HTTP ${r.status}${reason ? ` ${reason}` : ''}${e?.message ? `: ${e.message}` : ''}`, secrets).slice(0, 500));
  }
  return body as T;
}

/** A count from an API ("36", 36) or null when absent or hidden. Never a stand-in 0. */
export function count(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
