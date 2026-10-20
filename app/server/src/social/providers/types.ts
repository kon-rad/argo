/**
 * The shape every platform (LinkedIn first, then X/YouTube/Instagram/Facebook)
 * implements so routes.ts and scheduler.ts never branch on provider name.
 * See Projects/secondbrain-app/social-linkedin-plan.md in the vault.
 */

export type ProviderName = 'linkedin' | 'x' | 'youtube' | 'instagram' | 'facebook';

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: Date;
  /** null is a valid, expected state (e.g. LinkedIn without Marketing Developer Platform approval). */
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

export interface ConnectedAccount {
  providerAccountId: string;
  displayName: string;
  tokens: TokenPair;
}

/** A row from social_accounts with tokens already decrypted. */
export interface StoredAccount {
  id: number;
  provider: ProviderName;
  providerAccountId: string;
  displayName: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

/** One image attached to a post, bytes included (social_post_media). */
export interface PostMedia {
  filename: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/gif';
  bytes: Buffer;
  altText: string;
}

/** A row from social_posts with its images in order, ready to publish. */
export interface QueuedPost {
  id: number;
  accountId: number;
  body: string;
  media: PostMedia[];
  attemptCount: number;
}

export interface PublishResult {
  remoteId: string;
  url?: string;
}

/** Thrown by `refresh()` when the provider issued no refresh token for this account. */
export class NoRefreshTokenError extends Error {
  constructor(provider: ProviderName) {
    super(`${provider} issued no refresh token for this account; it must be reauthorized manually`);
  }
}

export interface SocialProvider {
  readonly id: ProviderName;
  /** Build the OAuth consent URL the user is redirected to. */
  authUrl(state: string, redirectUri: string): string;
  /** Exchange the callback's authorization code for tokens and the account's own id/name. */
  exchangeCode(code: string, redirectUri: string): Promise<ConnectedAccount>;
  /** Refresh if the provider supports it for this account; throws NoRefreshTokenError if not. */
  refresh(account: StoredAccount): Promise<TokenPair>;
  /** Publish one post; returns the provider's post id (and URL, if it has one). */
  publish(account: StoredAccount, post: QueuedPost): Promise<PublishResult>;
}
