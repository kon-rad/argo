import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * Local text-to-speech on the Mac: settings and the markdown → speech-text rules.
 *
 * The voice itself is Kokoro-82M served by mlx-audio on 127.0.0.1:8880
 * (launchd `com.argo.tts`). The settings file is also read by the Claude Code
 * Stop hook (`.agents/skills/speak/scripts/claude_stop_speak.py`), so its shape
 * is a contract: keep the keys stable and additive.
 */

export const VoiceSettingsSchema = z.object({
  /** Claude Code on this Mac says a one-line summary when a long task finishes. */
  autoSpeak: z.boolean().default(false),
  /** A Kokoro voice id. af_heart is the Friendly robot's voice. */
  voice: z.string().regex(/^[a-z]{2}_[a-z]+$/).default('af_heart'),
  /** A turn shorter than this stays silent: only long tasks are worth announcing. */
  minTaskSeconds: z.number().int().min(0).max(86_400).default(120),
});

export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

export const VoiceSettingsPatch = VoiceSettingsSchema.partial().strict();

export async function readVoiceSettings(file: string): Promise<VoiceSettings> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // Missing or unreadable: the defaults, which keep auto-speak off.
  }
  const parsed = VoiceSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : VoiceSettingsSchema.parse({});
}

export async function writeVoiceSettings(
  file: string,
  patch: Partial<VoiceSettings>,
): Promise<VoiceSettings> {
  const next = VoiceSettingsSchema.parse({ ...(await readVoiceSettings(file)), ...patch });
  await mkdir(dirname(file), { recursive: true });
  // Write-then-rename: the hook may read this file at any moment.
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, file);
  return next;
}

/** Longest note we voice in one go; past this the listener is told it was cut. */
export const MAX_SPEECH_CHARS = 20_000;

/**
 * A markdown note as something worth hearing: no frontmatter, code, URLs or
 * table pipes, headings and list items ending as sentences so the voice pauses.
 * The Python `speak` skill applies the same rules; change both together.
 */
export function speechText(markdown: string): { text: string; truncated: boolean } {
  let s = markdown.replace(/\r\n?/g, '\n');
  s = s.replace(/^---\n[\s\S]*?\n---\n/, '');
  s = s.replace(/```[\s\S]*?```/g, '\n');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<[^>\n]+>/g, '');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  s = s.replace(/!\[\[[^\]]*\]\]/g, '');
  s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) =>
    (alias ?? target.split('/').pop() ?? target).trim(),
  );
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, '');
  s = s.replace(/`([^`]+)`/g, '$1');

  const lines: string[] = [];
  for (let line of s.split('\n')) {
    line = line.trim();
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line)) continue; // table separator
    if (/^([-*_])\1{2,}$/.test(line)) continue; // horizontal rule
    if (line.startsWith('|')) {
      line = line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(', ');
    }
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/(\*\*|__|~~)/g, '')
      .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
      .trim();
    if (!line) {
      lines.push('');
      continue;
    }
    if (!/[.!?:;,]$/.test(line)) line += '.';
    lines.push(line);
  }

  let text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const truncated = text.length > MAX_SPEECH_CHARS;
  if (truncated) {
    const cut = text.lastIndexOf('.', MAX_SPEECH_CHARS);
    text = `${text.slice(0, cut > 0 ? cut + 1 : MAX_SPEECH_CHARS)}\n\nThe rest of this note was cut off.`;
  }
  return { text, truncated };
}
