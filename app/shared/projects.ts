import { z } from 'zod';

export const STAGES = ['idea', 'designing', 'building', 'testing', 'live', 'parked', 'done'] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof StageSchema>;
const StageCountsSchema = z.object(Object.fromEntries(STAGES.map((stage) => [stage, z.number().int()])) as Record<Stage, z.ZodNumber>);

export const TrackerVerificationSchema = z.object({ kind: z.string(), check: z.string(), result: z.enum(['pass', 'fail']), evidence: z.string().nullable(), at: z.string(), by: z.string().nullable() });
export type TrackerVerification = z.infer<typeof TrackerVerificationSchema>;
/** A finite project: an outcome with an end, inside one area (the table `projects`, once `features`). */
export const TrackerProjectSchema = z.object({
  id: z.number().int(), area: z.string(), slug: z.string(), title: z.string(), outcome: z.string().nullable(), next_action: z.string().nullable(), stage: StageSchema,
  health: z.string().nullable(), owner: z.string().nullable(), goals: z.array(z.string()),
  needs_owner: z.string().nullable(), blocked_on: z.string().nullable(), started: z.string().nullable(), due: z.string().nullable(), shipped_at: z.string().nullable(),
  notes_path: z.string().nullable(), archived_at: z.string().nullable(), updated_at: z.string(), updated_by: z.string().nullable(), days_in_stage: z.number().int(), last_activity: z.string(),
  verification: TrackerVerificationSchema.nullable(), verifications_total: z.number().int(),
});
export type TrackerProject = z.infer<typeof TrackerProjectSchema>;
/** An area: a standard the owner keeps up, with no end date (the table `areas`, once `projects`). */
export const AREA_STATUSES = ['active', 'parked'] as const;
export const AreaStatusSchema = z.enum(AREA_STATUSES);
export type AreaStatus = z.infer<typeof AreaStatusSchema>;
const StatusCountsSchema = z.object({ active: z.number().int(), parked: z.number().int() });
export const TrackerAreaSchema = z.object({
  slug: z.string(), title: z.string(), team: z.string().nullable(), division: z.string().nullable(), status: AreaStatusSchema,
  health: z.string().nullable(), priority: z.number().int().nullable(), goals: z.array(z.string()), needs_owner: z.string().nullable(), blocked_on: z.string().nullable(),
  started: z.string().nullable(), devlog_path: z.string().nullable(), design_path: z.string().nullable(), home_path: z.string().nullable(), paths: z.array(z.string()), repos: z.array(z.string()),
  archived_at: z.string().nullable(), updated_at: z.string(), updated_by: z.string().nullable(), next_action: z.string().nullable(), projects: z.array(TrackerProjectSchema),
  counts: StageCountsSchema, progress: z.number().nullable(),
});
export type TrackerArea = z.infer<typeof TrackerAreaSchema>;
/** One line of the report: an area, or a project inside it when `project` is set. */
export const TrackerItemSchema = z.object({ area: z.string(), project: z.string().nullable(), title: z.string(), detail: z.string() });
export type TrackerItem = z.infer<typeof TrackerItemSchema>;
export const TrackerGoalSchema = z.object({ code: z.string(), horizon: z.string(), goal: z.string(), due: z.string().nullable(), status: z.string(), areas: z.array(z.string()), projects: z.array(z.string()) });
export type TrackerGoal = z.infer<typeof TrackerGoalSchema>;
export const TrackerRollupSchema = z.object({ slug: z.string(), name: z.string(), areas: z.array(z.string()), in_flight: z.number().int(), shipped_7d: z.number().int(), needs_owner: z.number().int(), statuses: StatusCountsSchema });
export type TrackerRollup = z.infer<typeof TrackerRollupSchema>;
const PriorityItemSchema = TrackerItemSchema.extend({ priority: z.number().int().nullable(), due: z.string().nullable() });
export const TrackerReportSchema = z.object({
  as_of: z.string().nullable(), generated_at: z.string(), totals: z.object({ areas: StatusCountsSchema, projects: StageCountsSchema }),
  needs_owner: z.array(PriorityItemSchema), divisions: z.array(TrackerRollupSchema), teams: z.array(TrackerRollupSchema.extend({ lead: z.string().nullable() })), goals: z.array(TrackerGoalSchema),
  gaps: z.object({ goals_uncovered: z.array(TrackerGoalSchema), unverified_shipped: z.array(TrackerItemSchema), failing: z.array(TrackerItemSchema),
    testing_unverified: z.array(TrackerItemSchema), stale: z.array(TrackerItemSchema), overdue: z.array(TrackerItemSchema), no_team: z.array(z.string()), no_division: z.array(z.string()), no_projects: z.array(z.string()) }),
  oldest: z.array(TrackerItemSchema), backlog: z.object({ total: z.number().int(), by_area: z.array(z.object({ area: z.string(), count: z.number().int(), oldest_days: z.number().int() })) }),
  moved_7d: z.array(z.object({ area: z.string(), project: z.string().nullable(), title: z.string(), from: z.string().nullable(), to: z.string(), at: z.string(), by: z.string().nullable(), note: z.string().nullable() })),
  shipped_7d: z.array(TrackerItemSchema), verified_7d: z.object({ pass: z.number().int(), fail: z.number().int() }), areas: z.array(TrackerAreaSchema),
});
export type TrackerReport = z.infer<typeof TrackerReportSchema>;

