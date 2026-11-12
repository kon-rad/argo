import type { GlobalSearchResponse, SearchMode, SearchResponse, SearchScope } from '@secondbrain/contracts/search';
import { request } from './http.js';

export const searchApi = {
  search: (q: string, source?: string, offset = 0, limit = 25, mode: SearchMode = 'keyword') =>
    request<SearchResponse>('/search', { q, source, offset, limit, mode }),
  globalSearch: (q: string, scopes: SearchScope[], mode: SearchMode, offset = 0, limit = 10) =>
    request<GlobalSearchResponse>('/search/global', { q, scopes: scopes.join(','), mode, offset, limit }),
};

export type { AgentHit, GlobalSearchResponse, RecordHit, SearchHit, SearchMode, SearchResponse, SearchScope } from '@secondbrain/contracts/search';
