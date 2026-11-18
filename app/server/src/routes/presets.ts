import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, parseOr400, wrap } from './http.js';

/**
 * Chat presets: the saved way the Chat tab's "Preset" button starts a session. This only stores and lists them. The
 * launch itself is the page calling the same create route a manual New session uses (agent-hub or `zen-agent serve`),
 * which validate the model, tool sets and thinking level, so a preset adds no power the owner doesn't already have.
 *
 */

const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const short = z.string().trim().min(1).max(120);

/** Per-harness settings. Unknown keys are rejected so a typo can't be saved as if it were honoured. */
export const ClaudeConfig = z.object({
  model: z.enum(['opus', 'sonnet', 'haiku']).optional(),
  role: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional(),
}).strict();

export const ZenConfig = z.object({
  persona: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional(),
  /** `provider/id`, the form the zen new-session picker sends. */
  model: short.regex(/^[^/\s]+\/\S+$/).optional(),
  tools: z.enum(['full', 'read-only']).optional(),
  thinking: z.enum(THINKING).optional(),
}).strict();

const Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const Body = z.discriminatedUnion('harness', [
  z.object({ harness: z.literal('claude-code'), config: ClaudeConfig }),
  z.object({ harness: z.literal('zen-agent'), config: ZenConfig }),
]);

interface PresetRow { name: string; harness: 'claude-code' | 'zen-agent'; config: Record<string, unknown>; updated_at: string }

export function presetsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (_req, res) => {
      const { rows } = await query<PresetRow>(`SELECT name, harness, config, updated_at FROM chat_presets ORDER BY name`);
      res.set('Cache-Control', 'no-store').json({ presets: rows });
    }),
  );

  router.put(
    '/:name',
    wrap(async (req, res) => {
      const name = parseOr400(Name, req.params.name);
      const body = parseOr400(Body, req.body);
      const { rows } = await query<PresetRow>(
        `INSERT INTO chat_presets (name, harness, config) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (name) DO UPDATE SET harness = EXCLUDED.harness, config = EXCLUDED.config, updated_at = now()
         RETURNING name, harness, config, updated_at`,
        [name, body.harness, JSON.stringify(body.config)],
      );
      res.json({ preset: rows[0] });
    }),
  );

  router.delete(
    '/:name',
    wrap(async (req, res) => {
      const name = parseOr400(Name, req.params.name);
      const { rowCount } = await query(`DELETE FROM chat_presets WHERE name = $1`, [name]);
      if (!rowCount) throw new HttpError(404, 'no such preset');
      res.json({ ok: true });
    }),
  );

  return router;
}
