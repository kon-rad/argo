/** @param {unknown} record @param {string} idempotencyKey */
export function mutationEnvelope(record, idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) throw new Error('A unique idempotency key is required');
  return JSON.stringify({ record, idempotencyKey });
}
/** @param {string} path */
export function publicPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/public/') || path.startsWith('//')) throw new Error('Only public endpoints are allowed');
  const parsed = new URL(path, 'https://public.invalid');
  if (parsed.origin !== 'https://public.invalid' || !parsed.pathname.startsWith('/public/') || parsed.search || parsed.hash) throw new Error('Only bounded public endpoint paths are allowed');
  return `${parsed.pathname}`;
}
