import { HttpError } from '../../routes/http.js';
import type { ConnectedAccount, PostMedia, PublishResult, QueuedPost, SocialProvider, StoredAccount, TokenPair } from './types.js';
import { NoRefreshTokenError } from './types.js';

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
const POSTS_URL = 'https://api.linkedin.com/rest/posts';
const IMAGES_URL = 'https://api.linkedin.com/rest/images';
// LinkedIn versions the Posts/Images API by calendar month. Bump when LinkedIn
// sunsets this version (see the migration guide linked from the design doc).
const LINKEDIN_VERSION = '202610';
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

interface InitializeUploadResponse {
  value: { uploadUrl: string; image: string };
}

interface UserInfoResponse {
  sub: string;
  name?: string;
}

// "little" text format: the Posts API reads these characters as markup and
// drops or truncates text at an unescaped one, so commentary is escaped. A
// #word after whitespace stays a real hashtag via the hashtag template.
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
const LITTLE = /(?<![^\s])#([\p{L}\p{N}_]+)|[\\|{}@[\]()<>#*_~]/gu;

export function toLittleText(text: string): string {
  return text.replace(LITTLE, (m: string, tag: string | undefined) =>
    tag !== undefined ? `{hashtag|\\#|${tag.replace(/_/g, '\\_')}}` : `\\${m}`,
  );
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

  function restHeaders(account: StoredAccount): Record<string, string> {
    return {
      authorization: `Bearer ${account.accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'Linkedin-Version': LINKEDIN_VERSION,
    };
  }

  async function failed(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    throw new HttpError(502, `linkedin ${what} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  /**
   * Images API: reserve an upload slot, then PUT the bytes to it. Returns the
   * image URN the post refers to. A failure throws before any post is created,
   * so a post never goes out without its image; the next attempt uploads again
   * (an unused upload is simply never attached to anything).
   */
  async function uploadImage(account: StoredAccount, media: PostMedia): Promise<string> {
    const init = await f(`${IMAGES_URL}?action=initializeUpload`, {
      method: 'POST',
      headers: { ...restHeaders(account), 'content-type': 'application/json' },
      body: JSON.stringify({ initializeUploadRequest: { owner: account.providerAccountId } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!init.ok) await failed(init, `image upload init for ${media.filename}`);
    const { value } = (await init.json()) as InitializeUploadResponse;
    if (!value?.uploadUrl || !value?.image) throw new HttpError(502, `linkedin image upload init for ${media.filename} returned no upload URL`);

    const put = await f(value.uploadUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${account.accessToken}`, 'content-type': media.contentType },
      body: new Uint8Array(media.bytes),
      signal: AbortSignal.timeout(60_000),
    });
    if (!put.ok) await failed(put, `image upload of ${media.filename}`);
    return value.image;
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
      // Upload in order; one image is `media`, two or more are `multiImage`.
      const images: { id: string; altText: string }[] = [];
      for (const m of post.media) images.push({ id: await uploadImage(account, m), altText: m.altText });
      const content =
        images.length === 1 ? { media: images[0] } : images.length > 1 ? { multiImage: { images } } : undefined;

      const res = await f(POSTS_URL, {
        method: 'POST',
        headers: { ...restHeaders(account), 'content-type': 'application/json' },
        body: JSON.stringify({
          author: account.providerAccountId,
          commentary: toLittleText(post.body),
          visibility: 'PUBLIC',
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
          ...(content ? { content } : {}),
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) await failed(res, 'publish');
      // The Posts API returns the new post's id in the x-restli-id header, not the body.
      const remoteId = res.headers.get('x-restli-id') ?? res.headers.get('X-RestLi-Id') ?? '';
      if (!remoteId) throw new HttpError(502, 'linkedin publish succeeded but returned no post id');
      return { remoteId, url: `https://www.linkedin.com/feed/update/${remoteId}/` };
    },
  };
}
