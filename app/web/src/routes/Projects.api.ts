import type { ArchivedResponse, AreaIndexResponse, AreaPage, AreaPatch, ProjectListResponse, ProjectPage, ProjectPatch, ProjectVerificationRequest, StageChangedResponse, TrackerMarkdownResponse, TrackerReport, VerificationCreatedResponse } from '@secondbrain/contracts/projects';
import { json, request } from '../lib/http.js';

/** The tracker's API: areas (what you run) under /areas, projects (what you finish) under /projects/<area>/<project>. */
export const projectsApi = {
  report: () => request<TrackerReport>('/areas/report'),
  markdown: () => request<TrackerMarkdownResponse>('/areas/report', { format: 'markdown' }),
  setArea: (area: string, patch: AreaPatch) => request<StageChangedResponse>(`/areas/${area}`, undefined, json('PATCH', patch)),
  setProject: (area: string, project: string, patch: ProjectPatch) => request<StageChangedResponse>(`/projects/${area}/${project}`, undefined, json('PATCH', patch)),
  /** Every area, archived ones included, for `/areas`. */
  areaIndex: () => request<AreaIndexResponse>('/areas', { view: 'index' }),
  areaPage: (area: string) => request<AreaPage>(`/areas/${area}`),
  /** Projects across areas. `archived` adds the archived ones (and those of archived areas). */
  list: (archived = false) => request<ProjectListResponse>('/projects', { archived: archived ? 1 : undefined }),
  projectPage: (area: string, project: string) => request<ProjectPage>(`/projects/${area}/${project}`),
  /** Archive or unarchive an area, or one of its projects when `project` is given. The note goes into the change history. */
  setArchived: (archived: boolean, area: string, project: string | null, note?: string) =>
    request<ArchivedResponse>(`${project ? `/projects/${area}/${project}` : `/areas/${area}`}/${archived ? 'archive' : 'unarchive'}`, undefined, json('POST', note ? { note } : {})),
  verifyProject: (area: string, project: string, body: ProjectVerificationRequest) =>
    request<VerificationCreatedResponse>(`/projects/${area}/${project}/verifications`, undefined, json('POST', body)),
};

export { STAGES } from '@secondbrain/contracts/projects';
export type { AreaIndexRow, AreaKpi, AreaLink, AreaLinkGroup, AreaPage, ProjectPage, ProjectRow, TrackerEvent, AreaStatus, Stage, TrackerArea, TrackerGoal, TrackerItem, TrackerProject, TrackerReport, TrackerRollup, TrackerVerification } from '@secondbrain/contracts/projects';
