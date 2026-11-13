import { z } from 'zod';

const USER_SCOPES = [
  'instagram_basic',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
] as const;
const SYSTEM_USER_SCOPES = ['instagram_basic', 'instagram_manage_insights'] as const;

const FacebookUserTokenData = z.object({
  is_valid: z.literal(true),
  app_id: z.string().min(1),
  type: z.literal('USER'),
  user_id: z.string().min(1),
  scopes: z.array(z.string()),
  expires_at: z.number().int().positive(),
  data_access_expires_at: z.number().int().nonnegative().optional(),
});

const FacebookSystemUserTokenData = z.object({
  is_valid: z.literal(true),
  app_id: z.string().min(1),
  type: z.literal('SYSTEM_USER'),
  user_id: z.string().min(1),
  scopes: z.array(z.string()),
  granular_scopes: z.array(z.object({
    scope: z.string(),
    target_ids: z.array(z.string().min(1)).optional(),
  })),
  expires_at: z.number().int().nonnegative(),
  data_access_expires_at: z.number().int().nonnegative().optional(),
});

export type FacebookCredential =
  | { kind: 'facebook-user'; expiresAt: Date }
  | { kind: 'facebook-system-user'; expiresAt: Date | null };

function checkedNow(now: number): void {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    throw new Error('invalid Facebook credential or permissions');
  }
}

function checkedDate(expirySeconds: number, now: number): Date {
  const expiresAt = new Date(expirySeconds * 1000);
  if (expiresAt.getTime() <= now || !Number.isFinite(expiresAt.getTime())) {
    throw new Error('invalid Facebook credential or permissions');
  }
  return expiresAt;
}

/**
 * Validate the expiring Facebook USER contract. The intended asset must still
 * be proved separately through the Facebook account lookup before storage.
 */
export function validateFacebookUserToken(input: unknown, appId: string, now: number): { expiresAt: Date } {
  checkedNow(now);
  const result = z.object({ data: FacebookUserTokenData }).safeParse(input);
  if (!result.success) throw new Error('unsupported Facebook token response');
  const data = result.data.data;
  if (data.app_id !== appId || USER_SCOPES.some((scope) => !data.scopes.includes(scope))) {
    throw new Error('invalid Facebook credential or permissions');
  }

  // Meta uses zero to mean no separate data-access limit. A USER token itself
  // must always have a finite, positive expiry.
  const expiry = Math.min(data.expires_at, data.data_access_expires_at || Infinity);
  return { expiresAt: checkedDate(expiry, now) };
}

/**
 * Validate the two locally supported Facebook Unified token contracts.
 *
 * SYSTEM_USER permissions must each name the intended asset in target_ids. A
 * grant without target_ids cannot prove account selection and is refused. Zero
 * means no limit for SYSTEM_USER expiry and data-access expiry; every non-zero
 * limit is enforced. USER asset ownership is intentionally outside this pure
 * token check and must be established through the account lookup before use.
 */
export function validateFacebookToken(
  input: unknown,
  appId: string,
  now: number,
  assetId: string,
): FacebookCredential {
  checkedNow(now);
  const type = (input as { data?: { type?: unknown } } | null)?.data?.type;
  if (type === 'USER') {
    return { kind: 'facebook-user', ...validateFacebookUserToken(input, appId, now) };
  }
  if (type !== 'SYSTEM_USER') throw new Error('unsupported Facebook token type');

  const result = z.object({ data: FacebookSystemUserTokenData }).safeParse(input);
  if (!result.success) throw new Error('unsupported Facebook token response');
  const data = result.data.data;
  if (data.app_id !== appId || SYSTEM_USER_SCOPES.some((scope) => !data.scopes.includes(scope))) {
    throw new Error('invalid Facebook credential or permissions');
  }
  for (const scope of SYSTEM_USER_SCOPES) {
    const grant = data.granular_scopes.find((candidate) => candidate.scope === scope);
    if (!grant?.target_ids?.includes(assetId)) {
      throw new Error('asset not selected for this credential');
    }
  }

  const limits = [data.expires_at, data.data_access_expires_at ?? 0].filter((limit) => limit > 0);
  if (limits.length === 0) return { kind: 'facebook-system-user', expiresAt: null };
  return { kind: 'facebook-system-user', expiresAt: checkedDate(Math.min(...limits), now) };
}
