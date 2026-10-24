# Retrieval and the chat module

How the app turns a vault of markdown into something you can ask questions of: the ingestion pipeline (chunk, enrich, embed), the retrieval pipeline (hybrid search, fusion, reranking, context assembly), and the `chat` module that sits on top. This page is the design record: what was there, what the field says works, what was chosen and why.

## 1. Where it started

The first version (still the backbone) was already sound:

| Piece | What it did |
|---|---|
| Chunking | Heading-aware, paragraph-packed chunks of ~400 tokens with ~60 tokens of overlap; code fences never split; every chunk prefixed with `Title > Heading > Subheading` and that prefix *embedded*, not just stored |
| Embedding | `intfloat/multilingual-e5-large-instruct` (1024-d) on Together, or any Ollama model; incremental by content hash; a model change invalidates every vector |
| Storage | `vault_chunks` in Postgres with pgvector, HNSW over cosine; a note's chunks cascade-delete with the note |
| Search | Keyword (`websearch_to_tsquery` + trigram substring over whole notes), semantic (chunk KNN collapsed to one row per note), hybrid (reciprocal rank fusion of the two, k = 60) |
| Query side | The asymmetric query prefix each encoder family expects (e5 `Instruct:/Query:`, bge instruction) |

What it lacked for question answering:

1. **Keyword search ran over whole notes, vector search over chunks.** Fusing them gave a good *note* ranking, but a question needs the right *passages*. A long note that matched on keywords contributed its whole body or nothing.
2. **No way to ask.** Search returned snippets; there was nothing that read them and answered.
3. **One LLM call site, one provider.** The database page's text-to-SQL box was hard-wired to Together. There was no shared way to call a chat model, stream it, or swap it.
4. **Chunks were embedded out of context.** A paragraph that says "we chose option B" embeds well only if the chunk also says what the options were. The heading prefix covers part of that; it cannot say what the note is about.

## 2. What the research says (October 2026)

Surveyed: practitioner guides and the recent literature on hybrid retrieval, contextual retrieval, query rewriting and reranking. The consistent findings, with what we did about each:

