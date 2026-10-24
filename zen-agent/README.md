# zen-agent

A minimal agent harness: one loop, hooks on the loop, and everything else a file. Built on the [pi](https://github.com/earendil-works/pi) agent core (`@earendil-works/pi-agent-core` over `@earendil-works/pi-ai`), so the loop, the provider layer and the streaming are someone else's well-tested code and this package is only what a second brain adds:

| Need | How zen-agent does it |
|---|---|
| **Any persona** | A roster entry (`org.json` or `org.yaml`: role, team, lead, model, expertise, capabilities) plus its definition file and its playbook become the top of the system prompt. `--persona atlas` |
| **Any provider, any model** | pi-ai's forty providers by key in the environment, plus any OpenAI-compatible or Anthropic-compatible endpoint from `zen.json`. `--model openrouter/anthropic/claude-sonnet-4-6`, `--model ollama/qwen3:8b` |
| **Skills** | Agent Skills folders (`<dir>/<name>/SKILL.md`). The prompt lists names and descriptions; `read_skill` loads one on demand. A private skill shadows a shared one of the same name |
| **Kanban board** | Typed tools over the board: list, show, create, comment, assign, complete, block. Three backends: the engine's own board (`/api/board` with a board token), agent-hub's HTTP API, or the `hermes kanban` command line. `zen-agent wake <card>` makes the card the task and its budget the run's; `zen-agent lane` claims ready cards from the engine's board and wakes for each |
| **Knowledge base** | The second brain's retrieval API as tools: `search_notes` (hybrid keyword + vector), `search_everything` (notes, records, transcripts), `read_note` |
| **Message board** | `cli-org` as typed tools: whoami, read, post, dm, handoff, ask-owner, tasks, recall, remember, under the persona's identity |
| **Budgets** | Turns, tokens and minutes, enforced in the loop. A run that hits one ends with `stopped: budget` and exit code 3 |
| **Context as code** | The system prompt is assembled from named parts (identity, persona, rules, playbook, skills, handoff, task, environment) plus the fetched parts a wake is configured to bring (the thread it answers, the card's tracker row, its PR and CI status, recall hits), each with a token cap; every part's size is in the trace |
| **Fresh wakes** | Every `wake` is a new session: the card, the thread it answers (when it is a reply), the fetched parts and the `handoff` part a dispatcher passes (`--handoff-file`: what the previous run concluded) are all the context there is. Nothing of an earlier run is replayed; a bot's continuity is its memory file and `org_remember`/`org_recall`. `--resume` exists for `run` and `chat` only |
| **Compaction as policy** | Past a fraction of the model's window, older turns are summarised into one message and the last N user turns kept; the cut never parts a tool call from its result; every compaction is in the trace |
| **Guard** | The engine's tool guard, ported and run in process on every tool call, reading the same `.agents/guard.local.json`; plus any hook command in the Claude Code contract (`guard.py`, `devlog_gate.py` run unchanged) |
| **Traces** | One JSONL file per run: every message, every tool call with timing, blocks, compactions, totals. Resume a session by id |
| **Sub-agents** | `delegate(objective, persona?, turns?)` runs a child with its own session and returns only its report |

Lines of TypeScript: about 2 500 in `src/`, 650 in tests. Runtime dependencies: the two pi packages, TypeBox, yaml.

## Install

Node 22 or newer.

```bash
cd zen-agent
npm ci
npm run build          # dist/
npm test               # 36 tests, no network, no keys
node dist/src/cli.js help
```

Or link it: `npm link` in this folder gives you a `zen-agent` command.

## Configure

Copy `zen.example.json` to `zen.json` in your vault (or `~/.zen/zen.json`; `--config` and `$ZEN_CONFIG` win). Every key has a default that works for a stranger; the file only says what differs. Relative paths are resolved against the vault, and the vault defaults to the working directory.

Secrets come from the environment only: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `GEMINI_API_KEY`, ... (the [pi-ai list](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#environment-variables)), the hub token in the variable `kanban.tokenEnv` names, and the knowledge base's headers in `knowledge.headersEnv` as a JSON object. In a vault, load them with `set -a; . ./.env; set +a`.

| Key | Default | Says |
|---|---|---|
| `model` | `anthropic/claude-sonnet-4-6` | `provider/model`. `$ZEN_MODEL` and `--model` override it; a persona's `model` field overrides the config |
| `thinking` | `off` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` for models that reason |
| `vault` | `.` | Where rules, skills, personas and sessions live |
| `rules` | `["AGENTS.md"]` | Rule files; the first that exists is the `rules` part |
| `skills` | `[".agents/skills", "~/.zen/skills"]` | Skill folders, earlier wins |
| `persona.org` | `.agents/org/org.json` | The roster (`.json` or `.yaml`): `agents.<name>.{role, team, reports_to, model, expertise, capabilities, runtime}`, `teams.<slug>.{name, lead}` |
| `persona.definitions` | `.claude/agents` | `<name>.md`, frontmatter dropped: the identity Claude Code runs the agent with |
| `persona.memory` | `.agents/org/memory` | `<name>.md`: the playbook, read in full at the start of a run |
| `tools` | all seven | `fs`, `shell`, `skills`, `knowledge`, `kanban`, `org`, `subagent`. A set whose backend is not configured contributes nothing |
| `budget` | 40 turns, 400 000 tokens, 30 minutes | Per run. `--max-turns`, `--max-tokens`, `--max-minutes`, or a card's `## Budget` line |
| `context.cap` | `0.6` | Fraction of the model's context window that triggers compaction |
| `context.keepTurns` | `6` | User turns kept verbatim after a compaction |
| `context.parts` | rules 6000, persona 3000, playbook 2000, skills 1500, handoff 500, task 4000, thread 2000, tracker 1500, github 1500, recall 2000 | Token caps per prompt part, the fetched parts included; 0 is unlimited. `handoff` is what the previous run concluded (`--handoff-file`), so a fresh run needs no resumed transcript |
| `context.fetchers` | `{}` | Which context fetchers a wake runs, by card work type (`coding`, `research`, ...), by team (`team:<slug>`) or for every card (`default`); the matching lists are united. Names: `tracker` (the card's project and feature rows from `cli-projects list`), `github` (PR and CI status for the card's branch, when the card names a repo), `recall` (`cli-org recall` for the card's title). All off unless listed; `--fetch a,b` and `--fetch none` override per run |
| `guard.local` | first `.agents/guard.local.json` up from the working directory | The vault's extra rules (`protected_dirs`, `no_delete`, `readonly`, `disable`); `$SB_GUARD_LOCAL` wins |
| `guard.log` | `~/.cache/agent-guard.log` | Where blocks are appended, like the Python guard |
| `guard.hooks.preToolUse` | `[]` | Commands run before each file or shell tool call with the Claude Code payload on stdin; exit 2 blocks |
| `guard.hooks.stop` | `[]` | Commands run when the agent finishes, with a Claude-style transcript path; exit 2 sends the agent back once |
| `fs.roots` | the working directory and the vault | Where the file tools may read and write; `bash` is not confined |
| `shell.timeoutS`, `shell.maxOutput` | 120, 12 000 | Command timeout and the output cap (head and tail kept) |
| `knowledge` | `{ "kind": "none" }` | `{ "kind": "secondbrain", "url": "http://127.0.0.1:3000", "headersEnv": "ZEN_SB_HEADERS" }` |
| `kanban` | `{ "kind": "none" }` | `{ "kind": "board", "url": "http://127.0.0.1:5123", "tokenEnv": "BOARD_TOKEN", "board": "exo" }` (the engine's board; the token comes from `cli-board token create`), `{ "kind": "cli", "command": "hermes", "board": "exo" }` or `{ "kind": "hub", "url": "http://127.0.0.1:8787", "tokenEnv": "AGENT_HUB_TOKEN", "board": "exo" }` |
| `org.command` | `cli-org` | The message board CLI; the `org` tools appear only when it is on the PATH and a persona is set. Also the `thread` and `recall` fetchers |
| `tracker.command`, `github.command` | `cli-projects`, `gh` | The commands behind the `tracker` and `github` fetchers |
| `providers` | `{}` | Extra endpoints: `{ "<id>": { "api": "openai-completions" \| "anthropic-messages", "baseUrl", "apiKeyEnv"?, "models": [{ "id", "contextWindow"?, "maxTokens"?, "reasoning"? }] } }` |

`zen-agent config` prints the effective configuration. `zen-agent models --available` lists the models whose provider has a key.

## Use

```bash
zen-agent run "Summarise Areas/goals.md in five lines"           # one task, answer on stdout, tool calls on stderr
zen-agent run --persona atlas --task "Review only; do not edit" --file brief.md
zen-agent chat --persona bolt --model openrouter/openai/gpt-5.2  # a conversation; /quit to leave
zen-agent wake t_3f9a12 --persona bolt                           # the card is the task; always a fresh session
zen-agent wake t_3f9a12 --persona bolt --fetch tracker,github    # with two context fetchers, whatever zen.json says
ORG_AGENT=bolt zen-agent run --task "You were woken by a DM; answer in the thread." --thread 47 "Reply."
                                                                 # a DM, handoff or mention wake: message 47's thread is the only board history in the prompt
zen-agent lane --runtime zen-agent                               # claim ready cards from the engine's board, wake for each
zen-agent run --resume bolt-20261024-091500-k3j2 "Continue"      # replay a session and go on
ORG_AGENT=bolt zen-agent wake t_3f9a12 --json --tools kanban,org,fs,shell --thinking low \
  --handoff-file /tmp/bolt-last.md --meta run_id=bolt-20261024-120000 --meta-json '{"reasons":[{"reason":"task","ref":"t_3f9a12"}]}'
zen-agent personas | skills | sessions | models
zen-agent sessions --json                                        # one line per run: parts, fetchers, usage, for comparing wakes
echo '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}' | zen-agent guard   # exit 2: a PreToolUse hook
```

Exit codes: 0 done, 1 error, 3 the budget ended the run or the final message says `BLOCKED:`. `--json` prints the run result (text, stop reason, turns, usage, model, the size of every prompt part, session id and path) as one JSON object for a dispatcher.

The flags a dispatcher uses, on `run` and `wake` (and `chat`):

| Flag | Does |
|---|---|
| `--tools fs,org,...` | This run's tool sets instead of `zen.json`'s: a DM answer gets `org,skills,knowledge`, a card gets everything |
| `--task-file <f>` | Standing orders read from a file (joined after `--task`): the `task` part |
| `--handoff-file <f>` | The previous run's conclusion (its end line, last words, open statuses): the `handoff` part, capped at `context.parts.handoff` |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` for this run |
| `--meta key=value` | Repeatable. Labels for the ledger (run id, wake reasons, card, tier); they land in the trace's `meta` line under `dispatch` and change nothing about the run |
| `--meta-json '{...}'` | The same as one JSON object (for values that are not strings); `--meta` pairs win on a clash |

The `board` backend speaks the engine's `/api/board` (docs/board-design.md section 5.1): list, show, create, comment, assign, finish (complete and block), claim and heartbeat. The `cli` kanban backend calls the Hermes board's command line the way the engine's `cli-org` already does (`show --json`, `create`, `comment`, `assign`, `block`); `list --json` and `complete --result` follow the same shape and were written from that usage, not run against a live board. The `hub` backend follows agent-hub's routes as the app's web client calls them.

### A bot wake, end to end

`zen-agent wake <card>` reads the card through the kanban backend, runs the context fetchers configured for the card's type and the persona's team (each into its own capped part), builds the prompt from the card verbatim (body and comments) plus the standing orders of a wake (one card, one run; produce the Returns; post one status with evidence; complete or block the card; the run starts fresh), takes the budget from the card's `## Budget` line, runs the persona in a **new session**, and exits 0 or 3. The dispatcher's shell script becomes `ORG_AGENT=bolt zen-agent wake t_3f9a12 --json`.

**Every wake is a fresh run.** There is no path through `wake` or `lane` that resumes a session, and `wake --resume` is an error: a bot that carried its transcript from wake to wake for days ends up reasoning over every unrelated card, DM and mention it ever saw. What a wake knows is the card, the thread it answers when the wake is a reply, and what the fetchers bring; what a bot keeps between wakes is its memory file (`persona.memory/<name>.md`, the playbook part) and the shared memory (`org_remember`, `org_recall`). A DM, handoff or mention wake is `ORG_AGENT=<name> zen-agent run --task "<the wake's standing orders>" --thread <message id> "<prompt>"`: the wakeup's `ref` is the message that woke the bot, and `--thread` puts exactly that thread (`cli-org thread <id>`, read as the persona so membership rules hold) into a `thread` part capped by `context.parts.thread`; no other channel and no earlier run enters the prompt.

The fetchers are plain functions in `src/fetchers.ts`, one per source, off unless `context.fetchers` (or `--fetch`) names them for the card: `tracker` reads the card's `Project: <p>/<f>` header and brings those rows of `cli-projects list`; `github` reads `Repo: owner/name` and `Branch: <name>` (or a pull request URL) off the card and brings `gh pr view` and `gh run list` for it; `recall` asks `cli-org recall "<card title>" --project <p>` as the persona. Each part has its own cap, and the trace's `meta` line records every fetcher: on or off, the size it brought, any error (a failing fetcher leaves its part empty and the wake goes on with the card). With the engine's board there is no dispatcher to write: `zen-agent lane --runtime zen-agent` claims the next ready card for any `runtime: zen-agent` agent on the roster (or `--agent <name>` for one), runs the wake as that persona, heartbeats every minute while it runs, and releases the card (back to ready, outcome partial) if the run ends without finishing it. `--once` works one card and exits (3 when nothing was ready).

### As a library

```ts
import { ZenAgent, loadConfig } from 'zen-agent';

const zen = new ZenAgent({ config: loadConfig({ workdir: '/srv/vault' }), persona: 'atlas', budget: { turns: 10 } });
const r = await zen.run('What is blocked on the owner this week? Use org_read and cli-projects.');
console.log(r.text, r.stopped, r.usage.total, r.sessionPath);
```

Everything is exported from `zen-agent`: the guard (`decide`), the context assembler (`buildSystemPrompt`), the compaction policy (`compact`), the session reader (`Session.load`), the tool sets (`buildTools`, `TOOL_SETS`), the kanban and knowledge clients. Tests pass a `fauxProvider()` from pi-ai as `models`, so a run can be scripted without a key.

## How it is built

```
src/
  agent.ts        ZenAgent: the pi Agent plus the hooks below; run(), steer(), abort(), result()
  config.ts       zen.json → ZenConfig with defaults and resolved paths; parseBudgetLine
  models.ts       pi-ai catalogue + custom providers; pickModel('provider/model')
  persona.ts      roster entry + definition + playbook → Persona; personaHeader
  skills.ts       Agent Skills discovery (frontmatter, first dir wins), skillsIndex
  context.ts      named parts with caps → system prompt + per-part stats
  guard.ts        the Python guard, ported: decide(payload, rules); toolPayload maps zen tools to Claude names
  hooks.ts        external hook commands (stdin JSON, exit 2 blocks, fail open); a Claude-style transcript for Stop hooks
  compaction.ts   compact(messages): summarise the middle, keep head and tail, cut on a user turn
  session.ts      JSONL trace per run; load for resume; list; summary (one run in numbers)
  fetchers.ts     context fetchers: thread, tracker, github, recall → capped parts + per-fetcher stats
  wake.ts         card → wake prompt and budget; wakeContext (the fetched parts); runWake (one fresh wake, start to finish)
  tools/          fs, shell, skill, knowledge, kanban (board | hub | cli), org (cli-org), subagent (delegate)
  cli.ts          run, chat, wake, lane, models, personas, skills, sessions, config, guard
```

The pi agent core's hooks carry everything:

| pi hook | zen-agent uses it for |
|---|---|
| `beforeToolCall` | the in-process guard, then the `preToolUse` hook commands; a block becomes an error tool result the model reads |
| `prepareRequest` | compaction, replacing the agent's transcript when it fires |
| `finishTurn` | the budget: `{ action: "end" }` when turns, tokens or minutes are spent |
| `subscribe` | the trace: each `message_end` and `tool_execution_end` is a JSONL line; the same events reach the CLI's printer |

Tools execute sequentially, so the guard's view of the world is the model's. Tool arguments are TypeBox schemas: the model sees exactly the contract the code enforces.

### What the trace holds

```
{"type":"meta","version":1,"id":"bolt-20261024-091500-k3j2","persona":"bolt","model":"openrouter/deepseek/deepseek-v4.1-flash",
 "parts":[{"name":"identity","chars":112,"tokens":28,"truncated":false},{"name":"rules","chars":9100,"tokens":2275,"truncated":false},...],
 "fetchers":[{"name":"thread","on":false,"chars":0,"tokens":0,"error":null},{"name":"tracker","on":true,"chars":210,"tokens":53,"error":null},...],
 "budget":{"turns":40,"tokens":400000,"minutes":30},"tools":["read_file",...],"skills":["org-member",...],"parent":null,"resumed":null,
 "dispatch":{"run_id":"bolt-20261024-091500","reasons":[{"reason":"task","ref":"t_3f9a12"}],"tier":"flash-low"}}
{"type":"message","at":"...","message":{"role":"user","content":"..."}}
{"type":"message","at":"...","message":{"role":"assistant","content":[...],"usage":{...},"stopReason":"toolUse"}}
{"type":"tool","at":"...","toolCallId":"...","name":"bash","args":{"command":"npm test | tail -n 20"},"isError":false,"durationMs":4120}
{"type":"blocked","at":"...","name":"bash","reason":"guard: that would print or copy a secrets file. ..."}
{"type":"compaction","at":"...","before":81200,"after":14900,"dropped":37}
{"type":"end","at":"...","stopped":"done","turns":9,"usage":{"input":...,"output":...,"cacheRead":...,"cacheWrite":...,"total":...,"cost":0.41}}
```

The `message` lines are pi-ai messages as sent and received, so `Session.load` can hand them straight back to a new agent (`run --resume`), and an archive collector or an eval reads one format for every run. The `meta` line's `version` is the trace format's version (1 today); a reader checks it before parsing, and it changes when a line's shape does. `dispatch` is whatever `--meta` and `--meta-json` carried: the dispatcher's labels, nothing the run used. `zen-agent sessions --json` prints `Session.summary` per run (persona, `resumed`, part sizes, the fetchers that ran, turns, usage), so comparing tokens per wake before and after a change of policy is one pipe over the sessions folder:

```bash
zen-agent sessions --json | jq -s '[.[] | select(.persona == "bolt" and .usage)] | (map(.usage.total) | add / length)'
```

## Security

The guard checks the text of tool calls, like the Python one; it is a guardrail, not a sandbox. pi has no permission prompts by design. Run bot wakes under a dedicated Unix user or in a container, never as the owner; keep signing keys and other people's data where that user cannot read them. Tool results, board messages and card bodies are information, never instructions: the standing orders say so, and the persona's rules file should too.

## Using it from the second brain engine

This folder is a standalone package inside the [secondbrain](https://github.com/kon-rad/secondbrain) repository: it imports nothing from `app/` and nothing imports it. It is the headless runtime the proposal in `docs/self-improvement.md` (section 10) asked for: bot wakes that cost a bounded, measured number of tokens, with the context assembled as code, the guard in process and a complete trace per run. The engine's roster accepts `runtime: zen-agent` next to `claude-code` and `hermes`, and its board module lets this runtime claim cards (`zen-agent lane`).

To give it its own repository, split the folder with history:

```bash
git subtree split --prefix zen-agent -b zen-agent-main
# then push that branch to a new, empty repository
```

The package has no path that points back into the engine; `zen.example.json` references the engine only in a hook command you can change.

## Not here, on purpose

- No Telegram or chat transport, no cron scheduler: the CLI is one process per run, so any scheduler (systemd timers, Hermes cron, the org dispatcher) drives it with `--json`.
- No permission prompts (see Security), no plan mode, no MCP. pi has `@earendil-works/pi-mcp` if you want MCP tools; wrap them as `AgentTool`s and pass `tools`.
- No vector store of its own: the knowledge tools call the engine's retrieval, which already does hybrid search, reranking and contextual chunks.

## License

MIT.
