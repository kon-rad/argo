# `dispatch` addon

Status: **pilot** - The engine's zen-agent and Codex dispatcher: one run per bot with open wakeups. Stays a pilot addon; the timer installs only when the module is on and `ORG_DISPATCH=on`. Its code (`index.ts`, `store.ts`, `codex.ts`, `cli.ts`) lives in this folder.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `dispatch` |
| CLI | `secondbrain dispatch` |
| Timers (server) | `secondbrain-dispatch` |
| Env | `ORG_DISPATCH`, `ORG_DISPATCH_TICK_SECONDS`, `ORG_DISPATCH_PARALLEL`, `ORG_DISPATCH_QUIET`, `ORG_DISPATCH_DAILY_TOKENS`, `ORG_CODEX_COMMAND` |
| Docs | `docs/addons.md` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.

## Codex subscription lane

Set an agent's roster runtime to `codex` and its model to the exact Codex CLI model id. The dispatcher removes API-key and endpoint overrides, checks `codex login status` for ChatGPT login, then makes an ephemeral read-only request against that exact model before claiming any wakeup. If the binary, login or model is unavailable, ready task cards move to `blocked` with the reason and the tick reports an error. It never substitutes another model or an API key. `ORG_CODEX_COMMAND` selects the binary path; default is `codex`.

For a task wake, the dispatcher claims the exact ready card once, passes its body and comments in the prompt, and runs `codex exec --json` in the vault root with `workspace-write`. A card naming a repository is blocked before launch and goes to the isolated card runner. It records the JSONL thread id and token counts, then comments and moves a successful card to `review`. Error, cancellation and timeout move it to `blocked`. A human may return a blocked card to `ready`; the next wake resumes its recorded Codex session id. Non-card wakes run read-only. Existing zen-agent and Claude Code runs are unaffected; the dispatcher selects only roster rows whose effective runtime is `zen-agent` or `codex`.

The separate local card runner can call the same interface without changing this dispatcher's board owner: `codexCommand(model, cwd, prompt, sessionId?, writable)`, `subscriptionEnv(env)`, `codexPreflight(runner, command, model, cwd, env)` and `parseCodexResult(processResult)`. The runner must create its own isolated worktree, enforce its permission policy, persist JSONL logs and thread id, and leave push/PR/board review to its trusted outer process. Codex CLI does not expose zen-agent's per-tool allowlist, so task runs rely on `workspace-write`, repo rules and the runner's worktree boundary.

The CLI flags and login mode were checked against the installed `codex exec --help`, `codex exec resume --help` and `codex login status`. OpenAI documents [ChatGPT authentication](https://learn.chatgpt.com/docs/auth?surface=cli) and [structured `codex exec --json` events](https://developers.openai.com/blog/eval-skills).
