import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { query } from './db.js';
import { settings } from './settings.js';
import { listPosts, type PostRow } from './social/store.js';

/**
 * The media schedule page: a content calendar per brand. A brand's config is a
 * markdown file in the vault (front matter = channels, style guides, tracker
 * projects) so the page and the content skills read the same source. Which
 * brands exist is `media.brands` in secondbrain.json. A brand whose file fails
 * to load becomes an error card; the other brands still render.
 */

const Posting = z.enum(['buffer', 'direct', 'manual']);

export const ChannelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  network: z.string().min(1),
  handle: z.string().optional(),
  /** "verify" means the profile is not confirmed yet: shown without a link. */
  url: z.string().optional(),
  posting: Posting,
  account_id: z.number().int().positive().optional(),
  style_guide: z.string().optional(),
  note: z.string().optional(),
  /** What the channel is for, one line. */
  role: z.string().optional(),
  /** Folder of the channel's files, for manual channels. */
  files: z.string().optional(),
  status: z.string().optional(),
});

export const BrandFileSchema = z.object({
  brand: z.string().min(1),
  name: z.string().min(1),
  tracker_projects: z.array(z.string()).default([]),
  style_guides: z.array(z.string()).default([]),
  channels: z.array(ChannelSchema).default([]),
});

export type Channel = z.infer<typeof ChannelSchema>;

export interface AccountHealth {
  state: 'connected' | 'disconnected' | 'missing';
  /** Days until the access token expires; null for a Buffer channel (the key is env). */
  tokenExpiresInDays: number | null;
  provider: string | null;
  transport: string | null;
}

export interface ChannelView extends Omit<Channel, 'url'> {
  url: string | null;
  urlUnconfirmed: boolean;
  account: AccountHealth | null;
  /** In the requested range. */
  counts: { draft: number; queued: number; posted: number; failed: number };
  styleGuideMissing: boolean;
}

export interface BrandView {
  slug: string;
  name: string;
  config: string;
  trackerProjects: string[];
  styleGuides: { path: string; missing: boolean }[];
  channels: ChannelView[];
  warnings: string[];
}

export interface BrandError {
  slug: string;
  config: string;
  error: { file: string; line: number | null; message: string };
}

export type BrandResult = ({ ok: true } & BrandView) | ({ ok: false } & BrandError);

/** A vault-relative path with no leading slash and no `..`, or null. */
export function safeVaultPath(rel: string): string | null {
  const clean = normalize(rel).replace(/^\/+/, '');
  return clean.startsWith('..') || clean === '.' || rel.startsWith('/') ? null : clean;
}

function yamlLine(err: unknown): number | null {
  const mark = (err as { mark?: { line?: number } }).mark;
  return typeof mark?.line === 'number' ? mark.line + 1 : null;
}

const fail = (slug: string, config: string, message: string, line: number | null = null): BrandResult => ({
  ok: false, slug, config, error: { file: config, line, message },
});

/** Parses one brand file against the vault and the connected accounts; `claimed` carries account ids taken by earlier brands. */
export function loadBrand(
  vaultRoot: string,
  slug: string,
  config: string,
  accountIds: ReadonlySet<number>,
  claimed: Map<number, string>,
): BrandResult {
  const rel = safeVaultPath(config);
  if (!rel) return fail(slug, config, 'the config path must be inside the vault');
  let text: string;
  try {
    text = readFileSync(join(vaultRoot, rel), 'utf8');
  } catch {
    return fail(slug, config, 'the brand file does not exist or cannot be read');
  }
  let data: unknown;
  try {
    data = matter(text).data;
  } catch (err) {
    return fail(slug, config, `front matter does not parse: ${(err as Error).message.split('\n')[0]}`, yamlLine(err));
  }
  const parsed = BrandFileSchema.safeParse(data);
  if (!parsed.success) {
    return fail(slug, config, parsed.error.issues.map((i) => `${i.path.join('.') || 'front matter'}: ${i.message}`).join('; '));
  }
  const f = parsed.data;
  if (f.brand !== slug) return fail(slug, config, `the file says brand "${f.brand}" but secondbrain.json lists it as "${slug}"`);

  const seen = new Set<string>();
  const taken = new Map<number, string>();
  for (const c of f.channels) {
    if (seen.has(c.id)) return fail(slug, config, `channel id "${c.id}" appears twice`);
    seen.add(c.id);
    if (c.posting === 'manual' && c.account_id !== undefined) return fail(slug, config, `channel "${c.id}" is manual but has an account_id`);
    if (c.posting !== 'manual') {
      if (c.account_id === undefined) return fail(slug, config, `channel "${c.id}" posts by ${c.posting} and needs an account_id`);
      if (!accountIds.has(c.account_id)) return fail(slug, config, `channel "${c.id}": account_id ${c.account_id} is not a connected account`);
      const other = claimed.get(c.account_id) ?? taken.get(c.account_id);
      if (other) {
        return fail(slug, config, `account_id ${c.account_id} (channel "${c.id}") is already used by ${other === slug ? 'another channel in this brand' : `brand "${other}"`}`);
      }
      taken.set(c.account_id, slug);
    }
  }
  for (const id of taken.keys()) claimed.set(id, slug);

  const warnings: string[] = [];
  const guideMissing = (p: string): boolean => {
    const ok = safeVaultPath(p);
    return !ok || !existsSync(join(vaultRoot, ok));
  };
  const styleGuides = f.style_guides.map((path) => ({ path, missing: guideMissing(path) }));
  for (const g of styleGuides) if (g.missing) warnings.push(`style guide not found: ${g.path}`);

  const channels: ChannelView[] = f.channels.map((c) => {
    const missing = c.style_guide !== undefined && guideMissing(c.style_guide);
    if (missing) warnings.push(`style guide not found: ${c.style_guide} (channel ${c.id})`);
    // "verify" and "unknown" both mean the profile URL is not known yet: shown without a link.
    const unconfirmed = c.url === undefined || c.url === 'verify' || c.url === 'unknown';
    if (c.status === 'verify' || c.url === 'verify' || c.url === 'unknown') warnings.push(`channel ${c.id}: profile not confirmed yet`);
    return {
      ...c,
      url: unconfirmed ? null : c.url!,
      urlUnconfirmed: unconfirmed,
      account: null,
      counts: { draft: 0, queued: 0, posted: 0, failed: 0 },
      styleGuideMissing: missing,
    };
  });
  return { ok: true, slug, name: f.name, config, trackerProjects: f.tracker_projects, styleGuides, channels, warnings };
}

