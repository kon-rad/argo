import { z } from 'zod';

/**
 * The skills addon's wire contracts (docs/skills.md). Git policy and package files are the authority; these
 * shapes are derived views of them plus the operational machine acknowledgements kept in Postgres.
 */

export const SKILL_SOURCES = ['private', 'engine', 'legacy', 'external'] as const;
export const SkillSourceSchema = z.enum(SKILL_SOURCES);
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const LIFECYCLE_STATUSES = ['active', 'deprecated', 'disabled', 'removed'] as const;
export const LifecycleStatusSchema = z.enum(LIFECYCLE_STATUSES);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

/** `catalog-filtered`: discovery and the skill loader are filtered, other file/shell tools are not. `catalog-only`: a generated view only. */
export const SUPPORT_LEVELS = ['catalog-filtered', 'catalog-only', 'none'] as const;
export const SupportLevelSchema = z.enum(SUPPORT_LEVELS);
export type SupportLevel = z.infer<typeof SupportLevelSchema>;

export const SkillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const SkillIdSchema = z.string().min(3).max(200);
export const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const AgentNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
export const RuntimeSchema = z.enum(['zen-agent', 'claude-code', 'hermes', 'codex']);
export type SkillRuntime = z.infer<typeof RuntimeSchema>;

export const SkillMetadataSchema = z.object({
  version: z.string().nullable(), owner: z.string().nullable(), license: z.string().nullable(),
  depends: z.array(z.string()), requires: z.object({ bins: z.array(z.string()), env: z.array(z.string()) }),
});
export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;

export const SkillCandidateSchema = z.object({
  id: z.string(), name: z.string(), source: SkillSourceSchema, root: z.string(), relPath: z.string(), category: z.string().nullable(),
  description: z.string(), valid: z.boolean(), errors: z.array(z.string()), warnings: z.array(z.string()),
  digest: z.string().nullable(), files: z.number().int(), bytes: z.number().int(),
  /** Last commit touching the package; null when the root is not in Git or the package is untracked. */
  revision: z.string().nullable(),
  /** Uncommitted changes under the package; null when unknown (not Git). */
  dirty: z.boolean().nullable(), tracked: z.boolean().nullable(),
  /** The candidate this one is a symlink of (a `link-skills` link), so it is the same package, not an override. */
  linkOf: z.string().nullable(),
  effective: z.boolean(), shadowedBy: z.string().nullable(), metadata: SkillMetadataSchema,
});
export type SkillCandidate = z.infer<typeof SkillCandidateSchema>;

export const LifecycleSchema = z.object({ status: LifecycleStatusSchema, replacement: z.string().nullable(), note: z.string().nullable() });
export type Lifecycle = z.infer<typeof LifecycleSchema>;

export const SkillRowSchema = z.object({
  name: z.string(), effective: SkillCandidateSchema.nullable(), candidates: z.array(SkillCandidateSchema),
  flags: z.object({ override: z.boolean(), duplicate: z.boolean(), invalid: z.boolean(), dirty: z.boolean() }),
  lifecycle: LifecycleSchema, assigned: z.number().int(), denied: z.number().int(), references: z.number().int(),
});
export type SkillRow = z.infer<typeof SkillRowSchema>;

export const PolicyStatusSchema = z.object({
  file: z.string(), exists: z.boolean(), valid: z.boolean(), errors: z.array(z.string()), warnings: z.array(z.string()),
  digest: z.string().nullable(), revision: z.string().nullable(), dirty: z.boolean().nullable(),
  reviewed: z.boolean().optional(), reviewError: z.string().nullable().optional(),
  approval: z.object({ repo: z.string(), path: z.string(), revision: z.string(), digest: z.string(), source: z.string(), approvedBy: z.string() }).nullable().optional(),
});
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;

export const RootInfoSchema = z.object({
  id: z.string(), source: SkillSourceSchema, label: z.string(), exists: z.boolean(), packages: z.number().int(),
  revision: z.string().nullable(), git: z.boolean(), error: z.string().nullable(),
});
export type RootInfo = z.infer<typeof RootInfoSchema>;

