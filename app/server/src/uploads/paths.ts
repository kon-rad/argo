import { posix } from 'node:path';

/** The top-level vault folders an upload may land in (PARA). Anything else is refused. */
export const UPLOAD_ROOTS = ['Projects', 'Areas', 'Research', 'Archives'] as const;

export const MIN_PART_BYTES = 64 * 1024 ** 2;
const MAX_PARTS = 9000; // S3 allows 10 000; keep headroom

export class UploadInputError extends Error {}

/**
 * The leaf name of the file as it will be stored: no folders, no characters that break a path or a
 * shell, no `.b2.md` ending (that suffix marks a stub).
 */
export function cleanFilename(raw: string): string {
  const leaf = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const name = leaf
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (!name) throw new UploadInputError('file name is empty');
  if (Buffer.byteLength(name) > 200) throw new UploadInputError('file name is longer than 200 bytes');
  if (name.toLowerCase().endsWith('.b2.md')) throw new UploadInputError('a .b2.md file is a stub, not an upload');
  return name;
}

/** `Areas/x/vlogs/` -> `Areas/x/vlogs`; throws unless it is a relative path under a PARA folder. */
export function cleanDestDir(raw: string): string {
  const parts = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) throw new UploadInputError('choose a folder');
  if (parts.length > 12) throw new UploadInputError('folder is nested too deep');
  // eslint-disable-next-line no-control-regex
  if (parts.some((p) => p === '.' || p === '..' || /[\u0000-\u001f\u007f:*?"<>|]/.test(p))) {
    throw new UploadInputError('folder has an invalid segment');
  }
  if (!(UPLOAD_ROOTS as readonly string[]).includes(parts[0]!)) {
    throw new UploadInputError(`folder must start with ${UPLOAD_ROOTS.join(', ')}`);
  }
  return parts.join('/');
}

export function inboxKey(id: string, filename: string): string {
  return `inbox/${id}/${filename}`;
}

/** One part is at least 64 MiB, and large enough that the file stays under 9000 parts. */
export function partSizeFor(sizeBytes: number): number {
  const mib = 1024 ** 2;
  const need = Math.ceil(sizeBytes / MAX_PARTS / mib) * mib;
  return Math.max(MIN_PART_BYTES, need);
}

export function partCountFor(sizeBytes: number, partSize: number): number {
  return Math.ceil(sizeBytes / partSize);
}

/** `name.mp4`, taken -> `name-2.mp4`, `name-3.mp4` ... */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const ext = posix.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Suggest a preset folder from words in the file name and description (case-insensitive, whole-word or substring of a keyword). */
export function suggestDestination<T extends { keywords: string[]; label: string }>(
  presets: readonly T[],
  text: string,
): T | null {
  const hay = text.toLowerCase();
  let best: { preset: T; score: number } | null = null;
  for (const preset of presets) {
    const words = [preset.label, ...preset.keywords].map((k) => k.toLowerCase()).filter(Boolean);
    const score = words.reduce((n, w) => (hay.includes(w) ? n + w.length : n), 0);
    if (score > 0 && (!best || score > best.score)) best = { preset, score };
  }
  return best?.preset ?? null;
}

/** A double-quoted YAML scalar. JSON strings are valid YAML. */
export function yamlString(s: string): string {
  return JSON.stringify(s);
}

export function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function stubMarkdown(opts: {
  name: string;
  b2Path: string;
  bytes: number;
  uploadedAt: Date;
  description: string;
  tags: string[];
  uploadId: string;
}): string {
  const { name, b2Path, bytes, uploadedAt, description, tags, uploadId } = opts;
  const day = uploadedAt.toISOString().slice(0, 10);
  const fm = [
    '---',
    'type: b2-media',
    `b2_path: ${b2Path}`,
    `bytes: ${bytes}`,
    `mtime: ${uploadedAt.toISOString().replace(/\.\d+Z$/, 'Z')}`,
    `uploaded: ${day}`,
    'source: browser-upload',
    `upload_id: ${uploadId}`,
    ...(description ? [`description: ${yamlString(description)}`] : []),
    ...(tags.length ? ['tags:', ...tags.map((t) => `  - ${yamlString(t)}`)] : []),
    '---',
  ];
  return [
    ...fm,
    `# ${name} (in Backblaze B2)`,
    '',
    `The ${name} file (${humanBytes(bytes)}) was uploaded from the browser on ${day} and is stored encrypted in B2 at \`${b2Path}\`. This note stands in for it wherever the file itself is not on disk.`,
    ...(description ? ['', description] : []),
    '',
    '**Watch or download:** open this note in the Second Brain web app.',
    '',
    '**Work on it (agent/shell):**',
    '',
    '```bash',
    `LOCAL=$(b2store fetch "${b2Path}")   # downloads to scratch, 6h lease`,
    '# ... edit, caption, cut $LOCAL; b2store put big outputs back ...',
    'b2store release "$LOCAL"',
    '```',
    '',
  ].join('\n');
}
