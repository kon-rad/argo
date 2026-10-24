# zen-agent: a minimal agent harness

### The headless runtime for bot wakes: one loop, hooks on the loop, everything else a file

**Status:** built and merged: `zen-agent/` on `main` since [kon-rad/secondbrain#38](https://github.com/kon-rad/secondbrain/pull/38). The roster switch and the dispatcher hand-off described in [Integration](#7-integration-with-the-second-brain) are not done yet.
**Written:** 2026-10-24
**Goal:** Run one agent of the org, as a named persona, on one task, under a budget, with every input measured and every step traced, on whichever model the policy names.
**Companion pages:** [Self-improving orchestration](self-improvement.md) (section 10 asked for this runtime), [Agent harness](agent-harness.md) (the guard and the gate it shares), [Retrieval](rag.md) (the search it calls).

---

## TL;DR

1. **It is small on purpose.** About 2 500 lines of TypeScript over the [pi](https://github.com/earendil-works/pi) agent core (`@earendil-works/pi-agent-core` and `pi-ai`). The loop, the provider layer, the streaming and the tool-call plumbing are pi's; zen-agent is only what a second brain adds.
2. **Every harness concern is a hook on the loop or a file it reads.** Guard in `beforeToolCall`, budget in `finishTurn`, compaction in `prepareRequest`, trace in `subscribe`; personas, rules, skills and playbooks are the vault's files.
3. **Personas, providers and tools are configuration.** `--persona atlas --model openrouter/openai/gpt-5.2`; the board, the knowledge base and the message board are typed tools that appear when their backend is configured.
4. **What enters the context is measured, not guessed.** The system prompt is assembled from capped named parts and each part's size is recorded; compaction is a policy with numbers in the trace.
5. **It is a guardrail, not a sandbox.** The same guard rules as Claude Code and Hermes run in process; pi has no permission prompts by design, so bot runs belong under a dedicated Unix user or in a container.

---

## 1. Why another runtime

Agents run here in three ways ([self-improvement.md, section 10](self-improvement.md#10-a-harness-of-our-own)): the owner in Claude Code, bot wakes under `claude -p`, and cron and chat under Hermes. The headless mode is where the loop's levers are weakest and the bill is highest: every turn re-sends a conversation whose system prompt and tool list are Claude Code's, compaction is opaque, a complete trace needs a capture proxy, and the wake prompt and the budget live in a dispatcher script outside the engine.

zen-agent is the pilot that section recommends: a thin runtime for bot wakes, built on a minimal, maintained agent core rather than written from scratch, judged by the same metrics as any other proposal (tokens per finished card, first-wake finish rate, trace completeness). It replaces nothing for the owner's interactive work or for Hermes's cron jobs.

---

## 2. Key features

| Feature | What it means in practice |
|---|---|
| **Any persona from the org roster** | `org.json` or `org.yaml` (`agents.<name>`: role, team, reports_to, model, expertise, capabilities; `teams.<slug>`: name, lead) plus the agent's definition file (`.claude/agents/<name>.md`, the one Claude Code runs it with, minus frontmatter) and its playbook (`.agents/org/memory/<name>.md`). A persona's `model` field picks the model. A definition file alone is a persona too |
| **Any provider, any model** | pi-ai's catalogue (Anthropic, OpenAI, Google, OpenRouter, Together, Groq, Mistral, Bedrock, Vertex and the rest) with keys from the environment, plus any OpenAI-compatible or Anthropic-compatible endpoint declared in `zen.json` (Ollama, vLLM, a proxy). The model is a string: `provider/model` |
| **Skills** | The [Agent Skills](https://agentskills.io/specification) layout the vault already uses (`<dir>/<name>/SKILL.md` with `name` and `description` in the frontmatter). The prompt lists names and descriptions; `read_skill` loads a body on demand. A private skill shadows a shared one of the same name |
| **Tools as typed contracts** | Every tool is a TypeBox schema the model sees exactly as the code enforces it: files (`read_file`, `write_file`, `edit_file`, `list_dir`), shell (`bash`), skills (`read_skill`), the kanban board (`board_list`, `card_show`, `card_create`, `card_comment`, `card_assign`, `card_complete`, `card_block`), the knowledge base (`search_notes`, `search_everything`, `read_note`), the message board (`org_whoami`, `org_read`, `org_post`, `org_dm`, `org_handoff`, `org_ask_owner`, `org_tasks`, `org_task_create`, `org_recall`, `org_remember`), and `delegate` |
| **The guard, in process** | `harness/hooks/guard.py` ported to TypeScript: secrets files never reach a tool, no force push, no `rsync --delete` without a dry run, plus the vault's `.agents/guard.local.json` (`protected_dirs`, `no_delete`, `readonly`, `disable`). Its tests replay the Python suite's cases. External hook commands in the Claude Code contract run too, so `guard.py` and `devlog_gate.py` work unchanged |
| **Budgets** | Turns, tokens and minutes, enforced in the loop. A run that hits one ends with `stopped: budget` and exit code 3. A card's `## Budget` line (`turns: 30 · tokens: 300000`) becomes the run's budget |
| **Context as code** | The system prompt is assembled from named parts (identity, persona, rules, playbook, skills, task, environment), each with a token cap; the trace records every part's size and whether it was cut |
| **Compaction as policy** | Past a fraction of the model's window (default 0.6), older turns are summarised by the model into one message and the last N user turns are kept verbatim. The cut always lands on a user message, so no tool call is parted from its result. Every compaction is a trace line with sizes |
| **Traces** | One JSONL file per run: every message as the model saw it, every tool call with its arguments and timing, every block, every compaction, the totals. Resume a session by id; a child run names its parent |
| **Sub-agents with a contract** | `delegate(objective, persona?, turns?)` runs a child in its own session and returns only its report. One level deep |
| **A CLI a scheduler can drive** | `run`, `chat`, `wake <card>`, `models`, `personas`, `skills`, `sessions`, `config`, `guard`. `--json` prints the run result for a dispatcher; `guard` is a drop-in PreToolUse hook for any other agent |

---

## 3. How to use it

### 3.1 Install

Node 22 or newer.

```bash
cd zen-agent
npm ci
npm run build                 # dist/
npm test                      # 36 tests: no network, no keys
npm link                      # optional: a `zen-agent` command on your PATH
```

### 3.2 Configure

Copy `zen-agent/zen.example.json` to `zen.json` in your vault (or `~/.zen/zen.json`; `--config <file>` and `$ZEN_CONFIG` win). Every key has a default that works for a stranger; the file only says what differs. Relative paths resolve against the vault, and the vault defaults to the working directory.

**Secrets never go in the file.** API keys come from the environment under the names pi-ai expects (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `GEMINI_API_KEY`, ...). The hub token lives in the variable `kanban.tokenEnv` names; the knowledge base's headers (the app's session cookie, on a server) live in `knowledge.headersEnv` as a JSON object. In a vault: `set -a; . ./.env; set +a`.

The keys, in the order you are likely to touch them:

| Key | Default | Says |
|---|---|---|
| `model` | `anthropic/claude-sonnet-4-6` | `provider/model`. `$ZEN_MODEL` and `--model` override it; a persona's `model` field overrides the config |
| `thinking` | `off` | `off` to `max` for models that reason |
| `budget` | 40 turns, 400 000 tokens, 30 minutes | Per run; `--max-turns`, `--max-tokens`, `--max-minutes`, or the card's `## Budget` line |
| `tools` | all seven sets | `fs`, `shell`, `skills`, `knowledge`, `kanban`, `org`, `subagent`. A set whose backend is not configured contributes nothing |
| `knowledge` | off | `{ "kind": "secondbrain", "url": "http://127.0.0.1:3000", "headersEnv": "ZEN_SB_HEADERS" }` |
| `kanban` | off | `{ "kind": "cli", "command": "hermes", "board": "exo" }` or `{ "kind": "hub", "url": "http://127.0.0.1:8787", "tokenEnv": "AGENT_HUB_TOKEN", "board": "exo" }` |
| `org.command` | `cli-org` | The message board CLI; its tools appear only when it is on the PATH and a persona is set |
| `persona.org`, `persona.definitions`, `persona.memory` | `.agents/org/org.json`, `.claude/agents`, `.agents/org/memory` | Where personas come from |
| `rules`, `skills` | `["AGENTS.md"]`, `[".agents/skills", "~/.zen/skills"]` | The rules part (first file that exists) and the skill folders (earlier wins) |
| `context.cap`, `context.keepTurns`, `context.parts` | 0.6, 6, caps per part | The compaction trigger, the tail kept, and the token cap of each prompt part |
| `guard.local`, `guard.log`, `guard.hooks` | first `.agents/guard.local.json` up from the working directory; `~/.cache/agent-guard.log`; none | The vault's rules, the block log, and the `preToolUse` and `stop` hook commands |
| `providers` | `{}` | Extra endpoints: `{ "<id>": { "api": "openai-completions" \| "anthropic-messages", "baseUrl", "apiKeyEnv"?, "models": [{ "id", "contextWindow"?, "maxTokens"? }] } }` |

`zen-agent config` prints the effective configuration with every path resolved. `zen-agent models --available` lists the models whose provider has a key.

### 3.3 Run

```bash
zen-agent run "Summarise Areas/goals.md in five lines"            # answer on stdout, tool calls on stderr
zen-agent run --persona atlas --task "Review only; do not edit" --file brief.md
zen-agent chat --persona bolt --model ollama/qwen3:8b             # a conversation; /quit to leave
zen-agent wake t_3f9a12 --persona bolt --json                    # the card is the task
zen-agent run --resume bolt-20261024-091500-k3j2 "Carry on"      # replay a session and continue
zen-agent personas | skills | sessions | models
echo '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}' | zen-agent guard    # exit 2
```

Exit codes: 0 done, 1 error, 3 the budget ended the run or the final message says `BLOCKED:`. The persona can also come from `$ZEN_PERSONA` or, for `wake`, `$ORG_AGENT`, which is what the dispatcher already sets.

### 3.4 A bot wake, end to end

`zen-agent wake <card>`:

1. reads the card through the kanban backend (body, relations, comments);
2. builds the prompt: the card verbatim, then the standing orders of a wake (one card, one run; produce the Returns; work inside the Scope; post at most one status with evidence; complete or block the card; never present a partial result as done);
3. takes the budget from the card's `## Budget` line, overridden by flags;
4. runs the persona with the tools its configuration gives it;
5. prints the result (`--json` for the dispatcher) and exits 0 or 3.

The dispatcher's shell script becomes `ORG_AGENT=bolt zen-agent wake t_3f9a12 --json`.

### 3.5 As a library

```ts
import { ZenAgent, loadConfig } from 'zen-agent';

const zen = new ZenAgent({ config: loadConfig({ workdir: '/srv/vault' }), persona: 'atlas', budget: { turns: 10 } });
const r = await zen.run('What is blocked on the owner this week? Use org_read and the tracker.');
console.log(r.text, r.stopped, r.usage.total, r.sessionPath);
```

Everything is exported: the guard (`decide`), the assembler (`buildSystemPrompt`), the compaction policy (`compact`), the session reader (`Session.load`), the tool sets (`buildTools`, `TOOL_SETS`), the kanban and knowledge clients. Tests pass pi-ai's `fauxProvider()` as `models`, so a run can be scripted without a key, which is how the suite runs in CI.

---

## 4. Architecture

### 4.1 The loop and its hooks

```
zen-agent run / chat / wake / library
        │
        ▼
   ZenAgent ─── loads ──▶ zen.json · persona (roster + definition + playbook) · rules · skills · guard.local.json
        │
        ├── buildSystemPrompt ──▶ parts: identity · persona · rules · playbook · skills · task · environment
        │                          (each capped, each measured → session meta)
        ├── buildTools ──▶ fs · shell · skills · knowledge · kanban · org · subagent (only configured backends)
        │
        ▼
   pi Agent (agent-core)  ◀──── streamFn: pi-ai Models (any provider)
        │
        │  beforeToolCall ──▶ guard.decide(payload, rules) → preToolUse hook commands → block = error tool result
        │  prepareRequest ──▶ compact(messages) when > cap·contextWindow → replaces the transcript
        │  finishTurn    ──▶ turns / tokens / minutes spent → { action: "end" }, stopped = budget
        │  subscribe     ──▶ session.jsonl: message · tool · blocked · compaction · end  (+ the CLI printer)
        │
        ▼
   run() ends ──▶ stop hook commands (Claude-style transcript) → one nudge at most → RunResult
```

pi's `Agent` owns the transcript, the tool-call plumbing, steering and follow-up queues, and the streaming events. zen-agent configures it once per run and never reaches inside it: the four hooks above are the whole integration. Tools execute sequentially, so the guard's view of the world is the model's.

### 4.2 Modules

| File | Responsibility | Lines (approx.) |
|---|---|---|
| `src/agent.ts` | `ZenAgent`: wires the pi agent to the hooks; `run`, `steer`, `abort`, `result`; `delegate` for children | 300 |
| `src/config.ts` | `zen.json` → `ZenConfig` with defaults and resolved paths; `parseBudgetLine` | 190 |
| `src/models.ts` | pi-ai catalogue plus custom providers; `pickModel('provider/model')`; `availableProviders` | 90 |
| `src/persona.ts` | roster entry + definition + playbook → `Persona`; `personaHeader` | 130 |
| `src/skills.ts` | Agent Skills discovery (frontmatter, first dir wins); `skillBody`, `skillsIndex` | 90 |
| `src/context.ts` | named parts with caps → prompt + per-part stats; `estimateTokens` (four characters per token) | 110 |
| `src/guard.ts` | the Python guard, ported: `decide`, `checkShell`, `checkPath`, `loadLocalRules`; `toolPayload` maps zen tools to Claude names | 230 |
| `src/hooks.ts` | hook commands (stdin JSON; exit 2 or `{"decision":"block"}` blocks; crash or timeout allows); a Claude-style transcript for Stop hooks | 100 |
| `src/compaction.ts` | `compact`: summarise the middle, keep head and tail, cut on a user turn; `renderForSummary` | 110 |
| `src/session.ts` | the JSONL trace; `Session.load` for resume; `Session.list` | 100 |
| `src/wake.ts` | card → wake prompt and budget | 50 |
| `src/tools/*.ts` | the seven tool sets and the `tool()` helper that types `execute` by its schema | 900 |
| `src/cli.ts` | the commands, the streaming printer, exit codes | 230 |

Runtime dependencies: the two pi packages, TypeBox (schemas), yaml (frontmatter and `org.yaml`). Tests use Node's own runner.

### 4.3 The trace

```jsonl
{"type":"meta","id":"bolt-20261024-091500-k3j2","persona":"bolt","model":"anthropic/claude-sonnet-4-6",
 "parts":[{"name":"identity","chars":112,"tokens":28,"truncated":false},{"name":"rules","chars":9100,"tokens":2275,"truncated":false}, ...],
 "budget":{"turns":40,"tokens":400000,"minutes":30},"tools":["read_file", ...],"skills":["org-member", ...],"parent":null,"resumed":null}
{"type":"message","at":"...","message":{"role":"user","content":"..."}}
{"type":"message","at":"...","message":{"role":"assistant","content":[...],"usage":{...},"stopReason":"toolUse"}}
{"type":"tool","at":"...","toolCallId":"...","name":"bash","args":{"command":"npm test | tail -n 20"},"isError":false,"durationMs":4120}
{"type":"blocked","at":"...","name":"bash","reason":"guard: that would print or copy a secrets file. ..."}
{"type":"compaction","at":"...","before":81200,"after":14900,"dropped":37}
{"type":"end","at":"...","stopped":"done","turns":9,"usage":{"input":...,"output":...,"cacheRead":...,"cacheWrite":...,"total":...,"cost":0.41}}
```

The `message` lines are pi-ai messages exactly as sent and received, so `--resume` hands them straight back to a new agent, an archive collector reads one format for every run, and an eval can diff two runs part by part. This is the trace section 7.5 of the proposal asks for: the size of each context part next to the outcome of the run.

### 4.4 Context assembly and compaction

The prompt is built once per run from parts in a fixed order. A part with nothing to say is omitted; a part over its cap is cut at a line boundary with a marker. Defaults: rules 6 000 tokens, persona 3 000, playbook 2 000, skills 1 500, task 4 000; identity and environment are never cut. The caps are settings, so "drop the playbook part for review cards" is a one-line policy change, and the trace says what it did to the outcome.

Compaction runs before each provider request when the estimated transcript passes `cap × contextWindow`. The middle (everything between the leading system message and the last `keepTurns` user turns) is rendered compactly (tool calls as `[call name args]`) and summarised by the same model with a fixed prompt that asks for the task, decisions, paths touched, commands and results, open questions and what is left. A failed summary leaves the transcript alone and the next request tries again.

### 4.5 The guard and the hooks

`decide(payload, rules)` takes the Claude Code hook payload (`tool_name`, `tool_input`, `cwd`) and returns a reason or null. Zen's own tool calls are mapped to that shape (`bash` → `Bash {command}`, `read_file` → `Read {file_path}`, `write_file` → `Write`, `edit_file` → `Edit`, `list_dir` → `Glob`), so one rule set covers Claude Code, Hermes and zen-agent, and `zen-agent guard` can serve as the hook for any of them. The rules file is found as the Python guard finds it: `$SB_GUARD_LOCAL`, the configured path, then the first `.agents/guard.local.json` up from the working directory.

External hook commands keep the engine's two Python hooks in play. `preToolUse` commands run after the in-process guard with the same payload. `stop` commands run when the agent finishes with a Claude-style transcript (edits as `tool_use` blocks named `Edit` and `Write`), which is what `devlog_gate.py` reads; exit 2 sends the agent back once with the reason as the next user message, and the second attempt always passes, as in Claude Code.

---

## 5. Design

The design follows six rules, each with a reason:

1. **One loop, and not ours.** pi's agent core is about 2 600 lines with two dependencies and weekly releases; its loop has the hooks a harness needs (`beforeToolCall`, `afterToolCall`, `prepareRequest`, `finishTurn`, steering, follow-ups). Writing a loop over `pi-ai` alone would reinvent it for no gain (section 14.6 of the proposal rejected that option).
2. **Hooks, not forks.** Everything zen-agent adds is a callback on that loop. Nothing subclasses the agent or patches the provider layer, so a pi upgrade is a version bump.
3. **Files, not a database.** Personas, rules, skills, playbooks, guard rules and traces are files in the vault, versioned with it. The runtime has no state of its own beyond the session folder.
4. **Measured, not guessed.** Prompt parts have caps and sizes; budgets are counted where they are spent; compaction writes its sizes. A proposal about context can be judged with numbers.
5. **Contracts, not prose.** Tools are schemas; a wake is a card contract (Objective, Returns, Budget, Scope, Verification); a delegation is an objective, a return and a budget. The model sees exactly what the code enforces.
6. **Fail open, run contained.** A guard or hook that cannot read its input allows the call, so a harness bug never bricks a run; the price is that the guard is text matching, so the process must run where it can do no harm (a dedicated Unix user, a container).

And the engine's own rule holds: nothing personal. Defaults work for a stranger; secrets are named by variable, never stored; the example configuration uses only loopback addresses.

---

## 6. How it compares

The comparison uses what the research in [self-improvement.md, section 14](self-improvement.md#14-related-work-and-candidate-runtimes) could verify, plus what zen-agent does today. Where a cell says "no", that is a design choice or a current limit, not a verdict on the other tool.

| | **zen-agent** | **Claude Code headless** (`claude -p`) | **Hermes** | **pi coding agent** (`pi`) | **Claude Agent SDK** |
|---|---|---|---|---|---|
| What it is | A thin runtime for bot wakes on pi's agent core | Anthropic's coding agent, driven by a dispatcher script | A general agent with cron, chat and a skills directory | pi's full coding agent with a TUI, RPC and JSONL modes | Claude Code's harness as a library |
| Providers | Any of pi-ai's, plus custom endpoints | Anthropic | Several, through its own config | Any of pi-ai's | Anthropic |
| System prompt and tool list | Assembled from capped, measured parts; tools are only what the run configures | Claude Code's, large and fixed | Hermes's | pi's, with `before_agent_start` to replace it | Claude Code's |
| Personas | From the org roster, plus definition and playbook files | `.claude/agents/<name>.md` subagents | Profiles | Not a concept; a system prompt | Subagents |
| Skills | Agent Skills folders, listed and loaded on demand | Native | External skill dirs | Native, same layout | Native |
| Guard and gate | In process, same rules; Python hooks run unchanged | `PreToolUse` and `Stop` hooks (the Python scripts) | `pre_tool_call` and `pre_verify` hooks (the same scripts) | Extensions on `tool_call` and `session_end` | Hooks |
| Permissions | None (guard only; run contained) | A permission model with prompts and deny lists | Consent once per hook command | None by design | Claude Code's |
| Budget | Turns, tokens, minutes enforced in the loop; a card's `## Budget` | `--max-turns` from outside; tokens not capped in the loop | Its own | Not in the loop | From outside |
| Compaction | A policy with sizes in the trace | Built in, opaque | Built in | Built in, with a replaceable summary | Built in |
| Trace | One JSONL file per run with every message, tool call and part size | `stream-json` output; a complete trace needs a capture proxy for the prompt | Its SQLite state, synced by the engine | Session trees in JSONL | Messages via the SDK |
| Board and knowledge base | Typed tools (`card_*`, `search_notes`, `org_*`) | Shell commands described in a skill | Native kanban (`hermes kanban`) | Shell | Shell or MCP |
| Sub-agents | `delegate` with objective and budget, one level | Native subagents | Not a concept here | Extension packages | Native |
| Interactive use | `chat` in a terminal, plain | Full TUI, the owner's daily tool | Chat over Telegram and others | Full TUI | Whatever you build |
| Maintained by | This repo (small) over pi (weekly releases, MIT; owned by Earendil since 2026) | Anthropic | The Hermes project | Earendil | Anthropic |

In one line each: Claude Code is the right harness for the owner and the wrong size for a bot wake; Hermes owns its own loop and the engine syncs its outputs; the pi coding agent is a complete agent with its own conventions, where zen-agent wants only the core so the vault's conventions stay the vault's; the Claude Agent SDK would keep the context-assembly and tool-list concerns that motivate the pilot.

Against general frameworks (LangGraph, the OpenAI Agents SDK and their kind): those give you a graph or a workflow abstraction and a large surface to learn; zen-agent gives you one loop and a folder of files, because the orchestration here lives on the kanban board and in the org graph templates, not in code.

---

## 7. Integration with the second brain

| Surface | How zen-agent uses it today | What is left |
|---|---|---|
| **The retrieval API** ([rag.md](rag.md)) | `search_notes` calls `/api/search?mode=hybrid`; `search_everything` calls `/api/search/global` (notes, records, agent transcripts); `read_note` calls `/api/file/source`. On a server, the owner's session cookie goes in the headers variable | A token for agents on the search routes, so a bot never holds the owner's cookie |
| **The kanban board** | `hub` backend: agent-hub's routes as the app's web client calls them (list, show, create, comment, assign). `cli` backend: `hermes kanban` (adds complete and block). `wake` reads the card and its `## Budget` | `list --json` and `complete --result` on the CLI were written from the engine's existing usage, not run against a live board |
| **The message board** (`org` module) | `cli-org` as typed tools, as the persona (`ORG_AGENT`); the CLI enforces membership and who may DM whom | Nothing; an HTTP path would need an agent identity the routes do not take today |
| **The roster** | Reads the compiled `org.json` (or `org.yaml`) the vault already keeps; the chart's `model` field is honoured | `runtime: zen-agent` in `OrgDoc` next to `claude-code`, `hermes` and `codex`, so the dispatcher can route a bot's wakes here |
| **The dispatcher** | `zen-agent wake <card> --json` is the whole call | Teach the dispatcher to call it for bots whose runtime says so, and to read the JSON result into `wake-done` |
| **The hooks** | The guard ported; `guard.py` and `devlog_gate.py` run as hook commands | Shared replay cases in `harness/evals/` that both the Python suite and the TypeScript suite run (today the TypeScript tests carry a copy of the Python cases) |
| **The archive** | Session files are one JSONL format with every message | A collector that reads `.zen/sessions/` into the archive like the Claude Code and Hermes collectors |

---

## 8. Limits, and what to measure

- **The guard is text matching.** Like the Python one, it reads the tool call, not the effect. A script the agent writes can do what the agent cannot. Run bot wakes under a user that cannot read what matters.
- **Token estimates are estimates.** Part sizes and the compaction trigger use four characters per token; billed usage comes from the provider and is what the budget counts.
- **Resume keeps the old prompt.** A resumed session replays its leading system message, so a changed rule file applies to the next fresh run, not to a resumed one.
- **No chat transport, no scheduler, no MCP.** One process per run is the interface; cron, the dispatcher or systemd timers drive it. pi has an MCP package whose tools can be passed in as `tools`.
- **Subscription billing is an open question.** The proposal's note stands: assume API credits for the pilot until Anthropic's terms on third-party runtimes are read.

The pilot is judged on the proposal's metrics: tokens per finished card, first-wake finish rate and trace completeness against the `claude -p` bots on the same graph nodes. The trace is built so those numbers fall out of it.

---

## 9. Sources

- pi: [repository and docs](https://github.com/earendil-works/pi) · [`pi-agent-core` README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md) · [`pi-ai` README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)
- Agent Skills: [specification](https://agentskills.io/specification)
- Claude Code: [hooks](https://code.claude.com/docs/en/hooks) · [subagents](https://code.claude.com/docs/en/sub-agents)
- Anthropic: [effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- This repo: [self-improvement.md](self-improvement.md) · [agent-harness.md](agent-harness.md) · [rag.md](rag.md) · [`zen-agent/README.md`](https://github.com/kon-rad/secondbrain/blob/main/zen-agent/README.md)