export const ModeSchema = z.enum(['legacy', 'managed']);
export type SkillsMode = z.infer<typeof ModeSchema>;

export const LibraryResponseSchema = z.object({
  mode: ModeSchema, policy: PolicyStatusSchema, roots: z.array(RootInfoSchema), skills: z.array(SkillRowSchema), generatedAt: z.string(),
});
export type LibraryResponse = z.infer<typeof LibraryResponseSchema>;

export const ReasonSchema = z.object({
  level: z.enum(['org', 'team', 'agent', 'lifecycle', 'package', 'legacy', 'knowledge', 'policy']),
  kind: z.enum(['grant', 'deny', 'note']), detail: z.string(),
});
export type Reason = z.infer<typeof ReasonSchema>;

export const ASSIGNMENT_STATES = ['assigned', 'denied', 'not-assigned', 'unavailable', 'legacy'] as const;
export const AssignmentStateSchema = z.enum(ASSIGNMENT_STATES);
export type AssignmentState = z.infer<typeof AssignmentStateSchema>;

/** Evidence a session actually used the skill. Only from a recorded source; never inferred from assignment. */
export const LoadedEvidenceSchema = z.object({ source: z.string(), at: z.string(), digest: z.string().nullable(), detail: z.string() });
export type LoadedEvidence = z.infer<typeof LoadedEvidenceSchema>;

export const AssignmentCellSchema = z.object({
  agent: z.string(), skill: z.string(), state: AssignmentStateSchema, reasons: z.array(ReasonSchema),
  /** A `knowledge:` path in the org config names this skill. Informational; never a grant. */
  reference: z.boolean(), deprecated: z.boolean(), loaded: LoadedEvidenceSchema.nullable(),
});
export type AssignmentCell = z.infer<typeof AssignmentCellSchema>;

