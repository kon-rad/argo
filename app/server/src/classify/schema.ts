import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import type { DecisionSchema } from './types.js';

/**
 * Decision schemas are JSON files, one per decision: the question, its options or criteria, the
 * thresholds and the privacy ceiling. A vault's own file (`<vault>/<classify.schemasDir>/<decision>.json`)
 * wins over the engine's default in `vault-template/.agents/classify/`, which `secondbrain-vault init`
 * also copies into a new vault. Thresholds are the thing a vault edits, never code.
 */
const Name = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes');

export const Schema = z
  .object({
    $comment: z.string().optional(),
    decision: Name,
    version: z.string().min(1),
    primitive: z.enum(['bool', 'choice', 'score']),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(2).optional(),
    criteria: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional(),
    skipOptions: z.array(z.string().min(1)).optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    act: z.number().min(0).max(1),
    escalate: z.number().min(0).max(1),
    privacy: z.enum(['public', 'shared']),
    model: z.string().min(1).optional(),
    priceUsdPerMInput: z.number().min(0).default(0.042),
  })
  .superRefine((s, ctx) => {
    if (s.escalate > s.act) ctx.addIssue({ code: 'custom', path: ['escalate'], message: 'escalate must not be above act' });
    if (s.primitive === 'choice') {
      if (!s.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'a choice needs options' });
      for (const o of s.skipOptions ?? []) {
        if (!s.options?.includes(o)) ctx.addIssue({ code: 'custom', path: ['skipOptions'], message: `${o} is not an option` });
      }
    }
    if (s.primitive === 'score' && (s.min === undefined || s.max === undefined || s.min >= s.max)) {
      ctx.addIssue({ code: 'custom', path: ['min'], message: 'a score needs min < max' });
    }
    if (s.primitive === 'score' && Array.isArray(s.criteria) && s.criteria.length !== s.max! - s.min! + 1) {
      ctx.addIssue({ code: 'custom', path: ['criteria'], message: 'a score rubric needs one level per value from min to max' });
    }
  });

export type LoadedSchema = DecisionSchema & { priceUsdPerMInput: number; path: string };

export class ClassifyError extends Error {}

/** The engine's defaults: the files `secondbrain-vault init` copies into a new vault. */
export function defaultSchemasDir(): string {
  return resolve(config.appRoot, '..', 'vault-template', '.agents', 'classify');
}

export function parseSchema(raw: unknown, path = '<inline>'): LoadedSchema {
  const r = Schema.safeParse(raw);
  if (!r.success) {
    throw new ClassifyError(`${path}: ${r.error.issues.map((i) => `${i.path.join('.') || 'schema'}: ${i.message}`).join('; ')}`);
  }
  const { $comment: _c, ...rest } = r.data;
  return { ...rest, path };
}

/** The first `<dir>/<decision>.json` that exists, vault first, then the engine's defaults. */
export function loadSchema(decision: string, dirs: string[]): LoadedSchema {
  if (!Name.safeParse(decision).success) throw new ClassifyError(`decision "${decision}": lowercase letters, digits and dashes`);
  for (const dir of dirs) {
    const path = resolve(dir, `${decision}.json`);
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new ClassifyError(`${path}: ${(err as Error).message}`);
    }
    const s = parseSchema(raw, path);
    if (s.decision !== decision) throw new ClassifyError(`${path}: decision is "${s.decision}", file name says "${decision}"`);
    return s;
  }
  throw new ClassifyError(`no schema for "${decision}" in ${dirs.join(', ')}`);
}
