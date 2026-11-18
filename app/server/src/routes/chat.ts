import { Router, type Response } from 'express';
import { z } from 'zod';
import {
  addMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  readSettings,
  SettingsPatch,
  updateConversation,
  writeSettings,
  type SourceRef,
  type StoredSettingsT,
} from '../chat/store.js';
import { listPersonas, personaDefinition, DEFAULT_PERSONA } from '../chat/personas.js';
import { config } from '../config.js';
import { query } from '../db.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { buildChatProvider, pickProvider, providerCatalogWithMachines, type ProviderCatalog } from '../llm/registry.js';
import { LlmError, type ChatMessage, type ChatProvider } from '../llm/types.js';
import { log } from '../logger.js';
import { buildSystemPrompt } from '../rag/prompt.js';
import { cohereCompatReranker, type Reranker } from '../rag/rerank.js';
import { retrieve, type Passage } from '../rag/retrieve.js';
import { HttpError, intParam, parseOr400, wrap } from './http.js';

export interface ChatOptions {
  vaultRoot: string;
  /** Throws when semantic search is not configured; the chat then retrieves by keyword alone. */
  embeddingProvider: () => EmbeddingProvider;
  /** Overridden in tests with a fake model. */
  buildProvider?: (id: string, model: string) => ChatProvider;
  /** Overridden in tests with a fixed catalog. */
  catalog?: () => ProviderCatalog | Promise<ProviderCatalog>;
  /** Overridden in tests; otherwise built from RERANK_URL and RERANK_API_KEY. */
  reranker?: () => Reranker | null;
}

const CreateBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  persona: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});
const PatchBody = z.object({ title: z.string().trim().min(1).max(200).optional(), persona: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional() }).strict();
const SendBody = z.object({
  content: z.string().trim().min(1).max(20_000),
  /** Per-message overrides; otherwise the conversation's pins, then the settings. */
  provider: z.string().optional(),
  model: z.string().optional(),
  persona: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional(),
});

/** How many earlier turns the model sees; older ones are summarised by their absence. */
const HISTORY_MESSAGES = 20;
const TITLE_CHARS = 60;
const SNIPPET_CHARS = 240;

function defaultReranker(): Reranker | null {
  if (!config.rerankUrl || !config.rerankApiKey) return null;
  return cohereCompatReranker({ baseUrl: config.rerankUrl, apiKey: config.rerankApiKey, model: config.rerankModel });
}

/** What the settings resolve to on this install: a provider that has a key and one of its models. */
export function resolveModel(catalog: ProviderCatalog, wanted: { provider?: string | null; model?: string | null }): { provider: string; model: string } | null {
  const option = pickProvider(catalog, wanted.provider);
  if (!option) return null;
  // A model is honoured only for the provider it was chosen for; a custom id
  // (not in the presets) is allowed, since the lists are only suggestions.
  const model = (!wanted.provider || wanted.provider === option.id) && wanted.model ? wanted.model : option.default;
  return { provider: option.id, model };
}

function sourceRefs(passages: Passage[]): SourceRef[] {
  return passages.map((p) => {
    const body = p.content.includes('\n\n') ? p.content.slice(p.content.indexOf('\n\n') + 2) : p.content;
    return {
      n: p.n,
      path: p.path,
      title: p.title,
      heading_path: p.heading_path,
      chunk_from: p.chunk_from,
      chunk_to: p.chunk_to,
      score: Number(p.score.toFixed(4)),
      snippet: body.length > SNIPPET_CHARS ? `${body.slice(0, SNIPPET_CHARS).trimEnd()}…` : body,
    };
  });
}

