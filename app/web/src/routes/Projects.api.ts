import type { FeaturePatch, FeatureVerificationRequest, ProjectPatch, ProjectsMarkdownResponse, StageChangedResponse, TrackerReport, VerificationCreatedResponse } from '@secondbrain/contracts/projects';
import { json, request } from '../lib/http.js';

export const projectsApi = {
  report: () => request<TrackerReport>('/projects/report'),
  markdown: () => request<ProjectsMarkdownResponse>('/projects/report', { format: 'markdown' }),
  setProject: (slug: string, patch: ProjectPatch) => request<StageChangedResponse>(`/projects/${slug}`, undefined, json('PATCH', patch)),
  setFeature: (slug: string, feature: string, patch: FeaturePatch) => request<StageChangedResponse>(`/projects/${slug}/features/${feature}`, undefined, json('PATCH', patch)),
  verifyFeature: (slug: string, feature: string, body: FeatureVerificationRequest) =>
    request<VerificationCreatedResponse>(`/projects/${slug}/features/${feature}/verifications`, undefined, json('POST', body)),
};

export { STAGES } from '@secondbrain/contracts/projects';
export type { Stage, TrackerFeature, TrackerGoal, TrackerItem, TrackerProject, TrackerReport, TrackerRollup, TrackerVerification } from '@secondbrain/contracts/projects';
