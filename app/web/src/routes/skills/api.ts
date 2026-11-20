import type {
  AgentSkillsResponse, Change, ChangePreview, ChangeRequest, Draft, DraftCreateRequest, DraftFileWriteRequest, FileResponse,
  LibraryResponse, MachinesResponse, MatrixResponse, SkillDetailResponse,
} from '@secondbrain/contracts/skills';
import { json, request } from '../../lib/http.js';

const enc = encodeURIComponent;

/** The skills addon's API (server: addons/skills/routes.ts). Every call is behind the login. */
export const skillsApi = {
  library: (refresh = false) => request<LibraryResponse>('/skills', refresh ? { refresh: 1 } : undefined),
  matrix: () => request<MatrixResponse>('/skills/matrix'),
  machines: () => request<MachinesResponse>('/skills/machines'),
  agent: (agent: string) => request<AgentSkillsResponse>(`/skills/agents/${enc(agent)}`),
  skill: (name: string, id?: string) => request<SkillDetailResponse>(`/skills/skill/${enc(name)}`, { id }),
  file: (name: string, id: string, path: string) => request<FileResponse>(`/skills/skill/${enc(name)}/file`, { id, path }),
  drafts: () => request<{ drafts: Draft[] }>('/skills/drafts'),
  draft: (name: string) => request<{ draft: Draft }>(`/skills/drafts/${enc(name)}`),
  createDraft: (body: DraftCreateRequest) => request<{ draft: Draft }>('/skills/drafts', undefined, json('POST', body)),
  draftFile: (name: string, path: string) => request<FileResponse>(`/skills/drafts/${enc(name)}/file`, { path }),
  writeDraftFile: (name: string, body: DraftFileWriteRequest) => request<{ draft: Draft }>(`/skills/drafts/${enc(name)}/file`, undefined, json('PUT', body)),
  deleteDraftFile: (name: string, path: string, expectedVersion: string) => request<{ draft: Draft }>(`/skills/drafts/${enc(name)}/file`, { path }, json('DELETE', { expectedVersion })),
  deleteDraft: (name: string) => request<{ ok: true }>(`/skills/drafts/${enc(name)}`, undefined, { method: 'DELETE' }),
  changes: () => request<{ changes: Change[] }>('/skills/changes'),
  preview: (body: ChangeRequest) => request<{ preview: ChangePreview }>('/skills/changes/preview', undefined, json('POST', body)),
  propose: (body: ChangeRequest) => request<{ change: Change }>('/skills/changes', undefined, json('POST', body)),
};

export type {
  AgentInfo, AgentSkillsResponse, AssignmentCell, AssignmentState, Change, ChangeKind, ChangePreview, ChangeRequest, Draft, FileEntry,
  FileResponse, HostState, LibraryResponse, MachinesResponse, MatrixResponse, Reason, SkillCandidate, SkillDetailResponse, SkillRow,
} from '@secondbrain/contracts/skills';