export const TrackerMarkdownResponseSchema = z.object({ format: z.enum(['markdown', 'standup', 'telegram']), text: z.string(), as_of: z.string().nullable() });
export type TrackerMarkdownResponse = z.infer<typeof TrackerMarkdownResponseSchema>;
export const StageChangedResponseSchema = z.object({ stage_changed: z.boolean() });
export type StageChangedResponse = z.infer<typeof StageChangedResponseSchema>;
export const VerificationCreatedResponseSchema = z.object({ id: z.number().int() });
export type VerificationCreatedResponse = z.infer<typeof VerificationCreatedResponseSchema>;
export const ArchivedResponseSchema = z.object({ archived: z.boolean(), changed: z.boolean() });
export type ArchivedResponse = z.infer<typeof ArchivedResponseSchema>;
const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GoalCodeSchema = z.string().regex(/^[WMQYT]\d{1,2}$/);
const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const TextSchema = z.string().trim().min(1).max(2000);
/** What can be set on an area. It has a status, not a stage, and no due date: an area has no end. */
export const AreaPatchSchema = z.object({
  title: TextSchema.max(200), team: SlugSchema.nullable(), division: SlugSchema.nullable(), status: AreaStatusSchema,
  health: z.enum(['green', 'yellow', 'red']).nullable(), priority: z.number().int().positive().nullable(), goals: z.array(GoalCodeSchema), needs_owner: TextSchema.nullable(),
  blocked_on: TextSchema.nullable(), started: DaySchema.nullable(), devlog_path: TextSchema.nullable(), design_path: TextSchema.nullable(), home_path: TextSchema.max(500).nullable(),
  paths: z.array(z.string().max(300)), repos: z.array(z.string().max(200)), note: TextSchema.max(500),
}).partial().strict();
export type AreaPatch = z.infer<typeof AreaPatchSchema>;
/** What can be set on a project. `outcome` says what done means. */
export const ProjectPatchSchema = z.object({
  title: TextSchema.max(200), outcome: TextSchema, next_action: TextSchema.nullable(), stage: StageSchema, health: z.enum(['green', 'yellow', 'red']).nullable(), owner: TextSchema.max(100).nullable(), goals: z.array(GoalCodeSchema),
  needs_owner: TextSchema.nullable(), blocked_on: TextSchema.nullable(), started: DaySchema.nullable(), due: DaySchema.nullable(), notes_path: TextSchema.nullable(),
  sort: z.number().int(), note: TextSchema.max(500), unverified: TextSchema.max(500),
}).partial().strict();
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;
export const ProjectVerificationRequestSchema = z.object({ kind: z.enum(['test', 'manual', 'deploy', 'review', 'metric']), check: TextSchema.max(500), result: z.enum(['pass', 'fail']), evidence: TextSchema.max(4000).nullish() });
export type ProjectVerificationRequest = z.infer<typeof ProjectVerificationRequestSchema>;
export const ArchiveRequestSchema = z.object({ note: TextSchema.max(500).optional() }).strict();
export type ArchiveRequest = z.infer<typeof ArchiveRequestSchema>;
/** One KPI reading for an area. `key` must be defined in the `kpis:` frontmatter of the area's home note; `at` defaults to now. */
export const KpiReadingRequestSchema = z.object({
  key: z.string().trim().min(1).max(100), value: z.number().finite(), at: z.string().trim().min(1).max(40).optional(), note: TextSchema.max(500).optional(),
}).strict();
export type KpiReadingRequest = z.infer<typeof KpiReadingRequestSchema>;
export const KpiReadingCreatedResponseSchema = z.object({ id: z.number().int() });
export type KpiReadingCreatedResponse = z.infer<typeof KpiReadingCreatedResponseSchema>;

