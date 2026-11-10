import { expect, it } from 'vitest';
import { validateFacebookUserToken } from '../src/metrics/social/facebook-token.js';
import { redact } from '../src/metrics/social/http.js';
const now = 1_700_000_000_000;
const valid = { data: { is_valid: true, app_id: 'fake-app', type: 'USER', user_id: '301', expires_at: now / 1000 + 3600, scopes: ['instagram_basic', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement'] } };
it('bounds credential lifetime by token and data access expiry', () => {
  expect(validateFacebookUserToken(valid, 'fake-app', now).expiresAt.getTime()).toBe(now + 3600000);
  expect(validateFacebookUserToken({ data: { ...valid.data, data_access_expires_at: now / 1000 + 60 } }, 'fake-app', now).expiresAt.getTime()).toBe(now + 60000);
});
it.each([
  {}, { data: null }, { data: [] },
  ...[{ is_valid: false }, { app_id: 'other-app' }, { type: 'SYSTEM_USER' }, { type: 'PAGE' }, { type: 'UNKNOWN' }, { user_id: '' }, { expires_at: 0 }, { expires_at: 1 }, { expires_at: Infinity }, { expires_at: '99999999999' }, { scopes: [] }, { scopes: ['instagram_business_basic', 'instagram_business_manage_insights'] }, { data_access_expires_at: 1 }, { data_access_expires_at: 'invalid' }].map(patch => ({ data: { ...valid.data, ...patch } })),
])('refuses invalid or unsupported token contract %#', input => {
  expect(() => validateFacebookUserToken(input, 'fake-app', now)).toThrow();
});
it('redacts authorization codes, app secrets, debug tokens and their repeated values', () => {
  const message = redact('https://graph.example/callback?code=secret-code&input_token=secret-token&client_secret=secret-app repeat secret-code secret-token secret-app');
  expect(message).not.toContain('secret-code'); expect(message).not.toContain('secret-token'); expect(message).not.toContain('secret-app');
});
