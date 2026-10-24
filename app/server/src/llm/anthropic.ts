import Anthropic from '@anthropic-ai/sdk';
import { LlmError, redactSecrets, type ChatEvent, type ChatProvider, type ChatRequest } from './types.js';

export interface AnthropicConfig {
  model: string;
  apiKey: string;
  baseUrl?: string | undefined;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Models whose safety classifiers may decline a request mid-stream and that
 * accept the server-side fallback chain (`fallbacks: "default"`), which
 * re-runs the request on a model the classifier allows. Haiku has no
 * fallback; older models never refuse this way.
 */
const FALLBACK_MODELS = /^claude-(opus-5|sonnet-5-5|fable-5)/;

/**
 * The Anthropic Messages API through the official SDK, streaming. Thinking is
 * left at the model's default (adaptive on the current generation) and no
 * sampling parameters are sent: the current API version refuses them.
 */
export function anthropicProvider(cfg: AnthropicConfig): ChatProvider {
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs ?? 180_000,
    maxRetries: 2,
    ...(cfg.fetchFn ? { fetch: cfg.fetchFn } : {}),
  });
  return {
    id: 'anthropic',
    model: cfg.model,
    async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      // The Messages API has no system role inside `messages`: anything the
      // caller put there is folded into the top-level system prompt.
      const systemParts = [req.system, ...req.messages.filter((m) => m.role === 'system').map((m) => m.content)].filter(
        (s): s is string => Boolean(s),
      );
      const messages = req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      const fallback = FALLBACK_MODELS.test(cfg.model);

      let stream;
      try {
        stream = client.beta.messages.stream(
          {
            model: cfg.model,
            max_tokens: req.maxTokens ?? 8192,
            ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
            messages,
            ...(fallback ? { fallbacks: 'default' as const, betas: ['server-side-fallback-2026-07-01'] } : {}),
          },
          { signal: req.signal },
        );
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
            yield { type: 'delta', text: event.delta.text };
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') {
          yield { type: 'delta', text: '\n\n*The model declined to answer this request.*' };
        }
        yield {
          type: 'done',
          usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
          stopReason: final.stop_reason,
        };
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (err instanceof Anthropic.APIError) {
          throw new LlmError(err.status ?? 0, `anthropic: HTTP ${err.status ?? 0}: ${redactSecrets(err.message, cfg.apiKey)}`);
        }
        if (err instanceof LlmError) throw err;
        throw new LlmError(0, `anthropic: ${redactSecrets((err as Error).message, cfg.apiKey)}`);
      }
    },
  };
}
