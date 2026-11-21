import { z } from 'zod';
export const TargetSchema = z.object({ kind: z.enum(['org-agent','cron-job','telegram-gateway','telegram-poller','default-route']), id: z.string().min(1).max(128) }).strict();
export type Target = z.infer<typeof TargetSchema>;
export const AssignmentSchema = z.object({ runtime: z.string().min(1).max(64), model: z.string().min(1).max(256).nullable(), provider: z.string().regex(/^[a-z0-9._-]+$/i).max(64).nullable() }).strict();
export type Assignment = z.infer<typeof AssignmentSchema>;
export const ProfileSchema = z.object({
  name: z.string().min(1).max(128), default: AssignmentSchema,
  exceptions: z.record(z.string(), AssignmentSchema).default({}),
  capabilities: z.partialRecord(z.enum(['code','review','merge','deploy']), AssignmentSchema).default({}),
  models: z.record(z.string(), z.object({ tier: z.number().int().min(0).max(3), canCode: z.boolean() }).strict()),
}).strict();
export type Profile = z.infer<typeof ProfileSchema>;
