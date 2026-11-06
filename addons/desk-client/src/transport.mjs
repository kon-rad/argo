import { publicPath } from './wire.mjs';
/** @param {string} baseUrl @param {typeof fetch} fetcher @param {string} path @param {RequestInit} [init] */
export async function publicRequest(baseUrl, fetcher, path, init) {
  try {
    const response = await fetcher(new URL(publicPath(path).slice(1), baseUrl), { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
    if (!response.ok) return { kind: response.status === 409 ? 'pending' : 'unavailable', message: `Public endpoint returned ${response.status}` };
    return { kind: 'ok', value: await response.json() };
  } catch (error) { return { kind: 'unavailable', message: error instanceof Error ? error.message : 'Public endpoint unavailable' }; }
}
