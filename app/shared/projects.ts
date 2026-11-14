import { z } from 'zod';

export const STAGES = ['idea', 'designing', 'building', 'testing', 'live', 'parked', 'done'] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof StageSchema>;
const StageCountsSchema = z.object(Object.fromEntries(STAGES.map((stage) => [stage, z.number().int()])) as Record<Stage, z.ZodNumber>);

export const TrackerVerificationSchema = z.object({ kind: z.string(), check: z.string(), result: z.enum(['pass', 'fail']), evidence: z.string().nullable(), at: z.string(), by: z.string().nullable() });
export type TrackerVerification = z.infer<typeof TrackerVerificationSchema>;
export const TrackerFeatureSchema = z.object({
  id: z.number().int(), slug: z.string(), title: z.string(), stage: StageSchema, health: z.string().nullable(), owner: z.string().nullable(), goals: z.array(z.string()),
  needs_owner: z.string().nullable(), blocked_on: z.string().nullable(), started: z.string().nullable(), due: z.string().nullable(), shipped_at: z.string().nullable(),
  notes_path: z.string().nullable(), updated_at: z.string(), updated_by: z.string().nullable(), days_in_stage: z.number().int(), last_activity: z.string(),
  verification: TrackerVerificationSchema.nullable(), verifications_total: z.number().int(),
});
export type TrackerFeature = z.infer<typeof TrackerFeatureSchema>;
export const TrackerProjectSchema = z.object({
  slug: z.string(), title: z.string(), team: z.string().nullable(), division: z.string().nullable(), area: z.string().nullable(), stage: StageSchema,
  health: z.string().nullable(), priority: z.number().int().nullable(), goals: z.array(z.string()), needs_owner: z.string().nullable(), blocked_on: z.string().nullable(),
  started: z.string().nullable(), due: z.string().nullable(), devlog_path: z.string().nullable(), design_path: z.string().nullable(), paths: z.array(z.string()), repos: z.array(z.string()),
  updated_at: z.string(), updated_by: z.string().nullable(), days_in_stage: z.number().int(), next_action: z.string().nullable(), features: z.array(TrackerFeatureSchema),
  counts: StageCountsSchema, progress: z.number().nullable(),
});
export type TrackerProject = z.infer<typeof TrackerProjectSchema>;
export const TrackerItemSchema = z.object({ project: z.string(), feature: z.string().nullable(), title: z.string(), detail: z.string() });
export type TrackerItem = z.infer<typeof TrackerItemSchema>;
export const TrackerGoalSchema = z.object({ code: z.string(), horizon: z.string(), goal: z.string(), due: z.string().nullable(), status: z.string(), projects: z.array(z.string()), features: z.array(z.string()) });
export type TrackerGoal = z.infer<typeof TrackerGoalSchema>;
export const TrackerRollupSchema = z.object({ slug: z.string(), name: z.string(), projects: z.array(z.string()), in_flight: z.number().int(), shipped_7d: z.number().int(), needs_owner: z.number().int(), stages: StageCountsSchema });
export type TrackerRollup = z.infer<typeof TrackerRollupSchema>;
const PriorityItemSchema = TrackerItemSchema.extend({ priority: z.number().int().nullable(), due: z.string().nullable() });
export const TrackerReportSchema = z.object({
  as_of: z.string().nullable(), generated_at: z.string(), totals: z.object({ projects: StageCountsSchema, features: StageCountsSchema }),
  needs_owner: z.array(PriorityItemSchema), divisions: z.array(TrackerRollupSchema), teams: z.array(TrackerRollupSchema.extend({ lead: z.string().nullable() })), goals: z.array(TrackerGoalSchema),
  gaps: z.object({ goals_uncovered: z.array(TrackerGoalSchema), unverified_shipped: z.array(TrackerItemSchema), failing: z.array(TrackerItemSchema),
    testing_unverified: z.array(TrackerItemSchema), stale: z.array(TrackerItemSchema), overdue: z.array(TrackerItemSchema), no_team: z.array(z.string()), no_division: z.array(z.string()), no_features: z.array(z.string()) }),
  oldest: z.array(TrackerItemSchema), backlog: z.object({ total: z.number().int(), by_project: z.array(z.object({ project: z.string(), count: z.number().int(), oldest_days: z.number().int() })) }),
  moved_7d: z.array(z.object({ project: z.string(), feature: z.string().nullable(), title: z.string(), from: z.string().nullable(), to: z.string(), at: z.string(), by: z.string().nullable(), note: z.string().nullable() })),
  shipped_7d: z.array(TrackerItemSchema), verified_7d: z.object({ pass: z.number().int(), fail: z.number().int() }), projects: z.array(TrackerProjectSchema),
});
export type TrackerReport = z.infer<typeof TrackerReportSchema>;

export const ProjectsMarkdownResponseSchema = z.object({ format: z.enum(['markdown', 'standup', 'telegram']), text: z.string(), as_of: z.string().nullable() });
export type ProjectsMarkdownResponse = z.infer<typeof ProjectsMarkdownResponseSchema>;
export const StageChangedResponseSchema = z.object({ stage_changed: z.boolean() });
export type StageChangedResponse = z.infer<typeof StageChangedResponseSchema>;
export const VerificationCreatedResponseSchema = z.object({ id: z.number().int() });
export type VerificationCreatedResponse = z.infer<typeof VerificationCreatedResponseSchema>;
const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GoalCodeSchema = z.string().regex(/^[WMQYT]\d{1,2}$/);
const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const TextSchema = z.string().trim().min(1).max(2000);
export const ProjectPatchSchema = z.object({
  title: TextSchema.max(200), team: SlugSchema.nullable(), division: SlugSchema.nullable(), area: TextSchema.max(100).nullable(), stage: StageSchema,
  health: z.enum(['green', 'yellow', 'red']).nullable(), priority: z.number().int().positive().nullable(), goals: z.array(GoalCodeSchema), needs_owner: TextSchema.nullable(),
  blocked_on: TextSchema.nullable(), started: DaySchema.nullable(), due: DaySchema.nullable(), devlog_path: TextSchema.nullable(), design_path: TextSchema.nullable(),
  paths: z.array(z.string().max(300)), repos: z.array(z.string().max(200)), note: TextSchema.max(500),
}).partial().strict();
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;
export const FeaturePatchSchema = z.object({
  title: TextSchema.max(200), stage: StageSchema, health: z.enum(['green', 'yellow', 'red']).nullable(), owner: TextSchema.max(100).nullable(), goals: z.array(GoalCodeSchema),
  needs_owner: TextSchema.nullable(), blocked_on: TextSchema.nullable(), started: DaySchema.nullable(), due: DaySchema.nullable(), notes_path: TextSchema.nullable(),
  sort: z.number().int(), note: TextSchema.max(500), unverified: TextSchema.max(500),
}).partial().strict();
export type FeaturePatch = z.infer<typeof FeaturePatchSchema>;
export const FeatureVerificationRequestSchema = z.object({ kind: z.enum(['test', 'manual', 'deploy', 'review', 'metric']), check: TextSchema.max(500), result: z.enum(['pass', 'fail']), evidence: TextSchema.max(4000).nullish() });
export type FeatureVerificationRequest = z.infer<typeof FeatureVerificationRequestSchema>;
