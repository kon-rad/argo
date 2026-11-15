import type { AreaPatch, ProjectPatch, ProjectVerificationRequest, StageChangedResponse, TrackerMarkdownResponse, TrackerReport, VerificationCreatedResponse } from '@secondbrain/contracts/projects';
import { json, request } from '../lib/http.js';

/** The tracker's API: areas (what you run) under /areas, projects (what you finish) under /projects/<area>/<project>. */
export const projectsApi = {
  report: () => request<TrackerReport>('/areas/report'),
  markdown: () => request<TrackerMarkdownResponse>('/areas/report', { format: 'markdown' }),
  setArea: (area: string, patch: AreaPatch) => request<StageChangedResponse>(`/areas/${area}`, undefined, json('PATCH', patch)),
  setProject: (area: string, project: string, patch: ProjectPatch) => request<StageChangedResponse>(`/projects/${area}/${project}`, undefined, json('PATCH', patch)),
  verifyProject: (area: string, project: string, body: ProjectVerificationRequest) =>
    request<VerificationCreatedResponse>(`/projects/${area}/${project}/verifications`, undefined, json('POST', body)),
};

export { STAGES } from '@secondbrain/contracts/projects';
export type { AreaStatus, Stage, TrackerArea, TrackerGoal, TrackerItem, TrackerProject, TrackerReport, TrackerRollup, TrackerVerification } from '@secondbrain/contracts/projects';
