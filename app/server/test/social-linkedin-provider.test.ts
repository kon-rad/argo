import { describe, expect, it } from 'vitest';
import { linkedinProvider } from '../src/social/providers/linkedin.js';
import { NoRefreshTokenError } from '../src/social/providers/types.js';

const T0 = new Date('2026-10-18T00:00:00Z');
const OPTS = { clientId: 'client123', clientSecret: 'secret456' };

function fakeFetch(handlers: Record<string, (req: Request | string) => Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    for (const [match, handler] of Object.entries(handlers)) {
      if (url.includes(match)) return handler(init?.body ? String(init.body) : url);
    }
    throw new Error(`unhandled fetch: ${url}`);
  }) as typeof fetch;
}

describe('linkedinProvider.authUrl', () => {
  it('builds a consent URL with the open-permission scopes', () => {
    const provider = linkedinProvider(OPTS);
    const url = provider.authUrl('state123', 'https://brain.example.com/api/social/accounts/linkedin/callback');
    expect(url).toMatch(/^https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization\?/);
    expect(url).toContain('client_id=client123');
    expect(url).toContain('state=state123');
    expect(url).toContain(encodeURIComponent('w_member_social'));
  });
});

describe('linkedinProvider.exchangeCode', () => {
  it('exchanges the code, reads userinfo, and reports no refresh token when LinkedIn gives none', async () => {
    const f = fakeFetch({
      'oauth/v2/accessToken': () => Response.json({ access_token: 'AQAtoken', expires_in: 5_184_000 }),
      'v2/userinfo': () => Response.json({ sub: 'abc123', name: 'Konrad Gnat' }),
    });
    const provider = linkedinProvider({ ...OPTS, fetchFn: f }, () => T0);
    const account = await provider.exchangeCode('authcode', 'https://x/callback');
    expect(account).toEqual({
      providerAccountId: 'urn:li:person:abc123',
      displayName: 'Konrad Gnat',
      tokens: {
        accessToken: 'AQAtoken',
        accessTokenExpiresAt: new Date(T0.getTime() + 5_184_000_000),
        refreshToken: null,
        refreshTokenExpiresAt: null,
      },
    });
  });

  it('captures a refresh token when an MDP-approved app returns one', async () => {
    const f = fakeFetch({
      'oauth/v2/accessToken': () =>
        Response.json({ access_token: 'AQAtoken', expires_in: 5_184_000, refresh_token: 'refresh1', refresh_token_expires_in: 31_536_000 }),
      'v2/userinfo': () => Response.json({ sub: 'abc123', name: 'Konrad Gnat' }),
    });
    const provider = linkedinProvider({ ...OPTS, fetchFn: f }, () => T0);
    const account = await provider.exchangeCode('authcode', 'https://x/callback');
    expect(account.tokens.refreshToken).toBe('refresh1');
    expect(account.tokens.refreshTokenExpiresAt).toEqual(new Date(T0.getTime() + 31_536_000_000));
  });
});

describe('linkedinProvider.refresh', () => {
  it('throws NoRefreshTokenError when the stored account has none', async () => {
    const provider = linkedinProvider(OPTS);
    const account = {
      id: 1, provider: 'linkedin' as const, providerAccountId: 'urn:li:person:abc123', displayName: 'Konrad',
      accessToken: 'old', accessTokenExpiresAt: T0, refreshToken: null, refreshTokenExpiresAt: null,
    };
    await expect(provider.refresh(account)).rejects.toThrow(NoRefreshTokenError);
  });

  it('exchanges a refresh token for a new access token', async () => {
    const f = fakeFetch({ 'oauth/v2/accessToken': () => Response.json({ access_token: 'newtoken', expires_in: 5_184_000 }) });
    const provider = linkedinProvider({ ...OPTS, fetchFn: f }, () => T0);
    const account = {
      id: 1, provider: 'linkedin' as const, providerAccountId: 'urn:li:person:abc123', displayName: 'Konrad',
      accessToken: 'old', accessTokenExpiresAt: T0, refreshToken: 'refresh1', refreshTokenExpiresAt: new Date(T0.getTime() + 1e9),
    };
    const tokens = await provider.refresh(account);
    expect(tokens.accessToken).toBe('newtoken');
    expect(tokens.refreshToken).toBe('refresh1'); // kept when LinkedIn doesn't rotate it
  });
});

describe('linkedinProvider.publish', () => {
  const account = {
    id: 1, provider: 'linkedin' as const, providerAccountId: 'urn:li:person:abc123', displayName: 'Konrad',
    accessToken: 'tok', accessTokenExpiresAt: T0, refreshToken: null, refreshTokenExpiresAt: null,
  };

  it('posts text-only content and reads the new post id from the x-restli-id header', async () => {
    const f = (async () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:999' } })) as typeof fetch;
    const provider = linkedinProvider({ ...OPTS, fetchFn: f });
    const result = await provider.publish(account, { id: 1, accountId: 1, body: 'Hello LinkedIn', media: [], attemptCount: 0 });
    expect(result).toEqual({ remoteId: 'urn:li:share:999', url: 'https://www.linkedin.com/feed/update/urn:li:share:999/' });
  });

  it('surfaces a non-2xx response as an error', async () => {
    const f = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const provider = linkedinProvider({ ...OPTS, fetchFn: f });
    await expect(provider.publish(account, { id: 1, accountId: 1, body: 'x', media: [], attemptCount: 0 })).rejects.toThrow(/HTTP 429/);
  });
});
