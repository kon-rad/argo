import { describe, expect, it } from 'vitest';
import { validateFacebookToken, validateFacebookUserToken } from '../src/metrics/social/facebook-token.js';
import { ApiError, chunks, count, getJson, redact } from '../src/metrics/social/http.js';

const now = 1_700_000_000_000;
const requiredUserScopes = [
  'instagram_basic',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
];
const user = {
  data: {
    is_valid: true,
    app_id: 'fixture-app',
    type: 'USER',
    user_id: 'fixture-user',
    expires_at: now / 1000 + 3600,
    scopes: requiredUserScopes,
  },
};

const systemUser = {
  data: {
    is_valid: true,
    app_id: 'fixture-app',
    type: 'SYSTEM_USER',
    user_id: 'fixture-system-user',
    expires_at: 0,
    scopes: ['instagram_basic', 'instagram_manage_insights'],
    granular_scopes: [
      { scope: 'instagram_basic', target_ids: ['asset-one'] },
      { scope: 'instagram_manage_insights', target_ids: ['asset-one', 'asset-two'] },
    ],
  },
};

describe('Facebook Unified token contract', () => {
  it('accepts a USER token and bounds it by token and data-access expiry', () => {
    expect(validateFacebookToken(user, 'fixture-app', now, 'asset-one')).toEqual({
      kind: 'facebook-user',
      expiresAt: new Date(now + 3_600_000),
    });
    expect(validateFacebookUserToken({
      data: { ...user.data, data_access_expires_at: now / 1000 + 60 },
    }, 'fixture-app', now).expiresAt).toEqual(new Date(now + 60_000));
    expect(validateFacebookUserToken({
      data: { ...user.data, data_access_expires_at: 0 },
    }, 'fixture-app', now).expiresAt).toEqual(new Date(now + 3_600_000));
  });

  it.each([
    ['missing response', {}],
    ['null data', { data: null }],
    ['invalid flag', { data: { ...user.data, is_valid: false } }],
    ['wrong app', { data: { ...user.data, app_id: 'other-app' } }],
    ['empty app identity', { data: { ...user.data, app_id: '' } }],
    ['empty user', { data: { ...user.data, user_id: '' } }],
    ['missing grant', { data: { ...user.data, scopes: requiredUserScopes.slice(1) } }],
    ['legacy grants', { data: { ...user.data, scopes: ['instagram_business_basic', 'instagram_business_manage_insights'] } }],
    ['zero token expiry', { data: { ...user.data, expires_at: 0 } }],
    ['expired token', { data: { ...user.data, expires_at: 1 } }],
    ['nonfinite token expiry', { data: { ...user.data, expires_at: Infinity } }],
    ['string token expiry', { data: { ...user.data, expires_at: '99999999999' } }],
    ['expired data access', { data: { ...user.data, data_access_expires_at: 1 } }],
    ['nonfinite data access', { data: { ...user.data, data_access_expires_at: Infinity } }],
  ])('refuses USER token: %s', (_name, input) => {
    expect(() => validateFacebookUserToken(input, 'fixture-app', now)).toThrow();
  });

  it.each([NaN, Infinity, -Infinity, 8.64e15 + 1])('refuses USER token with invalid clock: %s', (invalidNow) => {
    expect(() => validateFacebookToken({
      data: { ...user.data, expires_at: 1 },
    }, 'fixture-app', invalidNow, 'asset-one')).toThrow();
  });

  it('accepts SYSTEM_USER only when every required grant includes the intended asset', () => {
    expect(validateFacebookToken(systemUser, 'fixture-app', now, 'asset-one')).toEqual({
      kind: 'facebook-system-user',
      expiresAt: null,
    });
    expect(validateFacebookToken({
      data: { ...systemUser.data, data_access_expires_at: now / 1000 + 60 },
    }, 'fixture-app', now, 'asset-one')).toEqual({
      kind: 'facebook-system-user',
      expiresAt: new Date(now + 60_000),
    });
    expect(validateFacebookToken({
      data: {
        ...systemUser.data,
        expires_at: now / 1000 + 120,
        data_access_expires_at: now / 1000 + 60,
      },
    }, 'fixture-app', now, 'asset-one')).toEqual({
      kind: 'facebook-system-user',
      expiresAt: new Date(now + 60_000),
    });
  });

  it.each([
    ['cross-account asset', 'asset-two', {}],
    ['missing target ids', 'asset-one', { granular_scopes: [
      { scope: 'instagram_basic' },
      { scope: 'instagram_manage_insights' },
    ] }],
    ['missing basic asset grant', 'asset-one', { granular_scopes: [
      { scope: 'instagram_basic', target_ids: ['asset-two'] },
      { scope: 'instagram_manage_insights', target_ids: ['asset-one'] },
    ] }],
    ['missing insights asset grant', 'asset-one', { granular_scopes: [
      { scope: 'instagram_basic', target_ids: ['asset-one'] },
      { scope: 'instagram_manage_insights', target_ids: ['asset-two'] },
    ] }],
    ['absent granular grants', 'asset-one', { granular_scopes: undefined }],
    ['missing required scope', 'asset-one', { scopes: ['instagram_basic'] }],
    ['wrong app', 'asset-one', { app_id: 'other-app' }],
    ['empty app identity', 'asset-one', { app_id: '' }],
    ['invalid flag', 'asset-one', { is_valid: false }],
    ['expired token', 'asset-one', { expires_at: 1 }],
    ['expired data access', 'asset-one', { data_access_expires_at: 1 }],
    ['nonfinite token expiry', 'asset-one', { expires_at: Infinity }],
    ['nonfinite data access', 'asset-one', { data_access_expires_at: Infinity }],
    ['PAGE token', 'asset-one', { type: 'PAGE' }],
    ['APP token', 'asset-one', { type: 'APP' }],
    ['unknown token', 'asset-one', { type: 'BUSINESS_INTEGRATION' }],
  ] as const)('refuses SYSTEM_USER token: %s', (_name, assetId, patch) => {
    expect(() => validateFacebookToken({
      data: { ...systemUser.data, ...patch },
    }, 'fixture-app', now, assetId)).toThrow();
  });

  it.each([NaN, Infinity, -Infinity, 8.64e15 + 1])('refuses SYSTEM_USER token with invalid clock: %s', (invalidNow) => {
    expect(() => validateFacebookToken({
      data: { ...systemUser.data, expires_at: 1 },
    }, 'fixture-app', invalidNow, 'asset-one')).toThrow();
  });
});