export const AgentInfoSchema = z.object({
  name: z.string(), team: z.string().nullable(), runtime: z.string(), support: SupportLevelSchema, supportNote: z.string(),
  assigned: z.number().int(), references: z.number().int(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const MatrixResponseSchema = z.object({
  mode: ModeSchema, agents: z.array(AgentInfoSchema), skills: z.array(z.string()),
  /** Every non-default cell; an absent agent x skill pair is `not-assigned` (managed) or `legacy` (legacy). */
  cells: z.array(AssignmentCellSchema), loadedSource: z.string().nullable(), rosterError: z.string().nullable(),
});
export type MatrixResponse = z.infer<typeof MatrixResponseSchema>;

export const FileEntrySchema = z.object({ path: z.string(), size: z.number().int(), exec: z.boolean(), sha256: z.string(), version: z.string().regex(/^[0-9a-f]{64}$/).optional(), kind: z.enum(['text', 'binary']) });
export type FileEntry = z.infer<typeof FileEntrySchema>;
export const HistoryEntrySchema = z.object({ revision: z.string(), date: z.string(), subject: z.string() });
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const SKILL_HOST_STATES = ['match', 'drift', 'missing', 'extra', 'unknown'] as const;
export const HostSkillSchema = z.object({
  name: z.string(), desired: z.string().nullable(), observed: z.string().nullable(), state: z.enum(SKILL_HOST_STATES),
});
export const RequirementSchema = z.object({ skill: z.string(), bins: z.array(z.string()), env: z.array(z.string()) });
export type Requirement = z.infer<typeof RequirementSchema>;

export const ExclusionSchema = z.object({ name: SkillNameSchema, reason: z.string().max(1000) });
export const ViewStateSchema = z.object({
  agent: z.string(), runtime: z.string(), viewDigest: z.string().nullable(), generatedAt: z.string().nullable(), receivedAt: z.string(),
  status: z.enum(['current', 'not-ready', 'drift', 'dirty', 'stale', 'failed']), error: z.string().nullable(),
  excluded: z.array(ExclusionSchema).max(500).optional(),
  skills: z.array(HostSkillSchema), missing: z.array(RequirementSchema), dirty: z.array(z.string()),
});
export type ViewState = z.infer<typeof ViewStateSchema>;

export const HostStateSchema = z.object({
  host: z.string(), display: z.string(), status: z.enum(['current', 'not-ready', 'drift', 'dirty', 'stale', 'never', 'failed']),
  lastAck: z.string().nullable(), views: z.array(ViewStateSchema),
});
export type HostState = z.infer<typeof HostStateSchema>;

export const MachinesResponseSchema = z.object({
  staleAfterHours: z.number(), hosts: z.array(HostStateSchema), mode: ModeSchema, notes: z.array(z.string()),
});
export type MachinesResponse = z.infer<typeof MachinesResponseSchema>;

export const ValidationSchema = z.object({ valid: z.boolean(), errors: z.array(z.string()), warnings: z.array(z.string()) });
export type Validation = z.infer<typeof ValidationSchema>;

export const FileDiffSchema = z.object({ path: z.string(), change: z.enum(['added', 'removed', 'modified']), diff: z.string() });
export type FileDiff = z.infer<typeof FileDiffSchema>;

export const CHANGE_KINDS = ['create', 'update', 'disable', 'deprecate', 'restore', 'remove', 'rollback'] as const;
export const ChangeKindSchema = z.enum(CHANGE_KINDS);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

export const ChangePreviewSchema = z.object({
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  kind: ChangeKindSchema, skill: z.string(), summary: z.string(), validation: ValidationSchema,
  files: z.array(FileDiffSchema), policyDiff: z.string(), targetPolicyDigest: z.string().nullable().optional(), targetDigest: z.string().nullable(), baseDigest: z.string().nullable(),
  baseRevision: z.string().nullable(), affectedAgents: z.array(z.string()), affectedHosts: z.array(z.string()),
  dependents: z.array(z.string()), blocked: z.array(z.string()), runningSessions: z.string(), rollbackTarget: z.string().nullable(),
});
export type ChangePreview = z.infer<typeof ChangePreviewSchema>;

/**
 * `proposed`: exported for review, nothing applied. `branch`: committed on a review branch by `skills apply`.
 * `pending`: local bytes match but review/default-branch provenance is unverified.
 * `live`: matching clean bytes, trusted accepted review receipt and recorded apply commit on the default tracking branch. `stale`: its base moved; make a new one.
 */
export const ChangeSchema = z.object({
  id: z.string(), kind: ChangeKindSchema, skill: z.string(), createdAt: z.string(), status: z.enum(['proposed', 'branch', 'pending', 'live', 'stale']),
  branch: z.string().nullable(), commit: z.string().nullable(), preview: ChangePreviewSchema,
});
export type Change = z.infer<typeof ChangeSchema>;

export const DraftSchema = z.object({
  name: z.string(), base: z.object({ id: z.string(), digest: z.string().nullable() }).nullable(), files: z.array(FileEntrySchema),
  updatedAt: z.string(), validation: ValidationSchema, digest: z.string().nullable(),
});
export type Draft = z.infer<typeof DraftSchema>;

export const SkillDetailResponseSchema = z.object({
  name: z.string(), row: SkillRowSchema, selected: SkillCandidateSchema.nullable(), instructions: z.string(),
  files: z.array(FileEntrySchema), history: z.array(HistoryEntrySchema), agents: z.array(AssignmentCellSchema),
  dependents: z.array(z.string()), hosts: z.array(z.object({ host: z.string(), agent: z.string(), runtime: z.string(), observed: z.string().nullable(), state: z.enum(SKILL_HOST_STATES), viewStatus: ViewStateSchema.shape.status.optional(), receivedAt: z.string() })),
  drafts: z.array(DraftSchema), changes: z.array(ChangeSchema), mode: ModeSchema,
});
export type SkillDetailResponse = z.infer<typeof SkillDetailResponseSchema>;

export const FileResponseSchema = z.object({ id: z.string(), path: z.string(), size: z.number().int(), kind: z.enum(['text', 'binary']), content: z.string().nullable(), truncated: z.boolean(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), version: z.string().regex(/^[0-9a-f]{64}$/).optional(), exec: z.boolean().optional() });
export type FileResponse = z.infer<typeof FileResponseSchema>;

export const AgentSkillsResponseSchema = z.object({ agent: AgentInfoSchema, mode: ModeSchema, cells: z.array(AssignmentCellSchema), notes: z.array(z.string()) });
export type AgentSkillsResponse = z.infer<typeof AgentSkillsResponseSchema>;

export const DraftsResponseSchema = z.object({ drafts: z.array(DraftSchema) });
export const ChangesResponseSchema = z.object({ changes: z.array(ChangeSchema) });

// ---- requests ----

export const DraftCreateRequestSchema = z.object({ name: SkillNameSchema, from: z.string().max(200).optional(), description: z.string().max(1024).optional() }).strict();
export type DraftCreateRequest = z.infer<typeof DraftCreateRequestSchema>;
/** Package-relative path: segments of safe characters, no `..`, no leading dot except `.env.example`-free names. */
export const PackagePathSchema = z.string().min(1).max(255).regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.\-/]+$/);
export const DraftFileWriteRequestSchema = z.object({ path: PackagePathSchema, content: z.string().max(512 * 1024), exec: z.boolean().optional(), expectedVersion: z.string().regex(/^[0-9a-f]{64}$/).nullable() }).strict();
export type DraftFileWriteRequest = z.infer<typeof DraftFileWriteRequestSchema>;
export const DraftFileDeleteRequestSchema = z.object({ expectedVersion: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type DraftFileDeleteRequest = z.infer<typeof DraftFileDeleteRequestSchema>;
export const ChangeRequestSchema = z.object({
  kind: ChangeKindSchema, skill: SkillNameSchema, draft: SkillNameSchema.optional(), replacement: SkillNameSchema.optional(),
  note: z.string().max(500).optional(), revision: z.string().regex(/^[0-9a-f]{7,40}$/).optional(), resolve: z.boolean().optional(),
  expectedPreviewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  expectedDraftDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
}).strict();
export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;

// ---- the machine acknowledgement protocol (POST /api/skills/ack, bearer device token) ----

export const ACK_LIMITS = { bytes: 256 * 1024, views: 64, skillsPerView: 500 } as const;
export const AckViewSchema = z.object({
  agent: AgentNameSchema, runtime: RuntimeSchema, viewDigest: DigestSchema.nullable(), generatedAt: z.string().datetime({ offset: true }).nullable(),
  status: z.enum(['current', 'not-ready', 'dirty', 'failed']), error: z.string().max(500).nullable(),
  excluded: z.array(ExclusionSchema).max(500).optional(),
  skills: z.array(z.object({ name: SkillNameSchema, id: SkillIdSchema, digest: DigestSchema })).max(ACK_LIMITS.skillsPerView),
  missing: z.array(z.object({ skill: SkillNameSchema, bins: z.array(z.string().max(64)).max(20), env: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)).max(20) })).max(ACK_LIMITS.skillsPerView),
  dirty: z.array(SkillNameSchema).max(ACK_LIMITS.skillsPerView),
}).strict();
export type AckView = z.infer<typeof AckViewSchema>;
export const AckRequestSchema = z.object({
  v: z.literal(1), engine: z.string().max(64).nullable(), policyDigest: DigestSchema.nullable(),
  views: z.array(AckViewSchema).max(ACK_LIMITS.views),
}).strict();
export type AckRequest = z.infer<typeof AckRequestSchema>;
export const AckResponseSchema = z.object({ host: z.string(), accepted: z.number().int(), receivedAt: z.string() });
export type AckResponse = z.infer<typeof AckResponseSchema>;
