/** Parse an operator-owned HTTPS origin without URL path normalization hiding extra components. */
export function normalizeAuthorityOrigin(value: string): string | null {
  if (value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (!/^https:\/\/[^/?#\\\s@]+\/?$/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}
