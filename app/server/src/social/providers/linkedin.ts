import { HttpError } from '../../routes/http.js';
import type { ConnectedAccount, PublishResult, QueuedPost, SocialProvider, StoredAccount, TokenPair } from './types.js';
import { NoRefreshTokenError } from './types.js';

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
const POSTS_URL = 'https://api.linkedin.com/rest/posts';
// LinkedIn versions the Posts/Images API by calendar month. Bump when LinkedIn
// sunsets this version (see the migration guide linked from the design doc).
const LINKEDIN_VERSION = '202510';
const SCOPES = 'openid profile w_member_social';

export interface LinkedInOptions {
  clientId: string;
  clientSecret: string;
  /** Overridden in tests so no real HTTP call is made. */
  fetchFn?: typeof fetch;
}

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

interface UserInfoResponse {
  sub: string;
  name?: string;
}

function expiresAt(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

export function linkedinProvider(opts: LinkedInOptions, now: () => Date = () => new Date()): SocialProvider {
  const f = opts.fetchFn ?? fetch;

  async function tokenRequest(body: Record<string, string>): Promise<AccessTokenResponse> {
    const res = await f(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: opts.clientId, client_secret: opts.clientSecret, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(502, `linkedin token request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    return res.json() as Promise<AccessTokenResponse>;
  }

  return {
    id: 'linkedin',

    authUrl(state, redirectUri) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: opts.clientId,
        redirect_uri: redirectUri,
        state,
        scope: SCOPES,
      });
      return `${AUTH_URL}?${params.toString()}`;
    },

    async exchangeCode(code, redirectUri): Promise<ConnectedAccount> {
      const t = now();
      const token = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });

      const userRes = await f(USERINFO_URL, {
        headers: { authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!userRes.ok) throw new HttpError(502, `linkedin userinfo failed: HTTP ${userRes.status}`);
      const user = (await userRes.json()) as UserInfoResponse;

      return {
        providerAccountId: `urn:li:person:${user.sub}`,
        displayName: user.name ?? user.sub,
        tokens: {
          accessToken: token.access_token,
          accessTokenExpiresAt: expiresAt(t, token.expires_in),
          // Absent, not an error: a standard app gets no refresh token without
          // LinkedIn's Marketing Developer Platform approval (see design doc §1).
          refreshToken: token.refresh_token ?? null,
          refreshTokenExpiresAt: token.refresh_token && token.refresh_token_expires_in ? expiresAt(t, token.refresh_token_expires_in) : null,
        },
      };
    },

    async refresh(account: StoredAccount): Promise<TokenPair> {
      if (!account.refreshToken) throw new NoRefreshTokenError('linkedin');
      const t = now();
      const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refreshToken });
      return {
        accessToken: token.access_token,
        accessTokenExpiresAt: expiresAt(t, token.expires_in),
        refreshToken: token.refresh_token ?? account.refreshToken,
        refreshTokenExpiresAt: token.refresh_token && token.refresh_token_expires_in ? expiresAt(t, token.refresh_token_expires_in) : account.refreshTokenExpiresAt,
      };
    },

    async publish(account: StoredAccount, post: QueuedPost): Promise<PublishResult> {
      if (post.mediaPaths.length > 0) {
        // Image/video upload is a separate build step (design doc §7, step 8).
        throw new HttpError(501, 'linkedin: posts with media are not supported yet');
      }
      const res = await f(POSTS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${account.accessToken}`,
          'content-type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0',
          'Linkedin-Version': LINKEDIN_VERSION,
        },
        body: JSON.stringify({
          author: account.providerAccountId,
          commentary: post.body,
          visibility: 'PUBLIC',
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HttpError(502, `linkedin publish failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      }
      // The Posts API returns the new post's id in the x-restli-id header, not the body.
      const remoteId = res.headers.get('x-restli-id') ?? res.headers.get('X-RestLi-Id') ?? '';
      if (!remoteId) throw new HttpError(502, 'linkedin publish succeeded but returned no post id');
      return { remoteId, url: `https://www.linkedin.com/feed/update/${remoteId}/` };
    },
  };
}
