import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { sessionCookieHash } from '../../auth/router.js';
import { query } from '../../db.js';
import { settings } from '../../settings.js';
import type { HttpGet } from '../collect.js';
import { fetchGet, getJson } from './http.js';
import { validateFacebookToken } from './facebook-token.js';
import { saveToken } from './tokens.js';

export const IG_CALLBACK = '/socials/ig/auth/callback';
const BINDING_COOKIE = 'sb_ig_binding';
const TTL = 10 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface InstagramUnifiedOptions {
  appId?: string; appSecret?: string; configurationId?: string; publicOrigin?: string; encKey?: string;
  get?: HttpGet; now?: () => number; secureCookie?: boolean;
}

/** Facebook USER and business-integration SYSTEM_USER tokens, each with its own asset proof. Other token types fail closed. */
export function instagramUnifiedRoutes(o: InstagramUnifiedOptions, vaultRoot: string, sessionGate?: RequestHandler) {
  const start = Router(), callback = Router();
  const get = o.get ?? fetchGet, now = o.now ?? Date.now;
  const cookieOptions = { httpOnly: true, secure: o.secureCookie ?? true, sameSite: 'lax' as const, path: IG_CALLBACK };
  const configured = () => o.appId && o.appSecret && o.configurationId && o.encKey && o.publicOrigin && new URL(o.publicOrigin).origin === o.publicOrigin && o.publicOrigin.startsWith('https://');
  start.post('/instagram/connect', ...(sessionGate ? [sessionGate] : []), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!sessionGate || !res.locals.sessionHash) { res.status(401).json({ error: 'authenticated server session required' }); return; }
    if (!configured()) { res.status(503).json({ error: 'configure Facebook Unified Login and encryption first' }); return; }
    const account = settings(vaultRoot).socialMetrics.instagram.find(a => a.username.toLowerCase() === req.body?.account?.toLowerCase?.());
    if (!account || account.login !== 'unified' || !account.assetId) { res.status(400).json({ error: 'select a configured Unified Instagram asset' }); return; }
    const state = randomBytes(32).toString('base64url'), binding = randomBytes(32).toString('base64url');
    const redirect = o.publicOrigin + IG_CALLBACK;
    await query('DELETE FROM instagram_login_states WHERE expires_at <= now()');
    await query(`INSERT INTO instagram_login_states (state_hash, binding_hash, session_hash, account, asset_id, redirect_uri, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [hash(state), hash(binding), res.locals.sessionHash, account.username.toLowerCase(), account.assetId, redirect, new Date(now() + TTL)]);
    const url = new URL('https://www.facebook.com/dialog/oauth');
    url.search = new URLSearchParams({ client_id: o.appId!, config_id: o.configurationId!, override_default_response_type: 'true', response_type: 'code', display: 'popup', redirect_uri: redirect, state, prompt: 'login' }).toString();
    res.cookie(BINDING_COOKIE, binding, { ...cookieOptions, maxAge: TTL });
    res.json({ url: url.toString() });
  });
  callback.get('/socials/ig/auth', ...(sessionGate ? [sessionGate] : []), (_req, res) => {
    if (!sessionGate || !res.locals.sessionHash) { res.status(401).type('text').send('Log in to the server app first.'); return; }
    const nonce = randomBytes(16).toString('base64');
    res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'` });
    const accounts = settings(vaultRoot).socialMetrics.instagram.filter(a => a.login === 'unified' && a.assetId);
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect Instagram metrics</title><h1>Connect Instagram metrics</h1><p>Choose the account to authorize. Connect each account separately.</p>${accounts.map(a => `<button data-account="${a.username}">Connect @${a.username}</button>`).join(' ')}<p id="status"></p><script nonce="${nonce}">
      document.querySelectorAll('button').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const response = await fetch('/api/social/instagram/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: button.dataset.account }) });
          const data = await response.json();
          if (!response.ok) throw new Error('Unable to start connection. Check configuration and log in again.');
          window.location.assign(data.url);
        } catch { document.getElementById('status').textContent = 'Unable to connect. Check configuration and log in again.'; button.disabled = false; }
      }));
      </script></html>`);
  });
  // The Strict login cookie stays absent through a cross-site redirect chain. A
  // clean landing page with a user-initiated same-origin link restores it.
  callback.get('/socials/ig/auth/complete', (_req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    res.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><title>Instagram connected</title><p>Instagram metrics connected.</p><a href="/socials/ig/auth">Continue</a></html>');
  });
  callback.get(IG_CALLBACK, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    // Never send provider errors, codes, tokens, or transport exceptions to the error logger.
    try {
      const state = req.query.state;
      const binding = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith(BINDING_COOKIE + '='))?.slice(BINDING_COOKIE.length + 1);
      if (!configured() || typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state) || !binding || !/^[A-Za-z0-9_-]{43}$/.test(binding)) throw new Error('invalid attempt');
      // DELETE is the single-use claim, including denial/error returns. DB checks live session and expiry.
      const { rows } = await query<{ account: string; asset_id: string; redirect_uri: string }>(`DELETE FROM instagram_login_states st USING auth_sessions s
        WHERE st.state_hash=$1 AND st.binding_hash=$2 AND st.session_hash=s.token_hash
        AND ($3::text IS NULL OR st.session_hash=$3)
        AND st.expires_at > now() AND s.expires_at > now() AND s.last_seen_at > now() - interval '7 days'
        RETURNING st.account, st.asset_id, st.redirect_uri`, [hash(state), hash(binding), sessionCookieHash(req, o.secureCookie ?? true)]);
      const attempt = rows[0];
      if (!attempt || attempt.redirect_uri !== o.publicOrigin + IG_CALLBACK) throw new Error('invalid attempt');
      res.clearCookie(BINDING_COOKIE, cookieOptions);
      const account = settings(vaultRoot).socialMetrics.instagram.find(a => a.username.toLowerCase() === attempt.account && a.login === 'unified' && a.assetId === attempt.asset_id);
      if (!account || req.query.error !== undefined || typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) throw new Error('authorization denied');
      const base = `https://graph.facebook.com/${settings(vaultRoot).socialMetrics.instagramApiVersion}`;
      const exchange = new URLSearchParams({ client_id: o.appId!, client_secret: o.appSecret!, redirect_uri: attempt.redirect_uri, code: req.query.code });
      const issued = await getJson<{ access_token?: string }>(get, `${base}/oauth/access_token?${exchange}`, 'Facebook exchange', [req.query.code, o.appSecret]);
      if (!issued.access_token || typeof issued.access_token !== 'string') throw new Error('no token');
      const token = issued.access_token;
      const appToken = `${o.appId}|${o.appSecret}`;
      const debug = await getJson<unknown>(get,
        `${base}/debug_token?input_token=${encodeURIComponent(token)}`, 'Facebook token validation', [token, appToken], { Authorization: `Bearer ${appToken}` });
      const credential = validateFacebookToken(debug, o.appId!, now(), attempt.asset_id);
      // A system-user token already proved the selected asset through granular_scopes.
      // For a USER token, /me/accounts proves management of the Page-linked IG asset, not just knowledge of its ID.
      let url: string | undefined = credential.kind === 'facebook-user' ? `${base}/me/accounts?fields=id,instagram_business_account&limit=100` : undefined;
      let owned = credential.kind === 'facebook-system-user';
      const seen = new Set<string>();
      while (url && !owned) {
        if (seen.has(url) || seen.size >= 100) throw new Error('invalid paging');
        seen.add(url);
        const u = new URL(url);
        if (u.origin !== 'https://graph.facebook.com' || u.pathname !== new URL(`${base}/me/accounts`).pathname) throw new Error('unsafe paging');
        const page: { data?: { id?: string; instagram_business_account?: { id?: string } }[]; paging?: { next?: string } } = await getJson(get, url, 'Facebook assets', [token], { Authorization: `Bearer ${token}` });
        if (!Array.isArray(page.data)) throw new Error('invalid asset response');
        owned = page.data.some(p => p.id && p.instagram_business_account?.id === attempt.asset_id);
        url = page.paging?.next;
      }
      if (!owned) throw new Error('asset not selected or not managed');
      const profile = await getJson<{ id?: string; username?: string }>(get, `${base}/${attempt.asset_id}?fields=id,username`, 'Instagram asset', [token], { Authorization: `Bearer ${token}` });
      if (profile.id !== attempt.asset_id || profile.username?.toLowerCase() !== attempt.account) throw new Error('account mapping mismatch');
      await saveToken('instagram', attempt.account, token, o.encKey, { tokenKind: credential.kind, assetId: attempt.asset_id, expiresAt: credential.expiresAt, refreshedAt: new Date(now()) });
      res.redirect(303, '/socials/ig/auth/complete');
    } catch {
      res.status(400).type('text').send('Instagram connection failed. Restart connect from the authenticated app; verify configuration, permissions, token type and selected asset.');
    }
  });
  return { start, callback };
}
