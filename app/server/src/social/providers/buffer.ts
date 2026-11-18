import { HttpError } from '../../routes/http.js';
import type { PostMedia, PostOptions, ProviderName, PublishResult, QueuedPost, RelayStatus, SocialProvider, StoredAccount } from './types.js';
import { isVideo } from './types.js';

// Buffer as a relay: one personal API key (env) reaches every channel the
// owner connected in Buffer, so there is no OAuth here. Each Buffer channel is
// its own social_accounts row (transport 'buffer', provider_account_id = the
// channel id). Buffer has no upload: media go as public URLs the scheduler
// mints (social_post_media.public_token), fetched by Buffer at publish time.
// API: GraphQL at api.buffer.com (developers.buffer.com, schema read 2026-10-20).

const ENDPOINT = 'https://api.buffer.com';
/** YouTube needs a category on create; 28 is Science & Technology. */
const DEFAULT_YOUTUBE_CATEGORY = '28';

export interface BufferOptions {
  apiKey: string;
  /** Overridden in tests so no real HTTP call is made. */
  fetchFn?: typeof fetch;
  endpoint?: string;
}

/** Buffer's service names for the networks we relay; the rest are listed but not connected. */
const SERVICE_TO_PROVIDER: Record<string, ProviderName> = { instagram: 'instagram', twitter: 'x', youtube: 'youtube' };

export interface BufferChannel {
  id: string;
  name: string;
  displayName: string | null;
  service: string;
  externalLink: string | null;
  isDisconnected: boolean;
  isLocked: boolean;
  /** The network we post to it as, or null when we don't relay that service. */
  provider: ProviderName | null;
}

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

interface RemotePost {
  id: string;
  status: string;
  externalLink: string | null;
  error: { message: string } | null;
}

interface CreatePostData {
  createPost: { __typename: string; post?: RemotePost; message?: string };
}

const POST_FIELDS = 'id status externalLink error { message }';

/** The `metadata` input for one network, from the post's options. */
export function bufferMetadata(provider: ProviderName, post: Pick<QueuedPost, 'body' | 'media' | 'options'>): Record<string, unknown> | undefined {
  const o = post.options;
  const ai = o.aiGenerated === undefined ? {} : { isAiGenerated: o.aiGenerated };
  switch (provider) {
    case 'instagram':
      return {
        instagram: {
          type: o.instagramType ?? (post.media.some(isVideo) ? 'reel' : 'post'),
          shouldShareToFeed: o.shareToFeed ?? true,
          ...(o.firstComment ? { firstComment: o.firstComment } : {}),
          ...ai,
        },
      };
    case 'youtube':
      return {
        youtube: {
          title: o.title,
          categoryId: o.categoryId ?? DEFAULT_YOUTUBE_CATEGORY,
          madeForKids: o.madeForKids ?? false,
          notifySubscribers: o.notifySubscribers ?? true,
          ...(o.privacy ? { privacy: o.privacy } : {}),
          ...ai,
        },
      };
    case 'x':
      // Buffer's thread array is the whole thread, first post included (the body).
      if (!o.thread?.length && o.aiGenerated === undefined) return undefined;
      return {
        twitter: {
          ...(o.thread?.length ? { thread: [post.body, ...o.thread].map((text) => ({ text, assets: [] })) } : {}),
          ...ai,
        },
      };
    default:
      return undefined;
  }
}

/**
 * One asset by public URL. A video's cover can't be an uploaded image (Buffer rejects
 * `thumbnailUrl`); `metadata.thumbnailOffset` picks a frame instead, on Instagram only.
 */
export function asset(m: PostMedia, provider: ProviderName, options: Pick<PostOptions, 'title' | 'coverAt'>): Record<string, unknown> {
  if (!m.publicUrl) throw new HttpError(500, `${m.filename} has no public URL; the scheduler mints one before a relay publishes`);
  if (isVideo(m)) {
    const metadata = {
      ...(provider === 'youtube' && options.title ? { title: options.title } : {}),
      ...(provider === 'instagram' && options.coverAt !== undefined ? { thumbnailOffset: Math.round(options.coverAt * 1000) } : {}),
    };
    return { video: { url: m.publicUrl, ...(Object.keys(metadata).length ? { metadata } : {}) } };
  }
  return { image: { url: m.publicUrl } };
}

