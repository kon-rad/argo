# Org config and model routing

A bot keeps its persona, permissions and memory. **The model that runs a given job is chosen per run**, by rules, inside the envelope you give the bot. This page covers the config files the rules read, the router, the `cli-org route` commands, the log tables, and how to roll the whole thing out.

Where it sits: [org.yaml](org-yaml.md) says who the agents are and what they may do. The files described here say which models exist and what each is good for. The router joins the two when a card is about to run. Dispatch is in [agent-harness](agent-harness.md) and [zen-runtime](zen-runtime.md).

!!! note "What is built, and what is not"
    Built: the config files and their cross-checks (in your vault's `compile.py`), the router (`app/server/src/org-router.ts`), the `route_decisions` / `route_outcomes` / `config_applies` tables, and `cli-org route decide|outcome|report`. The zen-agent dispatcher calls the router for card wakes (`dispatch.routing`, below). Not built yet: routing for Claude Code bots (their dispatcher is separate), `cli-org plan` and `apply`, the `agents/*.yaml` split, and the t0 classifier. See [Rollout](#rollout).

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
| Scope | Files the card names or a diff touched (`--files`); `0` means unknown |
| Named path | The card names a verified path (`--path`) |
| Spec clarity | `ok` or `low` (`--spec low`), given by the caller |
| Risk | The repo or project risk class (`--risk high`), plus risk keywords found in the card text |
| Retries | The earlier failures on this card, oldest first |

Everything is deterministic. There is no classifier in this version: spec clarity and risk come from the caller and the keyword list, so they are only as good as the intake step that fills them in.

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

### Fixed bots

Leads, the merger and the deployer stay on a fixed model. `checkFixed(model, input, config)` runs the same floors against that model and reports a violation rather than hiding it.

## cli-org route

```
cli-org route decide --work <type> --tiers t1,t2 [options]
cli-org route outcome <decision id> <merged|rejected|parked|blocked|done|failed> [options]
cli-org route report [--days 7] [--json]
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

`cli-org route report` returns, per tier: runs, how many escalated, how many were merged, total cost, and **cost per merged PR**. That last figure is the real comparison between cheap-and-retry and expensive-once. Cost stays `unknown` until outcomes carry a `--cost`.

Tune the rules from this report, not from guesses. Keep a note for each rule change in your harness experience log: the run that showed the problem, the change, and the run that showed it worked.

## Rollout

| Phase | Ships | Verified by |
|---|---|---|
| 0 | Config files, cross-checks, `routing.json`, overview page | `compile.py check` flags a coder pinned to `can_code: false` |
| 1 (this release) | Router, log tables, `cli-org route` | Router unit tests replay the failed run; the CLI gives `sonnet` for it |
| 2 | Dispatcher asks the router before a wake and passes the model | A wake on a coding card runs on the routed model; a `route_decisions` row exists |
| 3 | `cli-org plan` / `apply`: files reconcile to the database, retirement of removed bots | Add a throwaway bot by file, see it appear, remove it with `--prune`, history intact |
| 4 | Split `agents:` into `agents/*.yaml`; t0 classifier; weekly report page | `cli-org import` output unchanged for the existing roster |

Start with `enforce_model_floors: warn`, read the warnings, move the offending bots, then switch to `error`.

## Limits

- The router needs inputs it cannot compute on its own yet (scope, spec clarity). Until intake fills them, it defaults to `scope 0` and `specClarity ok`, which is the lenient reading.
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

- **Envelope:** the tiers from the bot's own model tier up to `maxTier`. Unset, the envelope is the bot's own tier only, so nothing climbs. A coder on a model below its floor is parked (needs Konrad), never run.
- **Escalation:** a budget stop (`stopped: budget`) is logged as `failed` and counts as a turn-cap miss on the next wake of that card, which then starts one tier up.
- **Scope:** only cards with an id are routed. Card-less wakes (DMs, routines) keep the bot's model. Files touched, named path and spec clarity are not known to the dispatcher yet, so a coding card is treated as multi-file (floor `coding_default`).
- **Models:** zen-agent needs `provider/model` ids, so the catalog entries a zen-agent bot uses must be named that way. A bot whose model is not in the catalog is skipped with a log line.
- **Claude Code bots** (atlas, sable, rune, kael, idris, vera as of 2026-10-30) are not dispatched here; routing them needs the same call in their dispatcher.
