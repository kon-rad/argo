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