interface AccountRow { id: number; provider: string; transport: string; access_token_expires_at: Date; disconnected_at: Date | null }

async function accountRows(): Promise<Map<number, AccountRow>> {
  const { rows } = await query<AccountRow>(`SELECT id, provider, transport, access_token_expires_at, disconnected_at FROM social_accounts`);
  return new Map(rows.map((r) => [Number(r.id), r]));
}

function health(row: AccountRow | undefined, now: Date): AccountHealth {
  if (!row) return { state: 'missing', tokenExpiresInDays: null, provider: null, transport: null };
  return {
    state: row.disconnected_at ? 'disconnected' : 'connected',
    // A Buffer channel's token column is a placeholder; its key is in env.
    tokenExpiresInDays: row.transport === 'buffer' ? null : Math.floor((new Date(row.access_token_expires_at).getTime() - now.getTime()) / 86_400_000),
    provider: row.provider,
    transport: row.transport,
  };
}

/** Every brand in secondbrain.json, parsed. Channels carry their account's health. */
export async function loadBrands(vaultRoot: string, now = new Date()): Promise<BrandResult[]> {
  const accounts = await accountRows();
  // A disconnected account still exists: the channel shows "disconnected" rather than breaking the brand.
  const known = new Set([...accounts.keys()]);
  const claimed = new Map<number, string>();
  return settings(vaultRoot).media.brands.map((b) => {
    const r = loadBrand(vaultRoot, b.slug, b.config, known, claimed);
    if (r.ok) for (const c of r.channels) c.account = c.account_id === undefined ? null : health(accounts.get(c.account_id), now);
    return r;
  });
}

export interface CalendarPost extends Omit<PostRow, 'media'> {
  channelId: string;
  network: string;
  hasMedia: boolean;
  mediaCount: number;
}

export interface Calendar {
  brand: string;
  from: string;
  to: string;
  posts: CalendarPost[];
  channels: ChannelView[];
}

/** A brand's posts in [from, to), under the channel their account belongs to, with per-channel counts for the range. */
export async function brandCalendar(vaultRoot: string, slug: string, from: Date, to: Date, now = new Date()): Promise<Calendar | null> {
  const brand = (await loadBrands(vaultRoot, now)).find((b) => b.slug === slug);
  if (!brand) return null;
  if (!brand.ok) throw new BrandLoadError(brand.error);
  const byAccount = new Map(brand.channels.filter((c) => c.account_id !== undefined).map((c) => [c.account_id!, c]));
  const rows = byAccount.size ? await listPosts({ from, to, accountIds: [...byAccount.keys()] }) : [];
  const posts: CalendarPost[] = rows.map((p) => {
    const ch = byAccount.get(Number(p.account_id))!;
    const { media, ...rest } = p;
    return { ...rest, channelId: ch.id, network: ch.network, hasMedia: media.length > 0, mediaCount: media.length };
  });
  for (const p of posts) {
    const ch = brand.channels.find((c) => c.id === p.channelId)!;
    if (p.status === 'draft' || p.status === 'queued' || p.status === 'posted' || p.status === 'failed') ch.counts[p.status]++;
  }
  return { brand: slug, from: from.toISOString(), to: to.toISOString(), posts, channels: brand.channels };
}

export class BrandLoadError extends Error {
  constructor(readonly detail: BrandError['error']) {
    super(`${detail.file}${detail.line ? `:${detail.line}` : ''}: ${detail.message}`);
  }
}
