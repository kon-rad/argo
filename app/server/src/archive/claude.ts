import { clean, sha256 } from './clean.js';
import type { ParsedMessage } from './types.js';

export interface ClaudeChunk {
  messages: ParsedMessage[];
  consumedBytes: number;
  linesConsumed: number;
  title: string | null;
  model: string | null;
}

function blockText(b: any): string {
  if (typeof b === 'string') return b;
  if (!b || typeof b !== 'object') return '';
  switch (b.type) {
    case 'text': return b.text ?? '';
    case 'thinking': return `[thinking] ${b.thinking ?? ''}`;
    case 'tool_use': return `[tool_use ${b.name}] ${JSON.stringify(b.input ?? {})}`;
    case 'tool_result':
      return typeof b.content === 'string' ? b.content
        : Array.isArray(b.content) ? b.content.map(blockText).filter(Boolean).join('\n') : '';
    default: return '';
  }
}

/** Plain text of one transcript record, for full-text search. */
export function claudeText(rec: any): string {
  const content = rec?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join('\n');
  if (rec?.type === 'ai-title') return rec.aiTitle ?? '';
  if (rec?.type === 'system' && typeof rec.content === 'string') return rec.content;
  return '';
}

function roleOf(type: unknown): string {
  return type === 'user' || type === 'assistant' || type === 'system' ? type : 'meta';
}

/**
 * Parses complete lines only. A session still being written usually ends in a
 * partial line; it is left for the next run by reporting fewer consumed bytes.
 */
export function parseClaudeJsonl(buf: Buffer, startLine: number): ClaudeChunk {
  const lastNl = buf.lastIndexOf(0x0a);
  const consumedBytes = lastNl + 1;
  const lines = consumedBytes ? buf.subarray(0, consumedBytes).toString('utf8').split('\n').slice(0, -1) : [];
  const messages: ParsedMessage[] = [];
  let title: string | null = null;
  let model: string | null = null;

  lines.forEach((line, i) => {
    const seq = startLine + i + 1;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      const raw = clean({ line });
      messages.push({ seq, externalId: `line:${seq}`, parentExternalId: null, role: 'meta', kind: 'unparseable',
        ts: null, contentText: '', raw, rawSha: sha256(line), isSidechain: false });
      return;
    }
    if (rec?.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle;
    if (rec?.type === 'assistant' && rec.message?.model) model = rec.message.model;
    const ts = typeof rec?.timestamp === 'string' && !Number.isNaN(Date.parse(rec.timestamp)) ? new Date(rec.timestamp) : null;
    messages.push({
      seq,
      externalId: typeof rec?.uuid === 'string' ? rec.uuid : `line:${seq}`,
      parentExternalId: typeof rec?.parentUuid === 'string' ? rec.parentUuid : null,
      role: roleOf(rec?.type),
      kind: typeof rec?.type === 'string' ? rec.type : 'unknown',
      ts,
      contentText: clean(claudeText(rec)),
      raw: clean(rec),
      rawSha: sha256(line),
      isSidechain: rec?.isSidechain === true,
    });
  });

  return { messages, consumedBytes, linesConsumed: lines.length, title, model };
}
