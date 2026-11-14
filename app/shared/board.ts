import { z } from 'zod';

export const BOARD_STATUSES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'review', 'blocked', 'done', 'archived'] as const;
export const BoardStatusSchema = z.enum(BOARD_STATUSES);
export type BoardStatus = z.infer<typeof BoardStatusSchema>;

export const BoardContractSchema = z.object({
  objective: z.string().optional(), returns: z.array(z.string()).optional(),
  budget: z.object({ turns: z.number().int().optional(), tokens: z.number().int().optional(), minutes: z.number().int().optional(), wakes: z.number().int().optional() }).optional(),
  scope: z.array(z.string()).optional(), verification: z.string().optional(),
});
export type BoardContract = z.infer<typeof BoardContractSchema>;

export const BoardCardSchema = z.object({
  id: z.string(), board_slug: z.string(), title: z.string(), body: z.string().nullable(), contract: BoardContractSchema, status: BoardStatusSchema,
  priority: z.number().int(), assignee: z.string().nullable(), created_by: z.string(), project_slug: z.string().nullable(), feature_slug: z.string().nullable(),
  kind: z.string(), work_type: z.string().nullable(), needs: z.string().nullable(), ship_now: z.boolean(), repo: z.string().nullable(), graph: z.string().nullable(),
  node: z.string().nullable(), rounds: z.number().int(), scheduled_for: z.string().nullable(), block_kind: z.string().nullable(), block_reason: z.string().nullable(),
  result: z.string().nullable(), created_at: z.string(), started_at: z.string().nullable(), completed_at: z.string().nullable(), updated_at: z.string(),
});
export type BoardCard = z.infer<typeof BoardCardSchema>;

const CardLinkSchema = z.object({ id: z.string(), title: z.string(), status: z.string() });
const BoardCommentSchema = z.object({ id: z.number().int(), card_id: z.string(), author: z.string(), body: z.string(), created_at: z.string() });
const BoardEventSchema = z.object({ id: z.number().int(), card_id: z.string(), kind: z.string(), actor: z.string().nullable(), payload: z.record(z.string(), z.unknown()).nullable(), at: z.string() });
const BoardRunSchema = z.object({
  id: z.number().int(), card_id: z.string(), agent_name: z.string(), runtime: z.string(), wakeup_id: z.number().int().nullable(), run_id: z.string().nullable(), claimed_at: z.string(), lease_until: z.string(), heartbeat_at: z.string().nullable(),
  finished_at: z.string().nullable(), outcome: z.string().nullable(), tokens: z.number().int().nullable(), turns: z.number().int().nullable(),
});
export const BoardCardDetailSchema = z.object({
  card: BoardCardSchema, comments: z.array(BoardCommentSchema), events: z.array(BoardEventSchema), depends_on: z.array(CardLinkSchema),
  dependants: z.array(CardLinkSchema), runs: z.array(BoardRunSchema),
});
export type BoardCardDetail = z.infer<typeof BoardCardDetailSchema>;

export const BoardInfoSchema = z.object({ slug: z.string(), name: z.string(), team_slug: z.string().nullable(), created_at: z.string(), open: z.number().int() });
export type BoardInfo = z.infer<typeof BoardInfoSchema>;
export const BoardTokenSchema = z.object({ id: z.number().int(), agent_name: z.string(), label: z.string().nullable(), created_at: z.string(), last_seen_at: z.string().nullable(), revoked_at: z.string().nullable() });
export type BoardToken = z.infer<typeof BoardTokenSchema>;

export const BoardCardFilterSchema = z.object({
  board: z.string().optional(), status: z.string().optional(), assignee: z.string().optional(), project: z.string().optional(), feature: z.string().optional(),
  kind: z.string().optional(), q: z.string().optional(), id: z.string().optional(), done_days: z.number().int().optional(),
});
export type BoardCardFilter = z.infer<typeof BoardCardFilterSchema>;
export const NewBoardCardSchema = z.object({
  board: z.string().optional(), title: z.string(), body: z.string().optional(), contract: BoardContractSchema.optional(), assignee: z.string().nullable().optional(),
  project: z.string().optional(), feature: z.string().optional(), kind: z.string().optional(), work: z.string().optional(), needs: z.string().optional(), repo: z.string().optional(),
  priority: z.number().int().optional(), deps: z.array(z.string()).optional(), ship_now: z.boolean().optional(),
});
export type NewBoardCard = z.infer<typeof NewBoardCardSchema>;
export const BoardAssignRequestSchema = z.object({ assignee: z.string().nullable(), project: z.string().optional(), feature: z.string().optional() });
export type BoardAssignRequest = z.infer<typeof BoardAssignRequestSchema>;
export const BoardMoveRequestSchema = z.object({ status: BoardStatusSchema, note: z.string().optional() });
export type BoardMoveRequest = z.infer<typeof BoardMoveRequestSchema>;
export const BoardFinishRequestSchema = z.object({ outcome: z.enum(['done', 'blocked', 'partial', 'budget']), result: z.string().optional(), block_kind: z.string().optional() });
export type BoardFinishRequest = z.infer<typeof BoardFinishRequestSchema>;
export const BoardTagRequestSchema = z.object({ project: z.string().nullable(), feature: z.string().nullable().optional() });
export type BoardTagRequest = z.infer<typeof BoardTagRequestSchema>;
export const BoardFlagsRequestSchema = z.object({ ship_now: z.boolean().optional(), needs: z.string().optional() });
export type BoardFlagsRequest = z.infer<typeof BoardFlagsRequestSchema>;

export const BoardBoardsResponseSchema = z.object({ boards: z.array(BoardInfoSchema) });
export type BoardBoardsResponse = z.infer<typeof BoardBoardsResponseSchema>;
export const BoardCardsResponseSchema = z.object({ cards: z.array(BoardCardSchema) });
export type BoardCardsResponse = z.infer<typeof BoardCardsResponseSchema>;
export const BoardCardResponseSchema = z.object({ card: BoardCardSchema });
export type BoardCardResponse = z.infer<typeof BoardCardResponseSchema>;
