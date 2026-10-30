# Org config and model routing

A bot keeps its persona, permissions and memory. **The model that runs a given job is chosen per run**, by rules, inside the envelope you give the bot. This page covers the config files the rules read, the router, the `cli-org route` commands, the log tables, and how to roll the whole thing out.

Where it sits: [org.yaml](org-yaml.md) says who the agents are and what they may do. The files described here say which models exist and what each is good for. The router joins the two when a card is about to run. Dispatch is in [agent-harness](agent-harness.md) and [zen-runtime](zen-runtime.md).

!!! note "What is built, and what is not"
    Built: the config files and their cross-checks (in your vault's `compile.py`), the router (`app/server/src/org-router.ts`), the `route_decisions` / `route_outcomes` / `config_applies` tables, and `cli-org route decide|outcome|classify|report`. The zen-agent dispatcher calls the router for card wakes (`dispatch.routing`, below), with signals from the card classifier (rules, plus an optional t0 model step), the card cost ceiling and per-provider daily caps. `cli-org route report --markdown` writes the weekly report page. Not built yet: routing for Claude Code bots (their dispatcher is separate), `cli-org plan` and `apply`, and the `agents/*.yaml` split. See [Rollout](#rollout).

## Why it exists

A model chosen once per bot, as a cost decision, has no floor under it. The failure that motivated this: every coder was moved to a local 35B model to save money, and it then took a multi-file React edit, hit the 30-turn cap with no commit, and worked around a sandbox refusal with `sed -i`. The model was too weak for the task, and nothing in the config could say so. Three facts had no home: which repos exist and who may touch them, what each model can do, and how a task maps to a model. These files are that home.

## The config directory

All of it lives in your vault under `.agents/org/config/`. Files reference each other by name and never repeat each other's details.

| File | Holds |
|---|---|
| `models.yaml` | The model catalog: id, aliases, provider, tier, `can_code`, `local`, context, price fields |
| `providers.yaml` | Where models are served: base URL, health URL, the *name* of the key (never a value) |
| `machines.yaml` | Machines, their role, ssh target and worktree root |
| `repos/<repo>.yaml` | Repo url, base branch, work host, build and test, reviewers, the one merger, merge gate, risk class |
| `routing.yaml` | Tiers with turn and token budgets, hard floors, the escalation ladder, risk keywords, how strictly floors are enforced |

`org.yaml` stays where it is. Phase 0 adds the directory beside it; splitting `agents:` into one file per bot is a later phase.

### models.yaml

```yaml
models:
  sonnet:
    provider: anthropic
    tier: t2
    can_code: true
    local: false
    price_in_per_mtok_usd: null     # unknown until filled from the provider's page
    price_out_per_mtok_usd: null
  ollama-m1max/qwen3.6:35b-a3b:
    aliases: [qwen3.6:35b-a3b]
    provider: ollama-m1max
    tier: t1
    can_code: false
    local: true
    price_in_per_mtok_usd: 0        # local: no money cost, but a wall-clock budget
```

An agent's `model:` in `org.yaml` is looked up here by id or alias. **Prices are `null` until you fill them in. Never guess one**: the router orders models inside a tier by price, and an unknown price sorts last, so a priced model always beats an unpriced one.

### Tiers

Tiers are classes of capability. The boundaries below are the defaults; set the real ones from a small benchmark of your own recent cards.

| Tier | Intended for | Default turn budget |
|---|---|---|
| `t0` | Classification, formatting, lookups | 8 |
| `t1` | Drafting, summaries, single-file edits with exact instructions | 20 |
| `t2` | Multi-file code, reviews, debugging | 30 |
| `t3` | Architecture, security, migrations, merge, deploy, money, ambiguous specs | 40 |

### repos/<repo>.yaml

```yaml
url: github.com/kon-rad/argo
base: main
work_host: m1max
build: { cwd: app, test: "npm run typecheck && npm test" }
review: [vera]
merge: atlas
merge_gate: owner_approval     # the owner's "approve <id>" unless the card is --ship-now
risk: normal                   # high forces the top tier for every card on this repo
```

## Cross-checks

`compile.py check` and `compile.py routing` run these against `org.yaml` and fail on the first group; the second group is configurable.

| Check | Catches |
|---|---|
| Every tier `t0` to `t3` exists in `routing.yaml` | A router with a missing rung |
| Every model's tier is valid and its provider exists | Dead routes |
| Every agent's `model` is in the catalog | A typo, or a model nobody priced |
| Every repo's `work_host` is a machine; every reviewer and merger is an agent | Repos nobody can work or review |
| A repo's merger has the `merge` capability and is not its only reviewer | One bot approving its own merges |
| A repo with a merger has a reviewer | PRs nobody can review |
| **Model floors**: an agent with `code` on a model with `can_code: false`; `merge` or `deploy` below `t3`; `merge` or `deploy` on a local model | The "all coders on the cheap model" switch |

The model-floor group follows `enforce_model_floors` in `routing.yaml`:

| Value | Effect |
|---|---|
| `warn` | Findings print as warnings, the build passes. Use while existing bots still violate a floor |
| `error` | Findings fail `compile.py check`. Flip to this once the bots have moved |

```
python3 .agents/org/compile.py check              # org.yaml plus config, prints warnings
python3 .agents/org/compile.py routing            # also writes .agents/org/routing.json for the router
python3 .agents/org/compile.py routing --overview # also writes the generated overview page
```

`routing.json` is generated; edit the YAML, never it. The overview page (`Areas/argo/second-brain/org/overview.md` in the reference vault) lists agent, runtime, model, tier and capabilities, the model catalog, the repos, and the current floor violations.

## The router

`decide(input, config)` in `org-router.ts` is a pure function: it reads the config and returns a decision. It never starts a run.

```
signals -> hard floor -> bot's tier envelope -> start tier (+ escalations) -> cheapest healthy model -> budget
```

### Signals

| Signal | How it is read today |
|---|---|
| Work type | The card type: research, coding, design, media, writing, sales, education, ops |
| Role | `work`, `review`, `merge` or `deploy` |
| Scope | Files the card names or a diff touched (`--files`); `0` means unknown. The dispatcher reads it from the card ([classifier](#the-classifier)) |
| Named path | The card names a path (`--path`) |
| Spec clarity | `ok` or `low` (`--spec low`); the dispatcher reads it from the card |
| Risk | The repo or project risk class (`--risk high`), risk flags from the classifier, plus risk keywords found in the card title |
| Retries | The earlier failures on this card, oldest first |
| Spend | Money already spent on the card and, today, per provider; read from the log for the [budgets](#budgets) |

Everything the router does is deterministic. Only the classifier's optional model step is not, and it can only make a reading stricter.

### The classifier

`org-classify.ts` reads a card's title, body and contract (`cards` table) and returns the signals the router needs. `cli-org route classify --card <id>` prints them; the dispatcher logs them in `route_decisions.signals.classified`.

| Signal | Rule |
|---|---|
| Paths | Tokens whose last segment has a source or config extension (`src/a.ts`, `Board.tsx`, `0001_init.sql`), slash paths in backticks or ending in `/`, and the contract's `scope` entries. URLs and prose like `and/or` are not paths |
| Scope | Distinct named files; a named directory counts as two; more than one repo makes it at least two |
| Named path | At least one path |
| Repos | The card's `repo`, plus `github.com/<owner>/<repo>` and `--repo <name>` in the text |
| Spec clarity | `ok` when any of: acceptance criteria (`Acceptance criteria`, `Done when`, a `- [ ]` checklist, the contract's `returns`), a verification command (a backticked `npm`, `npx`, `pytest`, `make`, `curl` and similar, a `Verify:` or `Test:` line, the contract's `verification`), a path or a URL. Otherwise `low` |
| Risk flags | `migration` (migrate, `migrations/`, `.sql`), `auth` (auth, login, oauth, jwt, RLS, an `auth/` path), `secret` (secret, credential, password, API or private key, `.env`, `.pem`), `payment` (payment, billing, invoice, refund, Stripe, money, wallet), `deploy` (deploy, rsync, a `deploy/` path), `prod` (prod, production). Whole words only, so "product" or "author" do not match. Any flag makes the risk `high` |

The optional model step asks a t0 model on an OpenAI-compatible endpoint (a local Ollama, for example) for strict JSON on spec clarity only. It may turn `ok` into `low`; it is not called when the rules already say `low`, and it never reads or changes risk. Any HTTP error, network error, timeout, non-JSON reply or unknown answer falls back to the rules reading, with a `note` saying why.

```json
{ "dispatch": { "routing": { "classifier": { "mode": "model", "model": "qwen3:4b", "baseUrl": "http://localhost:11434", "timeoutMs": 10000 } } } }
```

| Key | Default | Meaning |
|---|---|---|
| `mode` | `rules` | `rules` only, or `model` to add the model step |
| `model` | none | Model id on that endpoint; unset with `mode: model` means rules only |
| `baseUrl` | none | Server root or its `/v1`; `/v1/chat/completions` is appended |
| `timeoutMs` | `10000` | After this the step is abandoned and the rules reading stands |

### Hard floors

Floors beat cost. The router takes the **highest** tier any rule demands.

| Rule | Floor |
|---|---|
| Coding, exactly one file and a named path | `t1` |
| Any other coding | `t2` |
| Role `merge` or `deploy`, or high risk (repo class or a risk keyword) | `t3`, and never a local model |
| Reviewer | At least the author's tier |
| Coding on a model with `can_code: false` | Never, at any tier |
| Low spec clarity and a coding card over one file | Not run: the decision is `ask-spec` |

If the floor is above the bot's envelope, the decision is `park` (needs the owner). **The router never runs a job below its floor**, and never climbs past the envelope on its own.

### Escalation

The router starts at the cheapest envelope tier that meets the floor and climbs on evidence.

| Failure | Climb |
|---|---|
| Turn cap hit with no commit | One tier, after each occurrence |
| Tests or typecheck failed | One tier per two failures |
| Reviewer requested changes | One tier per two rejections (for the author; the reviewer's floor is unchanged) |
| Permission block (sandbox refusal, guard block) | **None.** The decision is `blocked`: report `BLOCKED` and stop. A stronger model does not fix a permission |

Past the top of the envelope the decision is `park`.

### Decisions

| `action` | Meaning | CLI exit code |
|---|---|---|
| `run` | Run `model` on `tier` with `turns` and `tokens` as the budget | 0 |
| `ask-spec` | Comment on the card asking for a spec; do not run | 2 |
| `park` | Floor above the envelope, or the envelope is exhausted; needs the owner | 2 |
| `wait` | No healthy model at or above the floor (a provider is down); wait, never drop below the floor | 2 |
| `blocked` | An earlier attempt hit a permission block | 2 |

Every decision carries a `reason` string and the `signals` that produced it, so a log line explains itself.

### Budgets

Turn and token caps per tier come from `tiers` in `routing.yaml`. Money caps are an optional `budgets` block beside it:

```yaml
budgets:
  card_ceiling_usd: 5            # all routed runs on one card, all time
  provider_daily_usd:            # per provider per UTC day
    anthropic: 20
    openrouter: 10
```

| Key | Effect when reached |
|---|---|
| `card_ceiling_usd` | The decision is `park` (`card cost X USD reached its ceiling of Y USD; needs the owner`), before any other rule except a permission block |
| `provider_daily_usd.<provider>` | That provider's models are skipped **inside the tier the router chose**. If every model on that tier is capped, the decision is `wait` (`daily cap reached on t2 (...)`). A cap never moves a run to another tier: floors are not relaxed, and the router does not climb to spend elsewhere |

Spend is read from the log: a run's cost is its `route_outcomes.cost_usd`, else the `total_cost_usd` that `usage_runs` logged for the same run id. Models marked `local: true` count zero and are never capped. Unset keys, or a `null` value, mean no cap. `compile.py routing` must copy the `budgets` block into `routing.json` for the router to see it.

### Fixed bots

Leads, the merger and the deployer stay on a fixed model. `checkFixed(model, input, config)` runs the same floors against that model and reports a violation rather than hiding it.

## cli-org route

```
cli-org route decide --work <type> --tiers t1,t2 [options]
cli-org route outcome <decision id> <merged|rejected|parked|blocked|done|failed> [options]
cli-org route classify --card <id> [--json]
cli-org route report [--since 7d | --days 7] [--json | --markdown]
```

| `decide` option | Meaning |
|---|---|
| `--work` | Card type (required) |
| `--tiers` | The bot's envelope, comma-separated (required) |
| `--role` | `work` (default), `review`, `merge`, `deploy` |
| `--files N`, `--path` | Scope and whether a verified path is named |
| `--spec low` | Spec clarity is low |
| `--risk high` | Repo or project risk class |
| `--text "..."` | Card text, scanned for risk keywords |
| `--author-tier t2` | For `--role review` |
| `--failures a,b` | `turn_cap_no_commit`, `tests_failed`, `review_changes`, `blocked` |
| `--down provider,..` | Providers to treat as unhealthy |
| `--config file` | Path to `routing.json` (default: `$ORG_ROUTING_JSON`, then `.agents/org/routing.json`) |
| `--card t_..` | Read the card's earlier failures and its spend for the budgets |
| `--record --agent a --card t_..` | Write a `route_decisions` row and print its id |
| `--json` | Machine output |

`outcome` options: `--turns`, `--tokens`, `--cost <usd>`, `--from <tier>` (the tier it escalated from), `--verified`.

Examples, against the default config:

```
$ cli-org route decide --work coding --files 1 --tiers t1,t2
run sonnet (t2, 30 turns): floor t2: coding -> t2; cheapest healthy: sonnet

$ cli-org route decide --work coding --files 1 --path --tiers t1,t2
run haiku (t1, 20 turns): floor t1: coding -> t1; cheapest healthy: haiku

$ cli-org route decide --work ops --role deploy --tiers t1,t2
park: floor t3 (deploy -> t3; high risk -> t3) is above the bot's envelope (t1, t2); needs the owner, never run lower
```

## The log and the weekly numbers

Migration `1756000016400_route-decisions.sql` adds:

| Table | Columns (core) |
|---|---|
| `route_decisions` | id, run_id, card_id, agent, action, signals, tier, model, reason, budget, created_at |
| `route_outcomes` | decision_id, result, turns, tokens, cost_usd, escalated_from, verified |
| `config_applies` | id, git_sha, plan, applied_by, applied_at (reserved for `cli-org apply`) |

`cli-org route report` returns, per tier: runs, how many escalated, how many were merged, total cost, and **cost per merged PR**. That last figure is the real comparison between cheap-and-retry and expensive-once. A run's cost is its outcome's `--cost`, else what `usage_runs` logged for the run; it stays `unknown` when neither has one.

`--since 7d` (or `--days 7`) sets the window. `--markdown` prints the weekly report as a standalone page, with a title and a generated-at line, ready to write to a vault file:

```
cli-org route report --since 7d --markdown > <vault>/org/routing-report.md
```

| Table | Read from | Why |
|---|---|---|
| Escalation rate by work type and tier | Run decisions; escalated when the outcome has `escalated_from` or the decision counted escalations | A tier that always escalates is the wrong default |
| Cost per merged PR by tier | Run decisions and their outcomes | Cheap-and-retry against expensive-once |
| Parked and blocked cards by cause | Non-run decisions (low spec clarity, floor above the envelope, top of the envelope, card cost ceiling, provider daily cap, no healthy model, permission block) and runs whose outcome was `parked` or `blocked` | Spec and permission problems no model fixes |
| Reviewer rejection rate by author tier | Author runs whose outcome is `merged` or `rejected` | Calibrates the reviewer floor |

A table with no rows reads "No data yet."

Tune the rules from this report, not from guesses. Keep a note for each rule change in your harness experience log: the run that showed the problem, the change, and the run that showed it worked.

## Rollout

| Phase | Ships | Verified by |
|---|---|---|
| 0 | Config files, cross-checks, `routing.json`, overview page | `compile.py check` flags a coder pinned to `can_code: false` |
| 1 | Router, log tables, `cli-org route` | Router unit tests replay the failed run; the CLI gives `sonnet` for it |
| 2 | Dispatcher asks the router before a wake and passes the model | A wake on a coding card runs on the routed model; a `route_decisions` row exists |
| 3 | `cli-org plan` / `apply`: files reconcile to the database, retirement of removed bots | Add a throwaway bot by file, see it appear, remove it with `--prune`, history intact |
| 4 (this release, engine part) | Card classifier (rules, optional t0 model step), card cost ceiling and provider daily caps, `route classify`, `route report --markdown` | Classifier, model fallback, cap and report tests; the report shows cost per merged PR by tier for two weeks |
| 5 | Split `agents:` into `agents/*.yaml` | `cli-org import` output unchanged for the existing roster |

Start with `enforce_model_floors: warn`, read the warnings, move the offending bots, then switch to `error`.

## Limits

- The classifier reads only what the card says. A card that names no file has scope `0` (unknown), so it is not asked for a spec even when its clarity is `low`; it runs at `coding_default`. `cli-org route decide` without `--files` and `--spec` still takes the lenient defaults.
- Novelty (no similar card closed by a lower tier) is not a signal yet.
- A model with a `null` price is ordered after a priced one inside a tier, so fill prices before you rely on cost ordering.
- Local-model runs share their host with other work. The router has no queue-depth signal from the host, so a busy host is not seen.
- Only an owner-run session should edit config. Make the config directory read-only to bots in your guard rules; the capability rows in the database stay the thing the wrappers check, so a bot that edited a file still could not grant itself a power.

## Dispatcher integration

`secondbrain org-dispatch tick` calls `decide` for every card wake of a zen-agent bot. Set it in `secondbrain.json`:

```json
{ "dispatch": { "routing": { "mode": "shadow", "config": ".agents/org/routing.json", "maxTier": "t3" } } }
```

| Mode | Effect |
|---|---|
| `off` (default) | The bot's own model runs; the router is not read |
| `shadow` | The decision and the run's outcome are logged to `route_decisions` / `route_outcomes`; the run is unchanged. Use first, then compare with `cli-org route report` |
| `on` | A `run` decision sets `--model`, `--max-turns` and `--max-tokens`; `park`, `ask-spec`, `wait` and `blocked` finish the wakeup with the reason and start no run |

- **Envelope:** the tiers from the bot's own model tier up to `maxTier`. Unset, the envelope is the bot's own tier only, so nothing climbs. A coder on a model below its floor is parked (needs the owner), never run.
- **Escalation:** a budget stop (`stopped: budget`) is logged as `failed` and counts as a turn-cap miss on the next wake of that card, which then starts one tier up.
- **Scope:** only cards with an id are routed. Card-less wakes (DMs, routines) keep the bot's model. Scope, named path, spec clarity and risk flags come from [the classifier](#the-classifier) (`dispatch.routing.classifier`); the router's own keyword scan still reads only the title. Spend for the [budgets](#budgets) is read from the log before each decision.
- **Models:** zen-agent needs `provider/model` ids, so the catalog entries a zen-agent bot uses must be named that way. A bot whose model is not in the catalog is skipped with a log line.
- **Claude Code bots** (atlas, sable, rune, kael, idris, vera as of 2026-10-30) are not dispatched here; routing them needs the same call in their dispatcher.
