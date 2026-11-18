import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { config } from './config.js';
import { query } from './db.js';
import { settings } from './settings.js';
import { OrgError } from './org.js';

/**
 * Agent portraits (docs/org-yaml.md, "Avatars"). An agent's org entry may name
 * `avatar` (a vault-relative image the app serves at /api/org/avatar/<name>)
 * and `avatar_prompt` (what to draw). `cli-org avatar generate` turns the
 * prompt into the image with a Gemini image model: the shared style text and a
 * reference picture from `secondbrain.json` (`org.avatars`) go in front of the
 * agent's own prompt, so every portrait in the company reads as one set. The
 * API key is GEMINI_API_KEY; nothing here runs without it, and nothing is sent
 * anywhere unless the owner runs the command.
 */

export const DEFAULT_AVATAR_MODEL = 'gemini-3-pro-image-preview';

/** The style every portrait shares when the vault's settings give none. */
export const DEFAULT_AVATAR_STYLE =
  'A square portrait of one character for a team roster, head and shoulders, centred, facing the viewer. ' +
  'Low-poly faceted sculpture in one warm metallic colour on a plain dark background, flat studio light, ' +
  'no text, no letters, no logos, no watermark, no frame, nothing cropped at the edge.';

export interface AvatarSubject {
  name: string;
  role: string;
  expertise?: string | null;
  avatar?: string | null;
  avatar_prompt?: string | null;
}

export interface AvatarSettings {
  dir: string;
  reference?: string | undefined;
  style?: string | undefined;
  model: string;
}

export function avatarSettings(): AvatarSettings {
  return settings().org.avatars;
}

/** The text sent to the model: the shared style, then the agent's own prompt (or its role when it has none). */
export function avatarPrompt(a: AvatarSubject, style: string | undefined = avatarSettings().style): string {
  const own = a.avatar_prompt?.trim() || `A portrait that says "${a.role}"${a.expertise ? `: ${a.expertise}` : ''}.`;
  return `${(style ?? DEFAULT_AVATAR_STYLE).trim()}\n\nThis character: ${a.name}, ${a.role}.\n${own}`;
}

/**
 * The absolute path of a vault-relative file, or null when the path leaves the
 * vault (absolute, `..`, or a symlink is not followed here: the route checks the
 * resolved path again). Avatars are served from the vault, so this is the gate.
 */
export function resolveVaultFile(vaultRoot: string, rel: string | null | undefined): string | null {
  if (!rel || isAbsolute(rel) || rel.includes('\0')) return null;
  const abs = resolve(vaultRoot, normalize(rel));
  const inside = relative(resolve(vaultRoot), abs);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
  return abs;
}

const EXT_BY_MIME: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MIME_BY_EXT: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export function mimeOf(path: string): string | null {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? null;
}