function toStatus(p: RemotePost): RelayStatus {
  if (p.status === 'sent') return { state: 'sent', url: p.externalLink ?? undefined };
  if (p.status === 'error') return { state: 'error', message: `buffer: ${p.error?.message ?? 'publishing failed'}` };
  return { state: 'pending' };
}

export function bufferProvider(opts: BufferOptions): SocialProvider & { listChannels(): Promise<BufferChannel[]> } {
  const f = opts.fetchFn ?? fetch;
  const endpoint = opts.endpoint ?? ENDPOINT;

  async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await f(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429) {
      throw new HttpError(429, `buffer rate limit reached; retry after ${res.headers.get('retry-after') ?? '?'} s`);
    }
    if (!res.ok) throw new HttpError(502, `buffer: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as GqlResponse<T>;
    if (body.errors?.length) throw new HttpError(502, `buffer: ${body.errors.map((e) => e.message).join('; ')}`);
    if (!body.data) throw new HttpError(502, 'buffer: empty response');
    return body.data;
  }

  return {
    id: 'x', // unused: the scheduler picks this provider by transport, not by name

    authUrl() {
      throw new HttpError(400, 'Buffer channels connect with `cli-social connect-buffer`, not OAuth');
    },
    async exchangeCode() {
      throw new HttpError(400, 'Buffer channels connect with `cli-social connect-buffer`, not OAuth');
    },
    async refresh(account: StoredAccount) {
      // The key lives in env and doesn't expire; the row's token is a placeholder.
      return {
        accessToken: account.accessToken,
        accessTokenExpiresAt: account.accessTokenExpiresAt,
        refreshToken: account.refreshToken,
        refreshTokenExpiresAt: account.refreshTokenExpiresAt,
      };
    },

    async publish(account: StoredAccount, post: QueuedPost): Promise<PublishResult> {
      const metadata = bufferMetadata(account.provider, post);
      const input = {
        channelId: account.providerAccountId,
        text: post.body,
        schedulingType: 'automatic',
        // Our queue keeps the schedule; Buffer gets the post at the due minute.
        mode: 'shareNow',
        needsApproval: false,
        source: 'secondbrain',
        assets: post.media.map((m) => asset(m, account.provider, post.options)),
        ...(metadata ? { metadata } : {}),
      };
      const data = await gql<CreatePostData>(
        `mutation CreatePost($input: CreatePostInput!) {
          createPost(input: $input) {
            __typename
            ... on PostActionSuccess { post { ${POST_FIELDS} } }
            ... on MutationError { message }
          }
        }`,
        { input },
      );
      const r = data.createPost;
      if (!r.post) throw new HttpError(400, `buffer refused the post: ${r.message ?? r.__typename}`);
      const status = toStatus(r.post);
      if (status.state === 'error') throw new HttpError(502, status.message);
      return { remoteId: r.post.id, url: status.state === 'sent' ? status.url : undefined, pending: status.state !== 'sent' };
    },

    async status(_account: StoredAccount, remoteId: string): Promise<RelayStatus> {
      const data = await gql<{ post: RemotePost | null }>(
        `query Post($id: PostId!) { post(input: { id: $id }) { ${POST_FIELDS} } }`,
        { id: remoteId },
      );
      if (!data.post) return { state: 'error', message: `buffer: post ${remoteId} not found (deleted in Buffer?)` };
      return toStatus(data.post);
    },

    async listChannels(): Promise<BufferChannel[]> {
      const { account } = await gql<{ account: { organizations: { id: string }[] } }>(`{ account { organizations { id } } }`);
      const out: BufferChannel[] = [];
      for (const org of account.organizations) {
        const { channels } = await gql<{ channels: Omit<BufferChannel, 'provider'>[] }>(
          `query Channels($org: OrganizationId!) {
            channels(input: { organizationId: $org }) { id name displayName service externalLink isDisconnected isLocked }
          }`,
          { org: org.id },
        );
        for (const c of channels) out.push({ ...c, provider: SERVICE_TO_PROVIDER[c.service] ?? null });
      }
      return out;
    },
  };
}