| Finding | Source | Decision |
|---|---|---|
| Hybrid retrieval (lexical + dense) fused with reciprocal rank fusion beats either alone, and the gap is widest on identifiers, acronyms and names, exactly what personal notes are full of | [Ukrainian RAG, 2026](https://arxiv.org/pdf/2604.22095); [hybrid search field notes](https://www.devya.dev/blogs/postgres-pgvector-hybrid-search-rag-field-notes); [buildmvpfast guide](https://www.buildmvpfast.com/blog/hybrid-search-rag-vector-keyword-reranking-2026) | Keep RRF (k = 60). Move the lexical arm to **chunk level** (a `tsvector` on `vault_chunks`) so both arms rank the same units, and fuse in one SQL statement |
| Cross-encoder reranking after fusion is the single most reliable precision gain; multi-stage (retrieve wide, rerank narrow) is the 2026 default | [TREC 2024 RAG](https://arxiv.org/pdf/2411.09607); [dbi-services](https://www.dbi-services.com/blog/rag-series-hybrid-search-with-re-ranking/); [RAG architecture guide 2026](https://jobsbyculture.com/blog/rag-architecture-guide-2026) | A `Reranker` interface with a Cohere-compatible HTTP implementation (Together's `/v1/rerank`, Cohere, Jina all speak it). **Off by default**: it is one more paid call per question and Together now serves rerankers on dedicated endpoints only ([Together docs](https://docs.together.ai/docs/together-and-llamarank)). Turn it on in the chat settings when you have one |
| Anthropic's contextual retrieval (prepend a short LLM-written description of where a chunk sits in its document before embedding and indexing) cut top-20 retrieval failures by 35% alone, 49% with contextual BM25, 67% with reranking | [Instructor write-up](https://python.useinstructor.com/blog/2024/09/26/implementing-anthropics-contextual-retrieval-with-async-processing/); [wz-it](https://wz-it.com/en/knowledge/ki/contextual-retrieval/); [2026 legal retrieval paper](https://arxiv.org/pdf/2606.21676) finds it on par with late chunking but slower to index | Implemented as an **optional** step in the embedder: one LLM call per note writes one line of context per chunk; the context is stored in its own column, embedded with the chunk, and indexed for keyword search. Off by default because it is an LLM call per note; a vault of a few thousand notes costs a few dollars once, then only changed notes pay |
| Query rewriting helps when the question is ambiguous or depends on conversation history; multi-query fusion raises raw recall but the gain is largely neutralised after reranking and truncation | [DMQR-RAG](https://arxiv.org/pdf/2411.13154); [enterprise fusion study, 2026](https://arxiv.org/abs/2603.02153v1); [RAGSmith](https://arxiv.org/pdf/2511.01386) | One small LLM call per turn **condenses** the latest question against the conversation into a standalone search query and, when the question is broad, up to two alternate phrasings. Alternates are fused by RRF and are skipped for the first turn of a conversation when the question is already specific |
| Chunks of 400 to 1000 tokens with heading context, kept self-contained; "small to big" (retrieve a small chunk, show the model its neighbours) recovers the context a tight chunk loses | [FutureAGI 2026](https://futureagi.com/blog/rag-architecture-llm-2025/); [Machine Learning Pills](https://mlpills.substack.com/p/issue-67-advanced-retrieval-strategies) | Chunk size unchanged (the encoder's 512-token window sets it). After ranking, each winning chunk is **expanded with its neighbours** (chunk index ±1 in the same note, merged when contiguous) up to a token budget |
| pgvector 0.8: `hnsw.ef_search` raises recall at query time; `hnsw.iterative_scan` fixes filtered queries that return too few rows; `halfvec` halves index size | [pgvector tutorial 2026](https://dataaspirant.com/blog/pgvector-tutorial/); [Postgres vector options compared](https://ecorpit.com/postgres-vector-search-pgvector-pgvectorscale-paradedb-lantern-2026/) | Retrieval sets `ef_search` to 100 and `iterative_scan = relaxed_order` for its own transaction (a folder filter is on the roadmap). Column stays `vector(1024)`: the index is small at vault scale and `halfvec` would be a rebuild for no measurable gain yet |

Things considered and not done, with the reason:

- **ParadeDB / pg_search for true BM25.** Postgres's `ts_rank_cd` is not BM25, but it ranks the lexical arm, and RRF only needs the *order*. Another extension is a real install cost for every user of the engine. Revisit if lexical quality is the bottleneck.
- **GraphRAG.** The vault already has a link graph; the 3D map draws it. Using wikilinks as a retrieval signal (pull in the notes a hit links to) is a cheap future step; a full entity graph is not justified for personal notes.
- **Late chunking / long-context embedders.** Needs an embedder with an 8k window; the default Together model has 512. The contextual-retrieval step gives most of the same benefit with any encoder.
- **Agentic retrieval (the model calls search as a tool in a loop).** More capable, but several times the latency and cost per question, and harder to show the user what was read. The chat keeps one retrieval per turn and shows every source. A tool-use mode can be added behind the same provider layer.

## 3. The ingestion pipeline

```
vault_files.body
   │  chunkMarkdown()            heading-aware packing, overlap, code fences intact
   ▼
chunks (content = "Title > Heading\n\n…")
   │  contextualize()  optional  one LLM call per note → one line of context per chunk
   ▼
embed(context + content)        e5 / Ollama, batched, bisect-and-retry on length errors
   ▼
vault_chunks (content, context, embedding, tsv)
                                tsv = to_tsvector(context ‖ content), GIN; HNSW on embedding
```

- `vault_chunks.context` is the enrichment line (empty when the step is off). `tsv` is a generated column over context and content, so both arms of hybrid retrieval see the same text.
- The step is configured on the Embeddings source (Sources page, `config`): `contextualize: true`, `context_provider`, `context_model`. The provider and model come from the same presets as the chat (section 5). When the call fails for a note, the note is embedded without context rather than skipped.
- Everything stays incremental: a note is re-embedded only when its hash changes, and the context is regenerated with it.

## 4. The retrieval pipeline

`app/server/src/rag/retrieve.ts`, used by the chat. One call per turn:

1. **Condense.** With a history, a small LLM call rewrites the latest message as a standalone query and optionally lists alternates. Without a history (or without an LLM) the message is the query.
2. **Hybrid chunk retrieval** per query, one SQL statement: top-k chunks by cosine (`ef_search = 100`) and top-k by `ts_rank_cd` over the chunk `tsv`, fused by RRF. The vector arm is skipped, and the response says so, when embeddings are unavailable.
3. **Cross-query fusion** by RRF when there were alternates.
4. **Rerank** (optional) the top candidates with a cross-encoder; keep the top N.
5. **Expand**: fetch neighbours (chunk index ±1) of each winner, merge contiguous spans, cap chunks per note and the total token budget.
6. **Assemble** numbered passages `[1]…[n]` with path and heading; the model is told to cite by number. The client turns `[n]` into links to the note.

The retrieval result (queries used, passages, timings, whether the vector arm ran) is sent to the client as the first streamed event and stored with the assistant message, so every answer keeps its sources.

## 5. The provider layer

`app/server/src/llm/`. One interface, `ChatProvider.stream(request)`, yielding text deltas and a final usage record.

| Provider id | Protocol | Key |
|---|---|---|
| `anthropic` | Anthropic Messages API (`@anthropic-ai/sdk`, streaming) | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI chat completions, SSE | `OPENAI_API_KEY` |
| `together` | OpenAI-compatible | `TOGETHER_API_KEY` (shared with embeddings and the database page) |
| `openrouter` | OpenAI-compatible | `OPENROUTER_API_KEY` |
| `ollama` | OpenAI-compatible, local | none (`OLLAMA_URL`) |

The **presets** (which providers exist, their base URLs, their model lists and the default model of each) live in `app/config/llm-presets.json`. A provider is *available* when its key is in the environment; the settings modal lists only those. A vault adds or overrides models without touching the engine in `secondbrain.json` under `chat.providers`, and sets its default provider, model and system prompt under `chat` (see [configuration.md](configuration.md)).

## 6. The chat module

`MODULES=chat`. Off, nothing is mounted. On:

| | |
|---|---|
| UI | A speech-bubble button at the right of the header opens a full-screen panel: conversation list on the left, the conversation (or a fresh one) in the centre, a persona dropdown and a model chip at the top, a gear for the settings modal |
| Settings modal | Provider, model (from the presets of the chosen provider), persona, the base system prompt (editable, with a reset), retrieval knobs (passages per answer, alternates on/off, reranker on/off and its model) |
| Personas | The default assistant plus every agent of the `org` module's chart (`org_agents`): the dropdown lists them by name and role; the selected agent's compiled definition (`.claude/agents/<name>.md` in the vault, minus frontmatter) is appended to the system prompt |
| Storage | `chat_conversations`, `chat_messages` (with the sources each answer used), `chat_settings` (one row). All module data: back it up if you care about it, it is not derived from markdown |
| API | `GET /api/chat/options`, `GET/PUT /api/chat/settings`, `GET/POST /api/chat/conversations`, `GET/PATCH/DELETE /api/chat/conversations/:id`, `POST /api/chat/conversations/:id/messages` (server-sent events: `sources`, `delta`, `done`, `error`) |

What a turn costs: one embedding call, one condensing call (skipped on a first turn with no alternates wanted), the answer. Reranking and contextual enrichment are opt-in.

## 7. Roadmap

- Folder and tag filters on retrieval (PARA scope), using pgvector's iterative scan.
- Wikilink expansion: pull the notes a top passage links to as low-ranked candidates.
- A retrieval eval: a small set of question → expected note pairs kept in the vault, run from the CLI, so a change to chunking or fusion is measured rather than felt.
- Tool-use mode: let the model run further searches when the first pass is not enough.
