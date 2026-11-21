import type pg from 'pg';
import { z } from 'zod';

export const OwnerSupersedeRequest = z.object({
  card: z.string().regex(/^t_[a-f0-9]{6,32}$/),
  successor: z.string().regex(/^t_[a-f0-9]{6,32}$/),
  reason: z.string().trim().min(8).max(2000),
}).strict().refine(value => value.card !== value.successor, { message: 'successor must differ from card' });
export type OwnerSupersedeRequest = z.infer<typeof OwnerSupersedeRequest>;

export interface OwnerSupersedeReceipt {
  id: number;
  card: string;
  job: number;
  successor: string;
  reason: string;
  superseded_by: string;
  superseded_at: string;
}

/** The database enforces owner identity and archives the card in the receipt transaction. */
export async function supersedeOwner(client: pg.Client, input: unknown): Promise<OwnerSupersedeReceipt> {
  const request = OwnerSupersedeRequest.parse(input);
  return (await client.query<OwnerSupersedeReceipt>('SELECT (review_owner_supersede($1,$2,$3)).*',
    [request.card, request.successor, request.reason])).rows[0]!;
}

/** `<card> --by <successor-card> --reason <why>` */
export function parseOwnerSupersedeArgs(argv: string[]): OwnerSupersedeRequest {
  const [card, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!, value = rest[i + 1];
    if (!['--by', '--reason'].includes(flag) || value === undefined || opts[flag.slice(2)] !== undefined) {
      throw new Error(`Unexpected argument ${flag}`);
    }
    opts[flag.slice(2)] = value;
  }
  return OwnerSupersedeRequest.parse({ card, successor: opts.by, reason: opts.reason });
}
