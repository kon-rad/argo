# Memory: what agents remember, where it is read, and how to check it works

A second brain has no single "memory". It has several stores that were added for different jobs, written by different parties and loaded at different moments. This page maps them: what each holds, who writes it, **where it is invoked** (the exact call sites), how to look at what is recorded, and how to tell whether it helps or just fills the context window.

It describes what the engine and a vault do today. Numbers in the "Measured" sections come from one vault on 2026-10-26 and are there to show the method; run the same checks on yours.

## The stores at a glance

| # | Store | What it holds | Written by | Loaded or searched when |
|---|---|---|---|---|
| 1 | **Vault markdown** | All prose: notes, research, plans, dev logs, the `## Resume` handoff blocks | People and agents editing files | `grep`/`find`, the search API, `cli-org recall` (as its vault arm) |
| 2 | **Vault index and vectors** (`vault_files`, `vault_links`, `vault_tags`, `vault_chunks`) | A derived copy of the markdown, with chunk embeddings | The scanner and `secondbrain embed`; never by hand | Search (`keyword`, `semantic`, `hybrid`), chat, recall |
| 3 | **Shared facts** (`memory_facts`) | One sourced claim per row: subject, claim (at most 1000 characters), source, author, confidence, validity window, supersession | Any agent through `cli-org remember` | `cli-org recall`, `cli-org facts`, the facts list on the `/org` page |
| 4 | **Bot memory files** (under `.agents/org/memory/`) | Hand-written notes about a bot's own work, one `<bot>.md` per bot | The bot, or you | The bot's definition can tell it to read the file; line-matched by `cli-org recall`; shown read-only on `/org/agents/<name>` |
| 5 | **Harness memory** (Claude Code's per-project `memory/` folder with a `MEMORY.md` index; Hermes' `memories/MEMORY.md` and `USER.md`) | Short notes the interactive agent keeps about you, your preferences and the project | The agent, when you ask it to remember or it decides to | The index is loaded into the context at the start of every session of that project |
| 6 | **Standing instructions** (`AGENTS.md`, `CLAUDE.md`, scoped `AGENTS.md` files) | Rules, not memories, but they are loaded every session and compete for the same context | You, through `AGENTS.local.md` and the compiler | Every session; scoped files when an agent first touches their folder |

Two history trails sit under these and are the main way to observe them:

- **The archive** (`archive_sessions`, `archive_messages`) keeps every Claude Code and Hermes session, including every tool call.
- **`archive_memory_versions`** keeps a copy of the harness memory files each time they change (sources `claude-memory` and `hermes-memory`), so you can see how a memory was edited.

!!! note "One fact, one layer"
    The vault rule is that a fact lives in one layer only. A record is a row; its prose is a note linked from the row. Prose trusts the markdown; records trust the database. When recall and a note disagree, say which one you trusted.

## Where each store is invoked

