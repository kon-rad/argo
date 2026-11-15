---
name: company-report
description: Report on and update the tracker (divisions, teams, areas, projects, stages, verifications, needs-you, gaps) through `cli-areas` and `cli-projects`. Use when the user asks "how are the projects?", "company report", "status report", "what's blocked on me?", "what's in the backlog?", "what shipped this week?", "what stage is X at?", "what are the gaps?", or says an area or project moved ("X is in testing", "mark Y done", "park Z", "archive W"). Also use at the end of any build session to record the project's stage and the checks you ran. Needs the app's `projects` module.
---

# Company report

The tracker is the status board (the app's `projects` module). It uses the two words PARA uses:

- An **area** is what the user runs: a standard they keep up, with no end date. It has a status, `active` or `parked`, and no stage and no due date.
- A **project** is what gets finished: an outcome with an end, inside one area, written `<area>/<project>`. It moves through one stage list: `idea` (the backlog) → `designing` → `building` → `testing` → `live`, plus `parked` and `done`.

Divisions group areas and **teams** do the work. Nothing counts as shipped without evidence: a project moves to `live` or `done` only when its newest **verification** passed, or with `--unverified "<why>"`, which the report then lists as a gap.

Status lives in Postgres (`divisions`, `teams`, `areas`, `projects`, `verifications`, and `tracker_events`, the log of every change, which `stage_changes` is a view of). The why and the how stay in markdown: the area's home note, design docs and dev logs. Goals stay in the vault's goals file (`goalsFile` in `secondbrain.json`); rows link to them by code (W1, M2, Q1, Y3). The report file (`projects.reportFile`, default `projects.md`) is **generated** from the database: never edit it.

The user sees it on the app's `/projects` page, in any kiosk that reads `/api/feed/projects`, and wherever this skill replies.

**If you learned the old words:** until the PARA rename the tracker called an area a "project" and a project a "feature". `cli-projects add-project`, `remove-project`, `set <slug>` with no slash, `team`, `division`, `import` and `render` still work for 14 days and print a warning naming the new command; after that they exit 2. Use the commands below.

## Running the CLI

On the server, `cli-areas` and `cli-projects` are on the app user's PATH (`deploy.sh` installs them with the `projects` module):

```bash
cli-areas <command> [args]
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
| "How are the projects?", "company report", "status" | `cli-projects report` (chat-sized text by default; `cli-areas report` is the same report) | The output as is. Add nothing it doesn't say |
| "What's blocked on me?" | `cli-projects report` | Only its "Needs you" list |
| "What stage is X at?", "what's left on X?" | `cli-areas list` | That area's lines: its status, each project's stage and days in stage, verified or not, needs-you |
| "What's in the backlog?" | `cli-projects list --stage idea` | Projects in `idea`, by area |
| "What's due?" | `cli-projects list --due-before YYYY-MM-DD` (add `--area <area>`) | The projects with their due dates |
| "What did we archive?" | `cli-areas list --archived`, `cli-projects list --archived` | The rows marked `archived` |
| Full detail, a weekly review | `cli-projects report --format markdown` | Point to the `/projects` page rather than pasting it into chat |

Never invent a stage, a date or a count: if the tracker doesn't have it, say it isn't tracked yet.

## Updating (write)

The user's message is the authority for their own items; for anything else, record what you observed and how.

| The user says / you did | Run |
|---|---|
| "X moved to testing" | `cli-projects set <area>/<project> --stage testing --note "<their words>"` |
| "I did the thing you needed" | `cli-projects set <area>/<project> --needs none --note "<what they did>"` (for an area: `cli-areas set <area> --needs none`) |
| "Add Y to X" / a new idea | `cli-projects add <area>/<slug> --outcome "<what done means>"` (lands in the backlog; add `--title "Y"` for a short name, `--stage designing` etc. if they say so) |
| "It works" / you ran a check | `cli-projects verify <area>/<project> --pass --kind test --check "<what was run>" --evidence "<numbers or output>"` (`--fail` if it failed) |
| "Ship it" / mark live or done | First a passing `verify`, then `cli-projects set <area>/<project> --stage live`. Without evidence, only with the user's explicit `--unverified "<their reason>"` |
| X is blocked | `cli-projects set <area>/<project> --blocked "<on what>"` (an area: `cli-areas set <area> --blocked "..."`) |
| X needs the user | `cli-projects set <area>/<project> --needs "<the one thing they must do>"` |
| What happens next on X | `cli-projects set <area>/<project> --next "<the next action>"` |
| "Park the whole of X" / "pick X back up" | `cli-areas set <area> --status parked --note "<why>"` / `--status active` |
| A new area | `cli-areas add <slug> --title "T" --team <team> --division <division> --home <path> --devlog <path> --design <path>` |
| "We don't track X any more" | `cli-projects archive <area>/<project> --note "<why>"` or `cli-areas archive <area> --note "<why>"` |
| "Bring X back" | `cli-projects unarchive <area>/<project>` or `cli-areas unarchive <area>` |
| Link to a goal | `cli-projects set <area>/<project> --goals W1,M2` (an area: `cli-areas set <area> --goals ...`) |

Project fields: `--title --outcome --next --stage --health green|yellow|red --due YYYY-MM-DD --owner WHO --notes PATH --goals --needs --blocked`. Area fields: `--title --status --division SLUG --team SLUG --health --priority N --home PATH --devlog PATH --design PATH --paths a,b --repos a,b --goals --needs --blocked`. `none` clears a field. Teams: `cli-areas team <slug> --name N --lead L --members a,b`. Divisions: `cli-areas division <slug> --name N --mission M --head H`.

**Outcome.** A project says what done means. `add` asks for `--outcome`; write it as a result you could check ("The newsletter goes out every Friday from the new sender"), not as a task.

**Project folders.** When the area has a home (`cli-areas set <area> --home <path>`), `cli-projects add` creates `<home>/projects/<project>/README.md` with the project's frontmatter and records it as the project's notes. It never overwrites a README that is already there: it tells you it left it as it is.

**Archive is not delete.** Archiving hides a row from the report and the lists and changes nothing else: the stage and the history stay, and unarchiving brings it back as it was. Archiving an area hides its projects with it. `done` means the outcome was reached and stays visible until archived. Deleting for good is `archive ... --purge --yes`, and only when the user asks for it in those words.

A refused move prints why (`can't move to live: it has no verification`). Don't work around it with `--unverified` on your own: run the check, record it, then move it, or ask the user.

After a write, confirm in one line what changed, for example: "Search / Phase 1: building → testing. It's on the board now."

## At the end of a build session (every agent)

Alongside the dev-log entry, record the tracker side of the same work:

1. `cli-projects set <area>/<project> --stage <new stage>` for anything that moved, and `--next "<the next action>"`.
2. `cli-projects verify ... --pass|--fail` for every test run, deploy check or manual check you did, with the real numbers.
3. `--needs` for anything only the user can do next, `--needs none` for what's resolved.

## Internal, not public

Everything this skill prints is **internal** (needs-you, gaps, next actions). Never paste it into a public channel (a blog, a social post, a livestream chat) without the user's approval.

## Kiosk feed

A kiosk reads `GET /api/feed/projects` with `Authorization: Bearer $PROJECTS_FEED_TOKEN`. `deploy.sh` generates the token on the server's env file the first time; copy it machine to machine without printing it, for example:

```bash
ssh <server> "grep '^PROJECTS_FEED_TOKEN=' /etc/secondbrain/env" | ssh <kiosk> 'cat >> <kiosk env file>'
```

The feed is read-only. Its path and its keys are the ones kiosks already read: the list it calls `projects` is the areas, each with its projects in flight.