/** Where a new portrait goes: next to the existing one, else `<org.avatars.dir>/<name><ext>`. */
export function avatarTarget(a: AvatarSubject, mime: string, dir: string = avatarSettings().dir): string {
  const ext = EXT_BY_MIME[mime] ?? '.jpg';
  const folder = a.avatar ? dirname(a.avatar) : dir;
  return join(folder, `${a.name}${ext}`);
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

interface GeminiPart { text?: string; inlineData?: { mimeType: string; data: string } }

/** One generateContent call to the Gemini API; returns the first image part. */
export async function generateImage(opts: {
  apiKey: string;
  model: string;
  prompt: string;
  reference?: { mime: string; data: Buffer } | undefined;
  fetchImpl?: FetchLike;
}): Promise<{ mime: string; bytes: Buffer; note: string | null }> {
  const parts: GeminiPart[] = [{ text: opts.prompt }];
  if (opts.reference) parts.push({ inlineData: { mimeType: opts.reference.mime, data: opts.reference.data.toString('base64') } });
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1', imageSize: '1K' } },
  };
  const f = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new OrgError(`image model ${opts.model}: HTTP ${res.status} ${text.slice(0, 300)}`);
  let parsed: { candidates?: { content?: { parts?: GeminiPart[] } }[]; promptFeedback?: { blockReason?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OrgError(`image model ${opts.model}: not JSON: ${text.slice(0, 200)}`);
  }
  const out = parsed.candidates?.[0]?.content?.parts ?? [];
  const image = out.find((p) => p.inlineData?.data);
  const note = out.map((p) => p.text).filter((t): t is string => !!t).join(' ').trim() || null;
  if (!image?.inlineData) throw new OrgError(`image model ${opts.model} returned no image${parsed.promptFeedback?.blockReason ? ` (${parsed.promptFeedback.blockReason})` : ''}${note ? `: ${note.slice(0, 200)}` : ''}`);
  return { mime: image.inlineData.mimeType || 'image/png', bytes: Buffer.from(image.inlineData.data, 'base64'), note };
}

export interface GenerateResult {
  name: string;
  path: string;
  skipped: 'exists' | 'dry-run' | null;
  note: string | null;
  bytes: number;
}

/**
 * Make one agent's portrait: skip when its file exists (unless `force`), else
 * call the model with the reference image, write the file under the vault and
 * return its vault-relative path. The caller records the path (`cli-org avatar
 * generate` updates the row and prints the org-file line to add).
 */
export async function generateAvatar(a: AvatarSubject, opts: {
  vaultRoot?: string;
  apiKey?: string | undefined;
  force?: boolean;
  dryRun?: boolean;
  fetchImpl?: FetchLike;
  dir?: string;
  settings?: AvatarSettings;
}): Promise<GenerateResult> {
  const vaultRoot = opts.vaultRoot ?? config.vaultRoot;
  const s = opts.settings ?? avatarSettings();
  const existing = resolveVaultFile(vaultRoot, a.avatar);
  if (existing && existsSync(existing) && !opts.force) return { name: a.name, path: a.avatar!, skipped: 'exists', note: null, bytes: 0 };
  const prompt = avatarPrompt(a, s.style);
  if (opts.dryRun) return { name: a.name, path: avatarTarget(a, 'image/jpeg', opts.dir ?? s.dir), skipped: 'dry-run', note: prompt, bytes: 0 };
  const apiKey = opts.apiKey ?? process.env['GEMINI_API_KEY'];
  if (!apiKey) throw new OrgError('GEMINI_API_KEY is not set; cli-org avatar generate needs it in the environment');
  let reference: { mime: string; data: Buffer } | undefined;
  if (s.reference) {
    const refPath = resolveVaultFile(vaultRoot, s.reference);
    const mime = refPath ? mimeOf(refPath) : null;
    if (!refPath || !mime || !existsSync(refPath)) throw new OrgError(`org.avatars.reference ${s.reference} is not an image inside the vault`);
    reference = { mime, data: await readFile(refPath) };
  }
  const img = await generateImage({ apiKey, model: s.model, prompt, reference, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const rel = avatarTarget(a, img.mime, opts.dir ?? s.dir);
  const abs = resolveVaultFile(vaultRoot, rel);
  if (!abs) throw new OrgError(`avatar path ${rel} leaves the vault`);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, img.bytes);
  return { name: a.name, path: rel, skipped: null, note: img.note, bytes: img.bytes.length };
}

/** Subjects from the roster (bots only: a human's picture is not generated). */
export async function subjectsFromDb(names?: string[]): Promise<AvatarSubject[]> {
  const { rows } = await query<AvatarSubject>(
    `SELECT name, role, expertise, avatar, avatar_prompt FROM org_agents
      WHERE retired_at IS NULL AND runtime NOT IN ('human', 'session') ${names?.length ? 'AND name = ANY ($1)' : ''} ORDER BY name`,
    names?.length ? [names] : [],
  );
  if (names?.length) for (const n of names) if (!rows.some((r) => r.name === n)) throw new OrgError(`unknown or retired agent "${n}"`);
  return rows;
}

/** Subjects from a compiled org file (`cli-org import` input), for a vault whose database has no roster yet. */
export function subjectsFromOrgFile(doc: { agents?: Record<string, { runtime?: string; role?: string; expertise?: string; avatar?: string; avatar_prompt?: string }> }, names?: string[]): AvatarSubject[] {
  const out: AvatarSubject[] = [];
  for (const [name, a] of Object.entries(doc.agents ?? {})) {
    if (a.runtime === 'human' || a.runtime === 'session') continue;
    if (names?.length && !names.includes(name)) continue;
    out.push({ name, role: a.role ?? '', expertise: a.expertise ?? null, avatar: a.avatar ?? null, avatar_prompt: a.avatar_prompt ?? null });
  }
  if (names?.length) for (const n of names) if (!out.some((r) => r.name === n)) throw new OrgError(`no bot named "${n}" in the org file`);
  return out;
}

/** Record a generated portrait on the roster row (no-op when the roster has no such agent). */
export async function setAvatar(name: string, path: string): Promise<boolean> {
  const { rowCount } = await query(`UPDATE org_agents SET avatar = $2, updated_at = now() WHERE name = $1`, [name, path]);
  return (rowCount ?? 0) > 0;
}
