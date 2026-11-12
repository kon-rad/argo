import { expect, it } from 'vitest';
import { validateFacebookToken, validateFacebookUserToken } from '../src/metrics/social/facebook-token.js';
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

const system = { data: { is_valid: true, app_id: 'fake-app', type: 'SYSTEM_USER', user_id: '501', expires_at: 0, scopes: ['instagram_basic', 'instagram_manage_insights'],
  granular_scopes: [{ scope: 'instagram_basic', target_ids: ['101'] }, { scope: 'instagram_manage_insights', target_ids: ['101', '102'] }] } };
it('accepts a business-integration system-user token only for an explicitly granted asset', () => {
  expect(validateFacebookToken(system, 'fake-app', now, '101')).toEqual({ kind: 'facebook-system-user', expiresAt: null });
  expect(validateFacebookToken({ data: { ...system.data, data_access_expires_at: now / 1000 + 60 } }, 'fake-app', now, '101')).toEqual({ kind: 'facebook-system-user', expiresAt: new Date(now + 60000) });
  expect(validateFacebookToken(valid, 'fake-app', now, '101')).toEqual({ kind: 'facebook-user', expiresAt: new Date(now + 3600000) });
});
it.each([
  ['other asset', '102', {}],
  ['missing target_ids', '101', { granular_scopes: [{ scope: 'instagram_basic' }, { scope: 'instagram_manage_insights' }] }],
  ['missing granular_scopes', '101', { granular_scopes: undefined }],
  ['missing insights scope', '101', { scopes: ['instagram_basic'] }],
  ['other app', '101', { app_id: 'other-app' }],
  ['invalid', '101', { is_valid: false }],
  ['expired', '101', { expires_at: 1 }],
  ['data access expired', '101', { data_access_expires_at: 1 }],
  ['page token', '101', { type: 'PAGE' }],
  ['unknown type', '101', { type: 'BUSINESS_INTEGRATION' }],
] as [string, string, Record<string, unknown>][])('refuses system-user token: %s', (_name, asset, patch) => {
  expect(() => validateFacebookToken({ data: { ...system.data, ...patch } }, 'fake-app', now, asset)).toThrow();
});