/**
 * The context pack of an area (`cli-areas show`, `GET /api/areas/:slug/context`): what an agent with a ticket on it
 * reads first. `links`, `style` and `goals` are the home note's frontmatter as the owner wrote it; paths, never file
 * contents. `kpis` and `goals` are absent when the home note defines none. Each list is cut, with its `*_total` next to it.
 */
export const AreaContextKpiSchema = z.object({
  key: z.string(), name: z.string().nullable(), unit: z.string().nullable(), target: z.number().nullable(), by: z.string().nullable(),
  latest: z.object({ value: z.number(), at: z.string() }).nullable(),
});
export type AreaContextKpi = z.infer<typeof AreaContextKpiSchema>;
export const AreaContextEventSchema = z.object({
  at: z.string(), actor: z.string(), project: z.string().nullable(), kind: z.string(), field: z.string().nullable(),
  from: z.unknown(), to: z.unknown(), note: z.string().nullable(),
});
export type AreaContextEvent = z.infer<typeof AreaContextEventSchema>;
export const AreaContextSchema = z.object({
  area: z.object({
    slug: z.string(), title: z.string(), status: AreaStatusSchema, team: z.string().nullable(), division: z.string().nullable(),
    home_path: z.string().nullable(), home_note: z.string().nullable(), design_path: z.string().nullable(), devlog_path: z.string().nullable(),
    repos: z.array(z.string()), paths: z.array(z.string()), goal_codes: z.array(z.string()), needs_owner: z.string().nullable(), blocked_on: z.string().nullable(),
    archived_at: z.string().nullable(),
  }),
  description: z.string().nullable(),
  summary: z.string().nullable(),
  links: z.unknown(),
  style: z.unknown(),
  goals: z.unknown().optional(),
  kpis: z.array(AreaContextKpiSchema).optional(),
  roadmap: z.array(z.object({
    slug: z.string(), title: z.string(), outcome: z.string().nullable(), stage: StageSchema, due: z.string().nullable(), next_action: z.string().nullable(),
    owner: z.string().nullable(), notes_path: z.string().nullable(),
  })),
  roadmap_total: z.number().int(),
  recent: z.object({
    days: z.number().int(), since: z.string(),
    events: z.array(AreaContextEventSchema), events_total: z.number().int(),
    cards: z.array(z.object({ id: z.string(), title: z.string(), project: z.string().nullable(), assignee: z.string().nullable(), completed_at: z.string() })), cards_total: z.number().int(),
    files: z.array(z.object({ path: z.string(), mtime: z.string() })), files_total: z.number().int(),
  }),
  project: z.object({
    slug: z.string(), title: z.string(), outcome: z.string().nullable(), stage: StageSchema, due: z.string().nullable(), owner: z.string().nullable(),
    next_action: z.string().nullable(), notes_path: z.string().nullable(), needs_owner: z.string().nullable(), blocked_on: z.string().nullable(),
    archived_at: z.string().nullable(), excerpt: z.string().nullable(),
    verifications: z.array(TrackerVerificationSchema), verifications_total: z.number().int(),
  }).optional(),
});
export type AreaContext = z.infer<typeof AreaContextSchema>;
