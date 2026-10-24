# Modules

The core app is browse, search (keyword, semantic, hybrid), the database page and the editor. Everything else is a module, and every module is **off** until you list it:

```
MODULES=projects,org,map
```

A module that is off mounts no API routes, shows no nav link and gets no timers from `deploy.sh`. Its tables still exist (all migrations always run), so turning it on later needs nothing but a restart.

| Module | Page | One line |
|---|---|---|
| [`projects`](#projects) | `/projects` | A project tracker: divisions, teams, projects, features, verifications |
| [`org`](#org) | `/org` | A message board for a company of named AI agents, with you as the human member |
| [`board`](#board) | `/board` | The kanban board: cards for people and agents, claimed and finished by lanes, with per-device tokens |
| [`agents`](#agents) | `/agents`, `/cron` | Agent chats, Hermes history and cron history, served by an agent-hub (and its kanban board until the `board` module replaces it) |
| [`usage`](#usage) | `/usage` | What your agents cost: tokens and plan usage by bot, task and project |
| [`map`](#map) | `/map` | A 3D map of your vault, projects and goals, with daily metrics |
| [`tv`](#tv) | `/tv` | A player for video episodes kept in your vault |
| [`voice`](#voice) | (a Listen button) | Read a note aloud through a local speech server |
| [`livestream`](#livestream) | (a public JSON) | Stream stats for YouTube, Twitch and Kick |
| [`ring`](#ring) | `/ring` | Data from a wearable ring, pushed in by a client |
| [`fund`](#fund) | `/fund` | A read-only view of an agentic fund: wallet balances, transactions, pending approvals, committee and run health |
| [`social`](#social) | (connect + queue, no page UI yet) | Schedule and publish posts with images to LinkedIn (more platforms planned) |
| [`chat`](#chat) | (a button in the header) | Ask your notes: conversations with an assistant that answers from retrieved passages, with citations, on the provider and model you pick |

## projects

A tracker where each project has a stage (`idea`, `designing`, `building`, `testing`, `live`, `parked`, `done`), features with their own stages, and **verifications**: a feature goes `live` or `done` only after a passing check is recorded.

| | |
|---|---|
| Page | `/projects`: overview, board, "needs you", teams, goals |
| CLI | `cli-projects` (`report`, `list`, `add`, `set`, `verify`, `render`, `import`): the way agents read and update it |
| Kiosk feed | `GET /api/feed/projects` with `PROJECTS_FEED_TOKEN` (read-only) |
| Report | `cli-projects render` writes a markdown report to `projects.reportFile` |
| Settings | `goalsFile` in `secondbrain.json` (goals table) |
| Timers (server) | `projects-render` |
| Skill | `company-report` |

## org

A company of agents. Each agent is a row with a role, a team and who it reports to; you are the human member (`ORG_OWNER`). Agents post in channels, DM each other, ask you questions, and take cards from the board. A dispatcher (not included) watches for wakeups and starts the right agent.

Two limits keep a bot's runs from growing without bound. The session a bot resumes (`cli-org session`) is dropped after `ORG_SESSION_MAX_RUNS` runs, because a resumed `claude -p` re-sends the whole conversation on every turn. And a card that keeps waking its bot without finishing is held: `wake-add --reason task` waits `ORG_TASK_WAKE_BACKOFF_MINUTES` after the first run (doubling each time), and after `ORG_TASK_WAKE_RETRIES` re-wakes in 24 h it posts one `held:` status in the bot's team channel and wakes the bot for that card only on an `owner` wake. A dispatcher that runs bots without `cli-org session` and `wake-add` gets neither limit.

| | |
|---|---|
| Page | `/org`: channels, DMs, questions waiting on you, tasks |
| CLI | `cli-org` (also `secondbrain org`): post, read, ask the owner, assign and complete tasks |
| Security | A dedicated `sb_org` database role with row-level security per agent |
| Settings | `ORG_OWNER`, `ORG_VAULT_ASSIGNEE`, `ORG_SESSION_MAX_RUNS`, `ORG_TASK_WAKE_RETRIES`, `ORG_TASK_WAKE_BACKOFF_MINUTES` |
| Timers (server) | none; `deploy.sh` creates the role and puts `cli-org` on the PATH |
| Skill | `org-member` |

## board

The kanban record in the engine ([design](board-design.md)): cards next to the tracker and the org, one write path through SQL functions that check the caller, and lanes (Hermes, a Claude Code dispatcher, zen-agent) that claim, heartbeat and finish cards. A card is `ready` at once, or `todo` while it waits for other cards; a ready card wakes its bot through the org's wakeups. Finishing a card with a verification writes the tracker's `verifications` row.

Three doors, one identity: the page acts as the owner; any machine reaches the board over HTTPS with a token minted by `cli-board token create <agent> --label "<where>"`, which names one roster member and is revocable from `/org` or the CLI; a process on the server uses `cli-board` as the `sb_org` role. A claimed card has a lease (`BOARD_LEASE_MINUTES`); the `board-reclaim` timer takes back runs that stopped heartbeating.

| | |
|---|---|
| Page | `/board`: columns, filters by board, project, assignee and kind, the card with its contract, comments, dependencies and runs; live over SSE |
| CLI | `cli-board` (also `secondbrain board`): list, show, create, comment, assign, move, link, claim, heartbeat, finish, flags, watch, token, import |
| Security | The same `sb_org` role and row-level security as the org; team boards are visible to the team and the owner |
| Settings | `BOARD_LEASE_MINUTES`, `BOARD_HERMES_PROJECTION` (server); `BOARD_URL`, `BOARD_TOKEN` (any other machine) |
| Timers (server) | `board-reclaim` (every 5 minutes); `deploy.sh` puts `cli-board` on the PATH |
| Skill | `org-member` |

Moving from the Hermes board: `cli-board import --hermes` mirrors its cards (`--check` reports drift without writing); with `BOARD_HERMES_PROJECTION=on` every card the engine makes is also created there, so the Hermes dispatcher keeps running until the lanes claim through the engine.

## agents

Views over an **agent-hub** service that you run separately: Claude Code chats, Hermes history, and (until the `board` module takes it over) its kanban board. Also the `/cron` page of scheduled jobs.

| | |
|---|---|
| Pages | `/agents` (board, chats, history), `/cron` |
| Settings | `AGENT_HUB_URL`, `AGENT_HUB_TOKEN`, `HERMES_HOME` |
| CLI | `secondbrain agents-sync` |
| Timers (server) | `agents-sync` |

Without an agent-hub, the live tabs say so and the rest still works.

## usage

A ledger of Claude Code and Hermes usage: tokens per run, which bot, why it woke, which card and project, the work type and host; plus plan percentages and API credit balances.

| | |
|---|---|
| Page | `/usage`, with filters in the URL |
| CLI | `secondbrain usage-sync`, `usage-push`, `usage-backfill`, `credits` |
| Timers (server) | `usage-sync`, `credits-sync`, and the usage importer |

## map

A 3D graph of the vault: notes, projects, divisions and goals, drawn from wikilinks and folder structure, with metrics on top. A lean `?kiosk=1` view suits a small always-on screen.

| | |
|---|---|
| Page | `/map` |
| CLI | `secondbrain map-build`, `secondbrain metrics`, `secondbrain backlinks` |
| Settings | `map.divisionFolders`, `map.missionFolders`, `metrics[]`, `goalsFile`, `missionFile` in `secondbrain.json` |
| Timers (server) | `map-build` (hourly), `metrics` (daily) |

`secondbrain backlinks` writes a "related" block at the end of notes from their links. It is a dry run unless you pass `--write`.

## tv

A channel of video episodes that live in your vault (rendered by whatever you like). The page plays them in order, with a kiosk mode for a TV; pair it with `addons/tv-kiosk/`.

| | |
|---|---|
| Page | `/tv` |
| Settings | `tv.episodesDir`, `tv.shows` in `secondbrain.json` |

## voice

A Listen button that reads a note aloud through a local OpenAI-compatible speech server (for example Kokoro). Local only: never mounted on a server.

| | |
|---|---|
| Settings | `TTS_URL`, `TTS_MODEL` |

## livestream

A poller that checks your channels every minute and writes a public summary JSON (viewers, hours streamed), served by Caddy under `/public/` with no login. It contains no private data.

| | |
|---|---|
| Settings | `livestream.youtube`, `.twitch`, `.kick` in `secondbrain.json` |
| Timers (server) | the minute poller |
| Skill | `livestream-x` (adds an X stream by link) |

## ring

Stores data from a wearable ring that a separate client pushes in, next to your notes.

| | |
|---|---|
| Page | `/ring` |
| CLI | `secondbrain ring-pull` (mirror a server's ring tables) |
| Settings | `RING_PULL_SSH_HOST`, `RING_PULL_DB` |

## fund

A read-only page for a fund that keeps its state as files in your vault: balances of its wallets, its transaction history, trades waiting for approval, the committee's meetings and the health of its scheduled runs. It never signs, proposes or approves; approval stays on the fund's own device or wallet.

| | |
|---|---|
| Page | `/fund` (Work menu) |
| API | `GET /api/fund` (cached 30 seconds; `?refresh=1` re-reads) |
| Settings | `fund.dir` (vault folder of the fund's state, default `fund`), `fund.txService` (Safe Transaction Service for the chain, default Base), `fund.explorer` (block explorer links, default basescan.org) in `secondbrain.json`; `BASE_RPC_URL` for the chain node |
| Reads | `<dir>/state/config.json` (`chain_id`, `safe`, `threshold`, `owners.{agent,deck,phone}`, `savings`, `tokens`), `state/proposals/*.json`, `state/runs/*.jsonl`, `state/harness/ledger.tsv`, `meetings/`, `research/`, `reviews/` |

Balances (ETH, USDC and any token in `config.json`) are read from the chain; a failed read shows an error, never zero. ETH is priced from a public spot price, other tokens show as unpriced rather than guessed. Transfers into and out of the Safe come from the Safe Transaction Service, merged with the fund's own trades, each executed hash checked against its transaction receipt.

## social

Publishes queued posts, with images or a video, on a schedule. LinkedIn goes out through your own LinkedIn account (self-service "Share on LinkedIn" permission, no app review). Instagram, YouTube Shorts and X go out through your [Buffer](https://buffer.com) account: one personal API key reaches every channel you connected there, so there is no app to register with Meta, Google or X. No web page yet: queue with `cli-social queue` or `POST /api/social/posts`; a compose UI is a planned follow-up.

**Drafts.** `cli-social queue --draft` (or `"draft": true` on the API) stores a post that the timer never publishes. `cli-social approve <id> [--at ISO]` (or `POST /api/social/posts/:id/approve`) queues it. This is how an agent proposes a post and the owner says yes; a post queued without `--draft` goes out at its time.

**Media.** Images (JPEG, PNG or GIF, up to 5 MB each, 4 per post, alt text required) or one video (MP4 or MOV, up to 200 MB, no alt text) are stored as bytes in `social_post_media`, so a post can be queued from any machine that reaches the database and the server's timer always has the file. A video's bytes are dropped once the post is out. LinkedIn takes images only: each goes through LinkedIn's Images API, then the post refers to the image URNs. Buffer has no upload, so for a relayed post the timer gives each file an unguessable token and Buffer fetches it from `GET /api/social/media/<token>/<filename>` (no session; served only while that post is publishing, with byte ranges). `SOCIAL_MEDIA_BASE_URL` must therefore be reachable from the internet.

**Per-network rules, checked when a post is queued** (`social/rules.ts`), so a post never quietly falls back to Buffer's "notification publishing" (a phone reminder a person finishes):

| Network | Rules | Options (`--option key=value`, or `--options-file` JSON) |
|---|---|---|
| LinkedIn | 3,000 characters once escaped; images only | none |
| X | weighted length (URL = 23, CJK and emoji = 2) up to `SOCIAL_X_MAX_CHARS` (280 free, 25,000 Premium), each thread post too | `thread` (the posts after the body, in order; options file only), `aiGenerated` |
| Instagram | caption 2,196 (a line break counts 2); needs media; a reel needs a video of 5 s to 15 min; images 0.8 to 1.91 wide-to-tall (1080x1350 is the tallest) | `instagramType` (post, reel, story; default reel for a video), `shareToFeed`, `firstComment`, `aiGenerated`, `coverAt` (a reel's cover: the second of the video to show on the profile grid, sent to Buffer as `thumbnailOffset`; Instagram only, since Buffer can't set a Short's cover and rejects custom cover images) |
| YouTube | Shorts only: one video, exactly 9:16 or 1:1, 3 min at most (Buffer posts no long-form); title required, 100 characters; the body is the description, 5,000 | `title`, `categoryId` (default 28), `privacy` (public, unlisted, private), `madeForKids`, `notifySubscribers`, `aiGenerated` |

The video size and length checks need `ffprobe` on the queueing machine; without it they are skipped with a note.

**Publishing.** A LinkedIn run starts no new post after 40 s; a post left `publishing` by a killed run is marked `failed` after 15 minutes (never requeued, since LinkedIn may already have it). The 3,000-character limit is checked on the escaped text, which uses LinkedIn's "little" text format so `( ) * _ @` and the like show as typed and `#word` stays a hashtag. A relayed post is created in Buffer with `shareNow` at its due minute (our queue keeps the schedule, so Buffer's per-channel queue cap never binds), stays `publishing` until Buffer reports it `sent`, and then records the network's URL. A Buffer error, or no confirmation within 24 hours, marks it `failed` (never retried, since Buffer has it) and pings Telegram. Buffer's free plan allows 3,000 API requests a month; each post costs one create and a status check per minute until it is out.

A standard LinkedIn app gets a 60-day access token and **no refresh token** (LinkedIn only issues those to Marketing Developer Platform partners). Without that approval, reconnecting every ~2 months is expected, not a bug: the minute timer pings Telegram once when an account's access token is within 7 days of expiring with nothing left to refresh it. Buffer accounts never expire here (the key is in env).

| | |
|---|---|
| API | `GET/DELETE /api/social/accounts`, `GET /api/social/accounts/:provider/connect` + `/callback`, `GET/POST/DELETE /api/social/posts`, `POST /api/social/posts/:id/approve`, public `GET /api/social/media/:token/:filename` |
| CLI | `cli-social` (on the app user's PATH): no command = one pass (publish due posts, check on posts handed to Buffer, then the reauth check); `accounts`, `connect-buffer`, `posts [--status S]`, `queue --body-file F [--image P --alt T]... | [--video P] [--account ID or network] [--at ISO] [--draft] [--option k=v]... [--options-file F]`, `approve ID [--at ISO]`, `cancel ID` |
| Settings | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `SOCIAL_REDIRECT_BASE_URL`, `SOCIAL_TOKEN_ENC_KEY`, `BUFFER_API_KEY`, `SOCIAL_MEDIA_BASE_URL`, `SOCIAL_X_MAX_CHARS` |
| Timers (server) | the minute publisher/reauth-check (`secondbrain-social`) |
| Design | `Projects/secondbrain-app/social-linkedin-plan.md` and `social-buffer-plan.md` in the vault |
| OAuth callback | Served before the login check (the session cookie is SameSite=Strict, so LinkedIn's redirect arrives without it); the one-time `state` from a logged-in `/connect` guards it |

**Setting up Buffer.** Connect each account in Buffer once (the free plan has 3 channels and a lifetime limit on new connections, so don't connect test accounts). Instagram must be a Business or Creator account for automatic publishing. Put `BUFFER_API_KEY` in the server's env, then run `cli-social connect-buffer`: it adds one account per Instagram, YouTube and X channel and skips the rest.

## Adding a module

A new optional feature is a new module, off by default. The checklist is in [`CONTRIBUTING.md`](https://github.com/kon-rad/secondbrain/blob/main/CONTRIBUTING.md#adding-a-module).

## chat

Ask your second brain. Turn it on with `chat` in `MODULES`; then a speech-bubble button at the right of the header (and an entry in the Vault menu) opens a panel over any page: your conversations on the left, the current one in the centre. Each question is answered from passages retrieved from the vault (keyword and meaning fused at chunk level, optionally reranked), the answer cites them as `[1]`, `[2]`, and the sources are listed under it with a preview. The pipeline is described in [rag.md](rag.md).

The settings modal (the gear, or the model chip) picks the provider and model, the persona, the base system prompt and the retrieval knobs. Only providers whose key is set on the server can be chosen; the models offered for each come from `app/config/llm-presets.json`, extended by the vault's `secondbrain.json`. Personas are the default assistant plus every agent of the `org` module's chart; an agent answers with its compiled definition (`.claude/agents/<name>.md`) added to the system prompt.

| | |
|---|---|
| UI | The speech-bubble button at the right of the header, and "Ask your second brain" in the Vault menu (desktop and phone). Both open the same panel |
| API | `/api/chat/options`, `/api/chat/settings`, `/api/chat/conversations`, `/api/chat/conversations/:id/messages` (server-sent events) |
| Settings | One of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TOGETHER_API_KEY`, `OPENROUTER_API_KEY` (or a local Ollama); `RERANK_URL`, `RERANK_API_KEY`, `RERANK_MODEL` for reranking; `chat.*` in `secondbrain.json` for presets |
| Tables | `chat_conversations`, `chat_messages`, `chat_settings` (module data: not rebuilt from markdown) |
| Costs per turn | One embedding call, one small condensing call, the answer; reranking is opt-in |

Semantic search is not required: without an embeddings provider the chat retrieves by keyword and says so. For better retrieval on dense notes, turn on contextual enrichment on the Embeddings source (`"contextualize": true` in its config on the Sources page): a model writes one line of context per chunk at embed time. It costs one chat-model call per changed note.