| Call site | What happens | Store |
|---|---|---|
| Session start (Claude Code, Hermes) | The harness reads `CLAUDE.md`/`AGENTS.md`, and the project's `MEMORY.md` index, into the context before your first message | 5, 6 |
| A scoped `AGENTS.md` | Loaded the first time an agent touches a file in that folder | 6 |
| A vault's `org-member` skill | Can tell a bot to `cli-org recall` what a card is about before it starts. A convention in a skill, not enforced code. The engine's copy only mentions recall in passing; a vault adds the explicit step | 1, 3, 4 |
| A vault skill such as `shared-memory` (a vault's own skill, not shipped in the engine) | Teaches every runtime when to `recall` (before a card, before a factual answer) and when to `remember` (a decision, a measured number, a gotcha that cost time) | 3 |
| A compiled bot definition | The vault's compiler can name the bot's memory file in its definition, and the bot reads it with a normal file read | 4 |
| `zen-agent` wake | The optional `recall` fetcher runs `cli-org recall` with the card's title (limit 6) and puts the hits in the system prompt as a capped part. Tools `org_recall` and `org_remember` are also available mid-run | 1, 3, 4 |
| Search API `GET /api/search` and the app's search page | `mode=keyword|semantic|hybrid` over the index | 1, 2 |
| Chat module | One retrieval per turn, every source shown (see [Retrieval and the chat module](rag.md)) | 2 |
| Archive run | Copies harness memory files into `archive_memory_versions` when their hash changes | 5 |

No automatic call to `recall` was found for an interactive Claude Code or Hermes session in the engine, its harness hooks or the vault's hooks; the `zen-agent` fetcher above covers headless wakes only. Interactive agents use recall only when a skill or their instructions say to.

## How `cli-org recall` works

`cli-org recall "<question>" [--project p] [--limit N] [--json]` merges three arms into one list, each hit labelled with its source:

| Arm | Label | How it matches |
|---|---|---|
| Shared facts | `[fact]` | Postgres full text (`websearch_to_tsquery('english', q)`, which ANDs every word), or the query as a substring of the subject or claim. When that finds nothing, a looser pass: a fact qualifies when it matches at least half of the query's terms, each as a word prefix ("401" finds "401s"). Current facts only (`valid_to IS NULL`). With `--project`, facts of that project and facts with no project |
| Bot memory files | `[memory]` | The query is cut into terms of three letters or more, minus question words ("how", "what", "does" and similar). Each line of the files under `.agents/org/memory/` is scored by how many terms start a word in it ("render" matches "renders", "how" never matches inside "show"). A line needs at least half of the terms. Best first; at most half of `--limit` lines are kept |
| Vault | `[vault]` | The app's hybrid search (keyword plus vector) when embeddings are configured, else keyword. `CURRENT/`, `Areas/Finance/` and `.env` never appear, plus any path prefix in `ORG_RECALL_EXCLUDE` (comma-separated). Hits are then trimmed: a hit the keyword branch found stays; a hit only the vector branch found never stands alone (if no hit has any keyword support, the arm returns nothing), fills at most half of `--limit`, and must clear `ORG_RECALL_MIN_SIMILARITY` (default 0.25, which cuts nothing; see below). Hits with the same title and snippet under two paths (a skill copied into a profile) take one slot |

**Why vector-only hits are not trusted.** On a vault embedded with `multilingual-e5-large-instruct`, cosine similarity does not separate good matches from noise: gibberish queries scored 0.80 to 0.85, an off-topic query 0.79, and a relevant query's best vector-only hit 0.82. No fixed floor works on that model, so recall asks for a second signal instead, a shared word. If your embedder spreads more widely, measure it (run a few nonsense queries and a few real ones through `hybridSearch`) and set `ORG_RECALL_MIN_SIMILARITY` above the nonsense scores.

Writing: `cli-org remember "<subject>" "<claim>" --source <path|#message|t_card|url> [--project p] [--inferred] [--supersedes id]`. A bot may only insert rows as itself (row-level security: `author = org_me()`), cannot update or delete, A fact is retired with `cli-org forget <id> "<why>"`, which sets `valid_to`; only its author, the author's team lead or the owner may do it. Nothing is deleted, so history stays.

A row can carry `via <runtime>@<host>` (flag `--via` or `ORG_VIA`). A vault can give agents on other machines the same verbs through a thin wrapper that runs `cli-org` on the server.

## Seeing what is recorded

| To see | Do this |
|---|---|
| Every shared fact, current and retired | `cli-org facts --all` (add `--json`, `--subject`, `--project`, `--author`) |
| Shared facts in the app | The `/org` page, Approvals tab, "Shared facts" list (current facts only, up to 100) |
| One bot's memory | Open `.agents/org/memory/<bot>.md`, or the bot's page `/org/agents/<name>` (read-only) |
| What `recall` returns for a question | `cli-org recall "<question>" --limit 8` and read the labels; add `--json` for scores |
| The interactive agent's memory | Claude Code: type `/memory`, or read `~/.claude/projects/<project>/memory/`. Hermes: `~/.hermes/memories/MEMORY.md` and `USER.md` |
| How a harness memory changed over time | `SELECT path, captured_at, length(content) FROM archive_memory_versions WHERE path = 'MEMORY.md' ORDER BY captured_at;` |
| Which sessions used memory | The query in "Is it being used?" below, or the Sessions view under `/usage` |
| What the index sees | The `/database` page, or `psql "$SECONDBRAIN_DB_URL"` on `vault_files`, `vault_chunks` |

`memory_facts` has row-level security with a read policy for the bot role only. Observed on one vault: the app's general database role could query the table and got 0 rows with no error. If `SELECT count(*) FROM memory_facts` says 0 and you expect facts, use `cli-org facts --all` instead of concluding the table is empty.

## Is it being used?

Recall is a tool call, so the archive can count it. This counts assistant messages that ran `recall` or `remember`, by harness:

```sql
SELECT s.harness,
       count(*) FILTER (WHERE m.raw::text ~ '(cli-)?org recall ')   AS recall_calls,
       count(*) FILTER (WHERE m.raw::text ~ '(cli-)?org remember ') AS remember_calls,
       count(DISTINCT m.session_id)                                AS sessions_using
FROM archive_messages m
JOIN archive_sessions s ON s.id = m.session_id
WHERE m.kind = 'assistant'
  AND m.raw::text ~ '(cli-)?org (recall|remember) '
  AND s.started_at >= now() - interval '30 days'
GROUP BY 1 ORDER BY 2 DESC;
```

Compare `sessions_using` with the number of sessions in the same window (`SELECT harness, count(*) FROM archive_sessions WHERE started_at >= now() - interval '30 days' GROUP BY 1`). The ratio is the adoption rate. Tool names for `zen-agent` runs are `org_recall` and `org_remember`; widen the pattern if you use that runtime.

### Measured (one vault, 2026-10-26)

| What | Value |
|---|---|
| Sessions started since the shared-memory skill shipped (2026-10-19) | 339 (197 Claude Code, 108 Hermes, 34 zen-agent) |
| Sessions in that window whose archive shows a `recall` or `remember` call (Claude Code 15, Hermes 2) | 17 (about 5 percent), with 62 recall and 19 remember calls between them |
| Shared facts | 40 current, 0 retired, 0 superseded, 36 confirmed and 4 inferred; written by 11 authors in 8 days; 30 of 40 tagged with a project |
| Median fact length | 265 characters (maximum 417; the cap is 1000) |

Read these as a baseline, not a verdict. The pattern matches only the CLI spelling, so calls made through another tool name are not counted. Zero retired facts in a growing table means nothing is being corrected yet, or that nothing has been wrong long enough to notice; the check below tells you which.

## Does it help? A recall test you can repeat

Build a **golden set**: 15 to 30 questions whose answer you already know, each with a string that must appear in the top hits (a path or a distinctive phrase). Run them through `recall` and score them. Rerun after any change to the index, the embedder, or the recall code.

```sh
# questions.txt: one per line, "question|expected substring"
while IFS='|' read -r q expect; do
  out=$(cli-org recall "$q" --limit 8 </dev/null)      # </dev/null: ssh wrappers swallow the loop's stdin
  hit=$(printf '%s\n' "$out" | grep -E '^\[' | grep -n -i -F -- "$expect" | head -1 | cut -d: -f1)
  printf '%s | first match at hit %s | %s chars\n' "$q" "${hit:-MISS}" "$(printf '%s' "$out" | wc -c)"
done < questions.txt
```

Track three numbers: **hit@8** (share of questions where the expected string appears), **first-hit position**, and **characters returned** (what the call costs the context).

### Measured (one vault, 2026-10-26)

| Test | Result |
|---|---|
| 10 known-answer questions, expected string in the top 8 | 9 of 10 (the miss was a vague "how do I render video") |
| Same questions, fact arm only, as paraphrases of 10 known facts | 5 of 10 returned the right fact, always at position 1; the other 5 returned no fact at all |
| Size of one `recall --limit 8` | 3.6 to 5 KB (roughly 1,000 to 1,300 tokens), every call |
| Nonsense query ("chocolate cake recipe zzzqx") | Still returned 8 vault hits, none relevant |
| Latency through the SSH wrapper | 1.6 to 3.8 s |

### Before and after the recall fixes (same vault, vault and memory arms, 13 queries)

| Probe | Before | After |
|---|---|---|
| 10 known-answer questions: expected source present | 10 of 10 | 10 of 10 |
| Size of those answers | 4.2 to 5.0 KB | 3.1 to 5.1 KB (median about 12 percent smaller) |
| Two nonsense queries | 8 hits each, 2.1 to 3.6 KB | 0 hits, 62 bytes ("nothing found") |
| "how do I render video": memory lines returned | 4, all about a board outage | 2, both mention video work |
| Fact lookup "why does cli-board return 401" | no fact | the fact (unit test; not run against the live table) |

The expected strings in that check are loose, so read it as "no loss found", not as a precision score. The fact arm cannot be run from a machine whose database role cannot read `memory_facts`.


## Is it making the context worse? (context rot)

Memory costs tokens twice: what is loaded **every session whether or not it is needed**, and what a **recall call returns whether or not it is relevant**. Measure both.

| Cost | How to measure | Measured (one vault) |
|---|---|---|
| Standing instructions | `wc -c AGENTS.md CLAUDE.md` plus scoped files | 26.7 KB (about 6,700 tokens) |
| Harness memory index | `wc -c ~/.claude/projects/<project>/memory/MEMORY.md` | 11.1 KB, 49 lines, 25 of them longer than 200 characters (about 2,800 tokens) |
| Bot memory files | `wc -c .agents/org/memory/*.md` | 15 files, 0.1 to 8.1 KB, 38.7 KB in all; the largest is read in full by its bot every wake |
| One recall call | Characters returned, from the test above | 3.6 to 5 KB |

Rule of thumb used here: 4 characters per token, which is an estimate, not a tokenizer count.

Signals that memory is hurting rather than helping:

1. **Irrelevant hits that fill the quota.** Before the fixes, recall returned `--limit` vault hits even for a nonsense query, because the vector branch's only cutoff is a cosine floor of 0.25 that every note clears. Now vector-only hits need a keyword hit beside them and fill at most half the quota; check that your own noise queries return nothing.
2. **Substring matching on common words.** The bot-memory arm used to treat "how" as a match inside "show", so "how do I render video" returned four lines about a board outage. It now ignores question words and matches word starts. Wrong-topic hits look authoritative because they carry a source label, so keep spot-checking.
3. **Duplicate documents in the hit list.** A vendored skill that exists under two folders used to take two of the eight vault slots. Hits with the same title and snippet now collapse; near-duplicates with different snippets still do not.
4. **Index lines that carry history instead of pointers.** A `MEMORY.md` index line is a pointer ("title, one-line hook"). When lines grow into status logs, the index is loaded in full every session while the detail it duplicates sits in a file nobody opened.
5. **Stale entries.** Memory describes the past. Check that the paths and names a memory cites still exist (a script that extracts backticked paths and runs `test -e` is a start; many paths are relative to another repo, so read the misses before deleting anything).
6. **Facts with no curation.** No retired or superseded facts after weeks of writes means `forget` and `--supersedes` are not being used.

## Recommendations

Done in the engine (the recall fixes):

| Change | Where |
|---|---|
| Vector-only vault hits need keyword support, are capped at half the quota, and can be floored with `ORG_RECALL_MIN_SIMILARITY` | `shapeVaultHits` in `org-powers.ts`, used by `recallVault` in `cli-org.ts` |
| Memory-file matching ignores question words and matches word starts; a line needs half the terms | `terms`, `recallMemoryFiles` |
| Fact lookups fall back to a looser pass when the strict query finds nothing | `recallFactsLoose` |
| Duplicate vault hits collapse | `dedupeVaultHits` |

Still proposals:

| Change | Why | Cost |
|---|---|---|
| Count recalls in the archive importer and expose them on the Usage page (calls per session, per bot, hits that were later quoted) | Turns "is it used?" from a query into a dashboard | Medium |
| Keep the harness memory index to pointers (about 150 characters a line) and move status into the linked file | Shrinks the always-loaded cost | Editing only |
| Run the golden set weekly and log hit@8, first-hit position and characters returned | A regression becomes visible | Small |
| Review facts monthly: retire or supersede any whose source changed | Keeps recall current | Process |
| Make recall an explicit first step in the skills that research or plan | Adoption was about 5 percent of sessions | Small |

How to judge a change: run the golden set before and after, and compare hit@8 and characters returned. A change that raises hit@8 and lowers characters is a clear win; one that does only the second is a win if hit@8 holds.

## What is confirmed and what is inferred

**Confirmed** (read in code or run on 2026-10-26, and checked against the engine's `main` by an independent reviewer): the three recall arms and their matching rules; the facts schema, row-level security and who may retire a fact; the archive and `archive_memory_versions` capture of the harness memory files; the `/org` facts list and the read-only bot memory view; the `zen-agent` recall fetcher and tools. The "Measured" numbers are from one live vault and were not independently reproduced.

**Inferred or not checked:** that Hermes injects `MEMORY.md` and `USER.md` into its prompt (the files and their archiving are confirmed; the injection is not); the token figures (character counts divided by four); whether the per-bot `memory: project` setting in a compiled definition creates a store on the server (no such folder was found, but only part of the server was searched); that the explanation for each missed fact lookup is the AND of terms (not run per miss); the adoption rate, which counts one spelling of the command.

**Open questions:** what share of recalled hits an agent actually quotes; how much of the always-loaded context any session actually uses.

## Sources

- Engine code: `app/server/src/cli-org.ts`, `app/server/src/org-powers.ts`, `app/db/migrations/1756000014000_bot-powers.sql`, `app/server/src/routes/org.ts`, `app/server/src/archive/run.ts`, `zen-agent/src/fetchers.ts`, `zen-agent/src/tools/org.ts`
- Skills: `org-member` (engine copy; a vault can extend it); `shared-memory` (an example of a vault's own skill)
- Related pages: [Retrieval and the chat module](rag.md), [Agent harness](agent-harness.md), [Self-improving orchestration (proposal)](self-improvement.md)
