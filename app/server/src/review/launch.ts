import { z } from 'zod';

export const LaunchRegistration = z.object({
  card:z.string().regex(/^t_[a-f0-9]{6,32}$/), builder:z.string().min(1).max(100), persona:z.string().min(1).max(100),
  runtime:z.string().min(1).max(100), model:z.string().min(1).max(200), host:z.string().min(1).max(200), repo:z.string().min(1).max(200),
  branch:z.string().min(1).max(500), worktree:z.string().startsWith('/').max(2000), commonDir:z.string().startsWith('/').max(2000),
  originalRunId:z.string().min(1).max(300), stage:z.enum(['plan','build','correction']).optional(),
}).strict();
export type LaunchRegistration=z.infer<typeof LaunchRegistration>;
