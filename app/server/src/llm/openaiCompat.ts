import { LlmError, redactSecrets, type ChatEvent, type ChatProvider, type ChatRequest } from './types.js';

export interface OpenAiCompatConfig {
  id: string;
  model: string;
  /** e.g. https://api.together.xyz/v1 (no trailing slash). */
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** Extra headers some gateways want (OpenRouter's attribution headers). */
  headers?: Record<string, string>;
  /** Extra top-level request fields (`reasoning_effort: "none"` turns a thinking model's reasoning off). */
  body?: Record<string, unknown> | undefined;
}

interface Chunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string } | string;
}

/**
 * Splits a server-sent-events body into `data:` payloads. Events are separated
 * by a blank line; a payload may span several `data:` lines. Anything else
 * (comments, `event:` names) is ignored, which is what the spec says to do.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '');
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
      }
    }
    const tail = buf
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * The OpenAI chat-completions protocol, which Together, OpenRouter, Ollama and
 * OpenAI itself all speak. `stream_options.include_usage` makes the last chunk
 * carry token counts on the servers that support it; the others ignore it.
 */
export function openAiCompatProvider(cfg: OpenAiCompatConfig): ChatProvider {
  const fetchFn = cfg.fetchFn ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 180_000;
  return {
    id: cfg.id,
    model: cfg.model,
    async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      const messages = req.system ? [{ role: 'system', content: req.system }, ...req.messages] : req.messages;
      const headers: Record<string, string> = { 'content-type': 'application/json', ...cfg.headers };
      if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;
      const signal = req.signal
        ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);

      let res: Response;
      try {
        res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: cfg.model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            ...cfg.body,
            ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          }),
          signal,
        });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        throw new LlmError(0, `${cfg.id}: request failed: ${redactSecrets((err as Error).message, cfg.apiKey)}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = '';
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } | string };
          detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? '');
        } catch {
          detail = text.slice(0, 200);
        }
        throw new LlmError(res.status, `${cfg.id}: HTTP ${res.status}${detail ? `: ${redactSecrets(detail, cfg.apiKey)}` : ''}`);
      }
      if (!res.body) throw new LlmError(0, `${cfg.id}: empty response body`);

      let usage = { inputTokens: null as number | null, outputTokens: null as number | null };
      let stopReason: string | null = null;
      for await (const data of sseData(res.body)) {
        if (data === '[DONE]') break;
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data) as Chunk;
        } catch {
          continue; // a keep-alive or a partial line: not ours to fail on
        }
        if (chunk.error) {
          const msg = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'stream error');
          throw new LlmError(502, `${cfg.id}: ${redactSecrets(msg, cfg.apiKey)}`);
        }
        const choice = chunk.choices?.[0];
        const text = choice?.delta?.content;
        if (text) yield { type: 'delta', text };
        if (choice?.finish_reason) stopReason = choice.finish_reason;
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? usage.inputTokens,
            outputTokens: chunk.usage.completion_tokens ?? usage.outputTokens,
          };
        }
      }
      yield { type: 'done', usage, stopReason };
    },
  };
}
