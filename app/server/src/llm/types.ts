/**
 * One interface over every chat model the app can call. The chat module, the
 * retrieval pipeline's query condenser, the embedder's contextual-enrichment
 * step and (eventually) the database page all go through it, so swapping a
 * provider is a settings change and never a code change.
 */

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatRequest {
  /** The system prompt; sent in whatever form the provider's protocol wants. */
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Ignored by providers whose current API version refuses sampling parameters. */
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: ChatUsage; stopReason: string | null };

export interface ChatProvider {
  /** The preset id: `anthropic`, `openai`, `together`, `openrouter`, `ollama`. */
  id: string;
  model: string;
  /** Yields text deltas as they arrive and exactly one `done` at the end. */
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;
}

/** Collects a whole answer when streaming is not needed (the condenser, the contextualizer). */
export async function complete(provider: ChatProvider, req: ChatRequest): Promise<{ text: string; usage: ChatUsage }> {
  let text = '';
  let usage: ChatUsage = { inputTokens: null, outputTokens: null };
  for await (const ev of provider.stream(req)) {
    if (ev.type === 'delta') text += ev.text;
    else usage = ev.usage;
  }
  return { text, usage };
}

/**
 * Carries the HTTP status and never the credential: the key travels in a
 * header, and an error body is one upstream change away from echoing it.
 */
export class LlmError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Scrubs anything credential-shaped out of upstream error text. */
export function redactSecrets(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join('[redacted]');
  return out
    .replace(/\b(?:sk|pk|rk|api|key|token)[-_][A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]');
}