describe('shared social HTTP helpers', () => {
  it('redacts authorization codes, input tokens, explicit secrets, and repeated values', () => {
    const output = redact(
      'callback?code=secret%2Dcode&input_token=secret-token&client_secret=secret-app '
        + 'repeat secret-code secret-token secret-app header-secret',
      ['header-secret'],
    );
    for (const secret of ['secret%2Dcode', 'secret-code', 'secret-token', 'secret-app', 'header-secret']) {
      expect(output).not.toContain(secret);
    }
  });

  it('does not leak query or repeated secret values through API errors', async () => {
    const get = async () => {
      throw new Error('request failed: ?code=authorization-code repeat authorization-code');
    };
    await expect(getJson(get, 'https://graph.example.test', 'debug token', [])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as Error).message).not.toContain('authorization-code');
      return true;
    });
  });

  it.each([
    ['code', 'a'],
    ['code', 'ab'],
    ['code', 'abc'],
    ['input_token', 'a'],
    ['input_token', 'ab'],
    ['input_token', 'abc'],
  ])('redacts short %s values wherever repeated: %s', async (parameter, secret) => {
    const message = `error: ?${parameter}=${secret}&echo=${secret}`;
    expect(redact(message)).toBe(`error: ?${parameter}=[redacted]&echo=[redacted]`);

    const get = async () => { throw new Error(message); };
    await expect(getJson(get, 'https://graph.example.test', 'debug token', [])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as Error).message)
        .toBe(`debug token: error: ?${parameter}=[redacted]&echo=[redacted]`);
      return true;
    });
  });

  it('leaves empty secret parameters empty without replacing unrelated text', () => {
    expect(redact('callback?code=&input_token=&echo=visible')).toBe('callback?code=&input_token=&echo=visible');
  });

  it('preserves legacy redaction and utility behavior', () => {
    expect(redact('GET /a?access_token=legacy-secret&key=api-key repeat legacy-secret', ['header-secret']))
      .toBe('GET /a?access_token=[redacted]&key=[redacted] repeat [redacted]');
    expect(count('36')).toBe(36);
    expect(count('not-a-number')).toBeNull();
    expect(chunks([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
});
