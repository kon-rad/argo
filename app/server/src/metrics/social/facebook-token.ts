import { z } from 'zod';

const TokenData = z.object({
  is_valid: z.literal(true),
  app_id: z.string(),
  type: z.literal('USER'),
  user_id: z.string().min(1),
  scopes: z.array(z.string()),
  expires_at: z.number().int().positive(),
  data_access_expires_at: z.number().int().nonnegative().optional(),
});
const SCOPES = ['instagram_basic', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement'];

/** Only the expiring Facebook USER contract is implemented. Never infer a legacy IG token from another type. */
export function validateFacebookUserToken(input: unknown, appId: string, now: number): { expiresAt: Date } {
  const result = z.object({ data: TokenData }).safeParse(input);
  if (!result.success) throw new Error('unsupported Facebook token response');
  const d = result.data.data;
  const expiry = Math.min(d.expires_at, d.data_access_expires_at || Infinity) * 1000;
  if (d.app_id !== appId || SCOPES.some(s => !d.scopes.includes(s)) || expiry <= now || !Number.isFinite(new Date(expiry).getTime())) throw new Error('invalid Facebook credential or permissions');
  return { expiresAt: new Date(expiry) };
}

/**
 * Business-integration system-user token (a Login for Business configuration
 * with "System-user access token"). debug_token reports type SYSTEM_USER,
 * expires_at 0 when it never expires, and per-permission `granular_scopes`
 * whose `target_ids` are the assets the owner selected in the dialog.
 */
const SystemUserData = z.object({
  is_valid: z.literal(true),
  app_id: z.string(),
  type: z.literal('SYSTEM_USER'),
  user_id: z.string().min(1),
  scopes: z.array(z.string()),
  granular_scopes: z.array(z.object({ scope: z.string(), target_ids: z.array(z.string()).optional() })),
  expires_at: z.number().int().nonnegative(),
  data_access_expires_at: z.number().int().nonnegative().optional(),
});
const SYSTEM_SCOPES = ['instagram_basic', 'instagram_manage_insights'];

export type FacebookCredential =
  | { kind: 'facebook-user'; expiresAt: Date }
  | { kind: 'facebook-system-user'; expiresAt: Date | null };

/**
 * Validates a debug_token answer for one of the two supported Unified token
 * types. A system-user token must name the intended asset explicitly in the
 * target_ids of every required permission: a grant without target_ids does not
 * prove the owner selected this account, so it is refused. USER tokens prove
 * the asset separately through /me/accounts.
 */
export function validateFacebookToken(input: unknown, appId: string, now: number, assetId: string): FacebookCredential {
  const type = (input as { data?: { type?: unknown } } | null)?.data?.type;
  if (type === 'USER') return { kind: 'facebook-user', ...validateFacebookUserToken(input, appId, now) };
  if (type !== 'SYSTEM_USER') throw new Error('unsupported Facebook token type');
  const result = z.object({ data: SystemUserData }).safeParse(input);
  if (!result.success) throw new Error('unsupported Facebook token response');
  const d = result.data.data;
  if (d.app_id !== appId || SYSTEM_SCOPES.some(s => !d.scopes.includes(s))) throw new Error('invalid Facebook credential or permissions');
  for (const scope of SYSTEM_SCOPES) {
    const grant = d.granular_scopes.find(g => g.scope === scope);
    if (!grant?.target_ids?.includes(assetId)) throw new Error('asset not selected for this credential');
  }
  // 0 means "never" for both fields; any non-zero limit bounds the credential.
  const limits = [d.expires_at, d.data_access_expires_at ?? 0].filter(t => t > 0).map(t => t * 1000);
  if (!limits.length) return { kind: 'facebook-system-user', expiresAt: null };
  const expiry = Math.min(...limits);
  if (expiry <= now || !Number.isFinite(new Date(expiry).getTime())) throw new Error('invalid Facebook credential or permissions');
  return { kind: 'facebook-system-user', expiresAt: new Date(expiry) };
}
