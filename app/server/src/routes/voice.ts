import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { log } from '../logger.js';
import {
  readVoiceSettings,
  speechText,
  VoiceSettingsPatch,
  writeVoiceSettings,
} from '../voice.js';
import { HttpError, parseOr400, wrap } from './http.js';
import { resolveIndexed } from './vaultPath.js';

export interface VoiceOptions {
  vaultRoot: string;
  /** JSON settings, shared with the Claude Code Stop hook. */
  settingsFile: string;
  /** Rendered notes, keyed by a hash of text + voice + model. */
  cacheDir: string;
  /** mlx-audio's OpenAI-compatible server, e.g. http://127.0.0.1:8880 */
  ttsUrl: string;
  ttsModel: string;
  /** Overridden in tests so nothing calls a real speech server. */
  fetchFn?: typeof fetch;
}

const SPEAKABLE = new Set(['.md', '.markdown', '.txt']);

/**
 * Mac-only. Notes are spoken by a voice on this machine and nowhere else:
 * if the local server is down the request fails rather than falling back to a
 * cloud voice, because notes can be private.
 */
export function voiceRouter(opts: VoiceOptions): Router {
  const router = Router();
  const fetchFn = opts.fetchFn ?? fetch;

  async function serverUp(): Promise<boolean> {
    try {
      const res = await fetchFn(`${opts.ttsUrl}/`, { signal: AbortSignal.timeout(800) });
      return res.ok;
    } catch {
      return false;
    }
  }

  router.get(
    '/settings',
    wrap(async (_req, res) => {
      const [settings, up] = await Promise.all([readVoiceSettings(opts.settingsFile), serverUp()]);
      res.json({ settings, server: { url: opts.ttsUrl, model: opts.ttsModel, up } });
    }),
  );

  router.put(
    '/settings',
    wrap(async (req, res) => {
      const patch = parseOr400(VoiceSettingsPatch, req.body);
      const settings = await writeVoiceSettings(opts.settingsFile, patch);
      log.info(`voice settings: ${JSON.stringify(settings)}`);
      res.json({ settings });
    }),
  );

  router.post(
    '/speak',
    wrap(async (req, res) => {
      const { abs, key, row } = await resolveIndexed(opts.vaultRoot, (req.body as { path?: unknown })?.path);
      if (!SPEAKABLE.has(row.ext)) throw new HttpError(415, `only notes can be read aloud, not ${row.ext} files`);

      const { text, truncated } = speechText(await readFile(abs, 'utf8'));
      if (!text) throw new HttpError(422, 'this note has nothing to read aloud');

      const { voice } = await readVoiceSettings(opts.settingsFile);
      const hash = createHash('sha256').update(`${opts.ttsModel}\0${voice}\0${text}`).digest('hex');
      const cached = join(opts.cacheDir, `${hash}.mp3`);

      res.setHeader('X-Speech-Truncated', truncated ? '1' : '0');
      res.setHeader('X-Speech-Chars', String(text.length));
      try {
        const audio = await readFile(cached);
        res.setHeader('X-Speech-Cache', 'hit');
        res.type('audio/mpeg').send(audio);
        return;
      } catch {
        // Not rendered yet.
      }

      let upstream: Response;
      try {
        upstream = await fetchFn(`${opts.ttsUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: opts.ttsModel, input: text, voice, response_format: 'mp3' }),
          signal: AbortSignal.timeout(10 * 60_000),
        });
      } catch (err) {
        log.warn(`voice server unreachable at ${opts.ttsUrl}: ${String(err)}`);
        throw new HttpError(503, 'the local voice server is not running (launchd com.argo.tts on port 8880)');
      }
      if (!upstream.ok) {
        const detail = (await upstream.text().catch(() => '')).slice(0, 300);
        throw new HttpError(502, `the voice server failed (${upstream.status}): ${detail}`);
      }

      const audio = Buffer.from(await upstream.arrayBuffer());
      await mkdir(opts.cacheDir, { recursive: true });
      const tmp = `${cached}.tmp`;
      await writeFile(tmp, audio);
      await rename(tmp, cached);
      log.info(`spoke ${key}: ${text.length} chars, ${audio.length} bytes`);
      res.setHeader('X-Speech-Cache', 'miss');
      res.type('audio/mpeg').send(audio);
    }),
  );

  return router;
}
