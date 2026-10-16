---
name: company-report
description: Report on and update the project tracker (divisions, teams, projects, features, stages, verifications, needs-you, gaps) through `cli-projects`. Use when the user asks "how are the projects?", "company report", "status report", "what's blocked on me?", "what's in the backlog?", "what shipped this week?", "what stage is X at?", "what are the gaps?", or says a project or feature moved ("X is in testing", "mark Y done"). Also use at the end of any build session to record the feature's stage and the checks you ran. Needs the app's `projects` module.
---

# Company report

The project tracker is the status board (the app's `projects` module). Divisions hold **projects**, **teams** do the work, projects are made of **features**, and every feature moves through one stage list: `idea` (the backlog) → `designing` → `building` → `testing` → `live`, plus `parked` and `done`. Nothing counts as shipped without evidence: a feature moves to `live` or `done` only when its newest **verification** passed, or with `--unverified "<why>"`, which the report then lists as a gap.

Status lives in Postgres (`divisions`, `teams`, `projects`, `features`, `stage_changes`, `verifications`). The why and the how stay in markdown: design docs and dev logs. Goals stay in the vault's goals file (`goalsFile` in `secondbrain.json`); rows link to them by code (W1, M2, Q1, Y3). The report file (`projects.reportFile`, default `projects.md`) is **generated** from the database: never edit it.

The user sees it on the app's `/projects` page, in any kiosk that reads `/api/feed/projects`, and wherever this skill replies.

## Running the CLI

On the server, `cli-projects` is on the app user's PATH (`deploy.sh` installs it with the `projects` module):

```bash
cli-projects <command> [args]
```

From another machine, one ssh call per command (never loop ssh):

```bash
ssh <server> "sudo -u <app user> bash -lc 'PROJECTS_BY=<you>@<machine> cli-projects <command> [args]'"
```

Set `PROJECTS_BY` (or `--by`) to who is acting, e.g. `owner@telegram` when applying the user's own message, `claude@laptop`, `hermes@server`.

## Reporting (read)

| The user asks | Run | Reply with |
|---|---|---|
| "How are the projects?", "company report", "status" | `report` (chat-sized text by default) | The output as is. Add nothing it doesn't say |
| "What's blocked on me?" | `report` | Only its "Needs you" list |
| "What stage is X at?", "what's left on X?" | `list` | That project's lines: stage, each feature's stage and days in stage, verified or not, needs-you |
| "What's in the backlog?" | `list` | Features in `idea`, by project |
| Full detail, a weekly review | `report --format markdown` | Point to the `/projects` page rather than pasting it into chat |

Never invent a stage, a date or a count: if the tracker doesn't have it, say it isn't tracked yet.

## Updating (write)

The user's message is the authority for their own items; for anything else, record what you observed and how.

| The user says / you did | Run |
|---|---|
| "X moved to testing" | `set <project>/<feature> --stage testing --note "<their words>"` |
| "I did the thing you needed" | `set <project>[/<feature>] --needs none --note "<what they did>"` |
| "Add Y to X" / a new idea | `add <project>/<slug> --title "Y"` (lands in the backlog; add `--stage designing` etc. if they say so) |
| "It works" / you ran a check | `verify <project>/<feature> --pass --kind test --check "<what was run>" --evidence "<numbers or output>"` (`--fail` if it failed) |
| "Ship it" / mark live or done | First a passing `verify`, then `set <project>/<feature> --stage live`. Without evidence, only with the user's explicit `--unverified "<their reason>"` |
| X is blocked | `set <project>[/<feature>] --blocked "<on what>"` |
| X needs the user | `set <project>[/<feature>] --needs "<the one thing they must do>"` |
| A whole project changed stage | `set <project> --stage <stage> --note "<why>"` |
| A new project | `add-project <slug> --title "T" --stage idea --team <team> --devlog <path> --design <path>` |
| Link to a goal | `set <project>[/<feature>] --goals W1,M2` |

Other fields: `--division SLUG --health green|yellow|red --priority N --due YYYY-MM-DD --owner WHO --team SLUG --notes PATH`; `none` clears a field. Teams: `team <slug> --name N --lead L --members a,b`. Divisions: `division <slug> --name N --mission M --head H`.

A refused move prints why (`can't move to live: it has no verification`). Don't work around it with `--unverified` on your own: run the check, record it, then move it, or ask the user.

After a write, confirm in one line what changed, for example: "Search / Phase 1: building → testing. It's on the board now."

## At the end of a build session (every agent)

Alongside the dev-log entry, record the tracker side of the same work:

1. `set <project>/<feature> --stage <new stage>` for anything that moved.
2. `verify ... --pass|--fail` for every test run, deploy check or manual check you did, with the real numbers.
3. `--needs` for anything only the user can do next, `--needs none` for what's resolved.

## Internal, not public

Everything this skill prints is **internal** (needs-you, gaps, next actions). Never paste it into a public channel (a blog, a social post, a livestream chat) without the user's approval.

## Kiosk feed

A kiosk reads `GET /api/feed/projects` with `Authorization: Bearer $PROJECTS_FEED_TOKEN`. `deploy.sh` generates the token on the server's env file the first time; copy it machine to machine without printing it, for example:

```bash
ssh <server> "grep '^PROJECTS_FEED_TOKEN=' /etc/secondbrain/env" | ssh <kiosk> 'cat >> <kiosk env file>'
```

The feed is read-only.
