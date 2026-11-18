import { z } from 'zod';

export const SearchModeSchema = z.enum(['keyword', 'semantic', 'hybrid']);
export type SearchMode = z.infer<typeof SearchModeSchema>;
export const SearchScopeSchema = z.enum(['notes', 'records', 'agents']);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const SearchRequestSchema = z.object({
  q: z.string(), source: z.enum(['vault', 'discord']).optional(), offset: z.number().int(), limit: z.number().int(), mode: SearchModeSchema,
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchHitSchema = z.object({
  source_kind: z.string(), ref_id: z.string(), ref_path: z.string(), title: z.string().nullable(), snippet: z.string(), rank: z.number(),
  occurred_at: z.string(), match_kind: z.enum(['text', 'filename', 'semantic', 'hybrid']).optional(), similarity: z.number().nullable().optional(),
  heading_path: z.string().nullable().optional(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResponseSchema = z.object({
  q: z.string(), mode: SearchModeSchema, results: z.array(SearchHitSchema), total: z.number().int(), has_more: z.boolean(), degraded: z.boolean().optional(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const RecordHitSchema = z.object({
  table: z.string(), label: z.string(), id: z.string(), title: z.string(), snippet: z.string(), notes_path: z.string().nullable(),
});
export type RecordHit = z.infer<typeof RecordHitSchema>;

export const AgentHitSchema = z.object({
  host: z.string(), source: z.string(), external_id: z.string(), harness: z.string().nullable(), session_title: z.string().nullable(),
  step: z.string().nullable(), role: z.string(), seq: z.number().int(), ts: z.string().nullable(), snippet: z.string(),
});
export type AgentHit = z.infer<typeof AgentHitSchema>;

export const searchSectionSchema = <T extends z.ZodType>(result: T) => z.object({
  results: z.array(result), total: z.number().int(), has_more: z.boolean(), error: z.string().optional(), degraded: z.boolean().optional(),
});
export type SearchSection<T> = { results: T[]; total: number; has_more: boolean; error?: string; degraded?: boolean };

export const GlobalSearchRequestSchema = z.object({
  q: z.string(), scopes: z.array(SearchScopeSchema), mode: SearchModeSchema, offset: z.number().int(), limit: z.number().int(),
});
export type GlobalSearchRequest = z.infer<typeof GlobalSearchRequestSchema>;

export const GlobalSearchResponseSchema = z.object({
  q: z.string(), mode: SearchModeSchema, available: z.array(SearchScopeSchema),
  notes: searchSectionSchema(SearchHitSchema).optional(), records: searchSectionSchema(RecordHitSchema).optional(), agents: searchSectionSchema(AgentHitSchema).optional(),
});
export type GlobalSearchResponse = z.infer<typeof GlobalSearchResponseSchema>;