function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function chatRouter(opts: ChatOptions): Router {
  const router = Router();
  const catalog = opts.catalog ?? (() => providerCatalogWithMachines());
  const build = opts.buildProvider ?? ((id: string, model: string) => buildChatProvider(id, model));
  const reranker = opts.reranker ?? defaultReranker;

  const embedding = (): EmbeddingProvider | null => {
    try {
      return opts.embeddingProvider();
    } catch {
      return null;
    }
  };

  /** The stored settings with the provider, model and prompt they resolve to here. */
  async function effective(stored: StoredSettingsT, cat: ProviderCatalog) {
    const resolved = resolveModel(cat, stored);
    return {
      ...stored,
      resolved: {
        provider: resolved?.provider ?? null,
        model: resolved?.model ?? null,
        system_prompt: stored.system_prompt ?? cat.systemPrompt,
        rerank_available: reranker() !== null,
        embeddings: embedding() !== null,
      },
    };
  }

  router.get(
    '/options',
    wrap(async (_req, res) => {
      const cat = await catalog();
      const [personas, stored] = await Promise.all([listPersonas(), readSettings()]);
      const { rows } = await query<{ chunks: number; model: string | null }>(
        `SELECT count(*)::int AS chunks, (SELECT model FROM vault_chunks LIMIT 1) AS model FROM vault_chunks`,
      );
      res.json({
        providers: cat.providers,
        default_provider: cat.defaultProvider,
        default_system_prompt: cat.systemPrompt,
        personas,
        settings: await effective(stored, cat),
        embeddings: { chunks: rows[0]?.chunks ?? 0, model: rows[0]?.model ?? null, configured: embedding() !== null },
        rerank: { available: reranker() !== null, model: config.rerankModel },
      });
    }),
  );

  router.get(
    '/settings',
    wrap(async (_req, res) => {
      res.json({ settings: await effective(await readSettings(), await catalog()) });
    }),
  );

  router.put(
    '/settings',
    wrap(async (req, res) => {
      const patch = parseOr400(SettingsPatch, req.body);
      const cat = await catalog();
      if (patch.provider && !cat.providers.some((p) => p.id === patch.provider)) {
        throw new HttpError(400, `unknown provider "${patch.provider}"`);
      }
      if (patch.persona && !(await personaDefinition(opts.vaultRoot, patch.persona))) {
        throw new HttpError(400, `unknown persona "${patch.persona}"`);
      }
      const stored = await writeSettings(patch);
      log.info(`chat settings: ${JSON.stringify(stored)}`);
      res.json({ settings: await effective(stored, cat) });
    }),
  );

  router.get(
    '/conversations',
    wrap(async (_req, res) => {
      res.json({ conversations: await listConversations() });
    }),
  );

  router.post(
    '/conversations',
    wrap(async (req, res) => {
      const body = parseOr400(CreateBody, req.body ?? {});
      if (body.persona && !(await personaDefinition(opts.vaultRoot, body.persona))) throw new HttpError(400, `unknown persona "${body.persona}"`);
      const stored = await readSettings();
      res.status(201).json({
        conversation: await createConversation({ title: body.title, persona: body.persona ?? stored.persona, provider: body.provider, model: body.model }),
      });
    }),
  );

  router.get(
    '/conversations/:id',
    wrap(async (req, res) => {
      const id = intParam(req.params['id'], 'conversation id');
      const conversation = await getConversation(id);
      if (!conversation) throw new HttpError(404, `no conversation ${id}`);
      res.json({ conversation, messages: await listMessages(id) });
    }),
  );

  router.patch(
    '/conversations/:id',
    wrap(async (req, res) => {
      const id = intParam(req.params['id'], 'conversation id');
      const patch = parseOr400(PatchBody, req.body);
      if (patch.persona && !(await personaDefinition(opts.vaultRoot, patch.persona))) throw new HttpError(400, `unknown persona "${patch.persona}"`);
      const conversation = await updateConversation(id, patch);
      if (!conversation) throw new HttpError(404, `no conversation ${id}`);
      res.json({ conversation });
    }),
  );

  router.delete(
    '/conversations/:id',
    wrap(async (req, res) => {
      const id = intParam(req.params['id'], 'conversation id');
      if (!(await deleteConversation(id))) throw new HttpError(404, `no conversation ${id}`);
      res.status(204).end();
    }),
  );

  /**
   * One turn, streamed as server-sent events: `sources` once retrieval is
   * done, `delta` per piece of text, then `done` with the stored message, or
   * `error`. The user's message is stored before anything can fail; a partial
   * answer is stored too, marked as such, so a dropped connection does not
   * lose what was said.
   */
  router.post(
    '/conversations/:id/messages',
    wrap(async (req, res) => {
      const id = intParam(req.params['id'], 'conversation id');
      const body = parseOr400(SendBody, req.body);
      const conversation = await getConversation(id);
      if (!conversation) throw new HttpError(404, `no conversation ${id}`);

      const cat = await catalog();
      const stored = await readSettings();
      const choice = resolveModel(cat, {
        provider: body.provider ?? conversation.provider ?? stored.provider,
        model: body.model ?? conversation.model ?? stored.model,
      });
      if (!choice) {
        throw new HttpError(503, 'no chat provider is configured: set one of the provider keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, TOGETHER_API_KEY, OPENROUTER_API_KEY) or run Ollama');
      }
      let model: ChatProvider;
      try {
        model = build(choice.provider, choice.model);
      } catch (err) {
        throw new HttpError(503, err instanceof Error ? err.message : String(err));
      }
      const personaId = body.persona ?? conversation.persona ?? stored.persona;
      const persona = (await personaDefinition(opts.vaultRoot, personaId)) ?? { ...DEFAULT_PERSONA, prompt: null };

      const prior = await listMessages(id);
      const history: ChatMessage[] = prior.slice(-HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
      await addMessage({ conversationId: id, role: 'user', content: body.content });
      if (prior.length === 0) {
        const title = body.content.replace(/\s+/g, ' ').trim();
        await updateConversation(id, { title: title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title });
      }

      const controller = new AbortController();
      res.on('close', () => controller.abort());
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const started = Date.now();
      let answer = '';
      let usage: Record<string, unknown> = {};
      let sources: SourceRef[] = [];
      let retrievalMeta: Record<string, unknown> = {};
      let failure: string | null = null;
      try {
        const retrieval = await retrieve(body.content, {
          embedding: embedding(),
          llm: model,
          history,
          topK: stored.retrieval.top_k,
          multiQuery: stored.retrieval.multi_query,
          reranker: stored.retrieval.rerank ? reranker() : null,
          signal: controller.signal,
        });
        sources = sourceRefs(retrieval.passages);
        retrievalMeta = { queries: retrieval.queries, vector: retrieval.vector, keyword: retrieval.keyword, reranked: retrieval.reranked, ms: retrieval.ms };
        sse(res, 'sources', { sources, ...retrievalMeta });

        const system = buildSystemPrompt({
          base: stored.system_prompt ?? cat.systemPrompt,
          persona: persona.builtin ? null : { name: persona.name, role: persona.role, prompt: persona.prompt },
          passages: retrieval.passages,
        });
        for await (const ev of model.stream({ system, messages: [...history, { role: 'user', content: body.content }], signal: controller.signal })) {
          if (ev.type === 'delta') {
            answer += ev.text;
            sse(res, 'delta', { text: ev.text });
          } else {
            usage = { input_tokens: ev.usage.inputTokens, output_tokens: ev.usage.outputTokens, stop_reason: ev.stopReason };
          }
        }
      } catch (err) {
        if (controller.signal.aborted) failure = 'cancelled';
        else {
          failure = err instanceof LlmError ? err.message : err instanceof Error ? err.message : String(err);
          log.warn(`chat turn failed: ${failure}`);
        }
      }

      const message = await addMessage({
        conversationId: id,
        role: 'assistant',
        content: answer || (failure ? `*No answer: ${failure}*` : ''),
        sources,
        meta: {
          provider: choice.provider,
          model: choice.model,
          persona: persona.id,
          usage,
          retrieval: retrievalMeta,
          ms: Date.now() - started,
          ...(failure ? { error: failure, partial: answer.length > 0 } : {}),
        },
      });
      if (controller.signal.aborted) {
        res.end();
        return;
      }
      if (failure) sse(res, 'error', { message: failure, message_id: message.id });
      sse(res, 'done', { message, conversation: await getConversation(id) });
      res.end();
    }),
  );

  return router;
}
