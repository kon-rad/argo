/**
 * The shape every platform (LinkedIn first, then X/YouTube/Instagram/Facebook)
 * implements so routes.ts and scheduler.ts never branch on provider name.
 * See Projects/secondbrain-app/social-linkedin-plan.md in the vault.
 */

export type ProviderName = 'linkedin' | 'x' | 'youtube' | 'instagram' | 'facebook';

/** 'direct': the network's own API. 'buffer': relayed through the owner's Buffer account. */
export type Transport = 'direct' | 'buffer';

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
  transport: Transport;
  providerAccountId: string;
  displayName: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

export type ImageType = 'image/jpeg' | 'image/png' | 'image/gif';
export type VideoType = 'video/mp4' | 'video/quicktime';

/** One image or video attached to a post, bytes included (social_post_media). */
export interface PostMedia {
  filename: string;
  contentType: ImageType | VideoType;
  bytes: Buffer;
  /** Required on images; networks take none on a video, so it may be empty there. */
  altText: string;
  /** Set by the scheduler for relayed posts: the public URL the relay fetches the file from. */
  publicUrl?: string;
}

export function isVideo(m: Pick<PostMedia, 'contentType'>): boolean {
  return m.contentType.startsWith('video/');
}

/**
 * Per-network settings on a post (social_posts.options). Every field is
 * optional here; social/rules.ts says which a network requires.
 */
export interface PostOptions {
  /** Instagram: the post type; defaults to reel for a video, post otherwise. */
  instagramType?: 'post' | 'reel' | 'story';
  /** Instagram: also show a reel on the profile grid (default true). */
  shareToFeed?: boolean;
  /** Instagram (and LinkedIn through a relay): a first comment. */
  firstComment?: string;
  /** YouTube: the video's title (required, 100 characters at most); the post body is its description. */
  title?: string;
  /** YouTube category id; defaults to 28 (Science & Technology). */
  categoryId?: string;
  /** YouTube privacy, as the relay names it (e.g. public, unlisted, private); the relay's default if unset. */
  privacy?: string;
  madeForKids?: boolean;
  notifySubscribers?: boolean;
  /** X: the posts after the first one, in order; the post body is the first. */
  thread?: string[];
  /** Disclose AI-generated content where the network supports it. */
  aiGenerated?: boolean;
}

/** A row from social_posts with its images in order, ready to publish. */
export interface QueuedPost {
  id: number;
  accountId: number;
  body: string;
  media: PostMedia[];
  options: PostOptions;
  attemptCount: number;
}

export interface PublishResult {
  remoteId: string;
  url?: string;
  /** A relay accepted the post but the network hasn't confirmed it yet; `status()` resolves it later. */
  pending?: boolean;
}

/** What a relay says about a post it accepted. */
export type RelayStatus =
  | { state: 'pending' }
  | { state: 'sent'; url?: string }
  | { state: 'error'; message: string };

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
  /** Relays only: where a post they accepted (`pending`) stands now. */
  status?(account: StoredAccount, remoteId: string): Promise<RelayStatus>;
}
