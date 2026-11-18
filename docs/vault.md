# Your vault

Status: **works** - the vault template, the `secondbrain-vault` CLI and the engine update flow ship as described.

The vault is yours: a private git repo of markdown, organised with PARA. This page covers what the template gives you, the `secondbrain-vault` CLI, how agent rules and skills are layered, and how to take engine updates.

## The template

`secondbrain-vault init <dir>` copies `vault-template/` into an empty folder and wires it up. What you get is listed in [Set up your vault](onboarding/02-set-up-your-vault.md#step-2-create-the-vault). The parts that matter later:

| File | You edit it? | Notes |
|---|---|---|
| `AGENTS.local.md` | Yes | Your rules for agents: folder conventions, your areas and projects, your voice, your no-go zones |
| `AGENTS.md` | No | Generated. `rules` rewrites it; `rules --check` fails if someone hand-edited it |
| `CLAUDE.md` | Rarely | `@AGENTS.md` plus anything Claude-Code-only |
| `.agents/guard.local.json` | Yes | Your extra guard rules ([agent-harness.md](agent-harness.md#your-own-rules-guardlocaljson)) |
| `.agents/skills/` | Yes | Your own skills; the engine's are symlinked in |
| `.env` | Yes | Keys and per-machine settings; gitignored ([configuration.md](configuration.md)) |
| `secondbrain.json` | Yes | Structured settings for modules; committed ([configuration.md](configuration.md#secondbrainjson)) |
| `PARA Guide.md` | Optional | How to decide between Projects, Areas, Research and Archives |

Template files that would act on the engine repo itself are stored without their leading dot (`gitignore`, `env.example`) and renamed by `init`.

## Areas and projects

The vault is organised with PARA, and the tracker (the `projects` module) uses the same two words the same way:

| | What it is | Has | Example |
|---|---|---|---|
| **Area** | A standard you keep up. It has no end date | A status (`active` or `parked`), a home note, a team, a division | `health`, `newsletter` |
| **Project** | An outcome with an end, inside one area | An `outcome` (what done means), a stage (`idea` to `done`), a due date, a next action, verifications | `newsletter/issue-12` |

Areas are what you run, projects are what you finish, the home note is what you know.

- **The home.** `cli-areas set <area> --home <path>` names the area's home note or folder in the vault (for example `Areas/newsletter/README.md`). The facts that differ per area (description, links, style) live there as markdown, not in the tracker.
- **Project folders.** When an area has a home, `cli-projects add <area>/<project> --outcome "..."` also creates `<home>/projects/<project>/README.md` with frontmatter (`kind: project`, `area`, `project`, `outcome`) and records it as the project's notes. A README that already exists is never overwritten. Top-level `Projects/` stays for work that belongs to no area.
- **Archive.** `cli-areas archive <area>` and `cli-projects archive <area>/<project>` hide a row from every active view (`--archived` shows them) and delete nothing: the stage and the history stay, and `unarchive` brings it back as it was. Archiving an area hides its projects with it. Real deletion is `archive --purge --yes`.
- **Stages are for projects.** `done` means the outcome was reached and `parked` means paused. An area is only `active` or `parked`.
- **Change history.** Every change to an area or a project is kept in one log, `tracker_events`: who, how (`cli`, `api`, `board`), which field, the old and the new value. Database triggers write it, one row per changed column, so no command can forget to. The log is append-only. See [modules.md](modules.md#change-history).
- **Home note frontmatter.** A home note says what it is: `kind: area` and `area: <slug>`, or `kind: project` with `area:` and `project:`. When the scanner sees the frontmatter of such a note change, it adds one row to the log per top-level key that differs (`kpis`, `links`, ...), with both values. Editing the body logs nothing: git keeps that. The first time a note is indexed is the baseline, not a change.
- **The context pack and the weekly review.** `cli-areas show <area>` prints what the home note and the tracker say about an area in one page (links, style paths, goals, KPIs, roadmap, the last 14 days), for an agent about to work on it. `cli-areas review` writes the week's changes to `Areas/weekly-review/<week>.md` and leaves your `## Reflection` alone ([modules.md](modules.md#context-pack)).
- **KPIs are optional.** An area defines them in its home note, and records readings with `cli-areas record <area> <kpi> <value>`:

  ```yaml
  ---
  area: newsletter
  kind: area
  kpis:
    - {key: subscribers, name: Subscribers, unit: people, target: 1000}
  ---
  ```

  A key that is not in `kpis:` is refused, with the list of the keys that are, so a typo never starts a second series. An area with no `kpis:` has no KPIs anywhere. A KPI where lower is better (a cost, a response time) says `direction: down`, so "at target" is judged the right way round.
- **The area page reads the home note.** `/areas/<area>` shows `description`, `links` (websites, repos, socials, anything else, as given), `style.guide` (rendered), the images in the `style.assets` folder, `goals` and `kpis`, next to the roadmap and the recent history from the tracker. Every key is optional, and a section with nothing in it is not drawn. See [modules.md](modules.md#the-area-page).

The tracker was renamed to these words in one step (what it called a project is an area, what it called a feature is a project). The old commands keep working for 14 days, each with a warning that names the new one: see [modules.md](modules.md#projects).

## `secondbrain-vault`

```
.secondbrain/bin/secondbrain-vault init [DIR]          start a new vault in DIR
.secondbrain/bin/secondbrain-vault rules [--check] [--force]
                                                       AGENTS.md = AGENTS.base.md + AGENTS.local.md
.secondbrain/bin/secondbrain-vault link-skills         symlink the engine's skills into .agents/skills/
.secondbrain/bin/secondbrain-vault sync run|status|install|uninstall|resolve
                                                       keep this checkout in step with your other machines (sync.md)
.secondbrain/bin/secondbrain-vault clis install|uninstall|status
                                                       the agent CLIs (cli-board, cli-org, ...) on this machine's PATH
```

The vault it acts on is `--vault`, else the folder that holds the engine as `.secondbrain/`, else the current directory. It is Python 3.9+, standard library only.

- `rules --check` exits non-zero if `AGENTS.md` is stale or was edited by hand. Useful in a pre-commit hook.
- `rules --force` overwrites a hand-edited `AGENTS.md`.
- `link-skills` never replaces a real folder: if you have your own skill with the same name as a shared one, yours wins.
- `clis install` writes every wrapper the feature manifests name into `~/.local/bin`: `cli-board` over HTTPS, the rest as a one-line server-only notice. `init` runs it (`--no-clis` skips); it never overwrites a file it did not write, and does nothing on the server. [Connect machines](onboarding/06-connect-machines.md#the-agent-clis-on-the-laptop-and-every-other-machine).
- `sync run|install|status|resolve` keeps this checkout in step with your other machines by git, on a timer: [sync.md](sync.md).

## Rules for agents, in layers

| Layer | File | Who changes it |
|---|---|---|
| Shared rules every vault gets | `.secondbrain/vault-template/AGENTS.base.md` | A pull request to the engine |
| Your rules | `AGENTS.local.md` | You |
| What agents read | `AGENTS.md` (generated) | `secondbrain-vault rules` |
| Per-folder rules | An `AGENTS.md` (and a `CLAUDE.md` that imports it) inside a folder | You |

The base rules cover: markdown as the deliverable format, where files go, the house style for research notes, how to handle credentials, copy-ready text, completion contracts for long tasks, what the guard blocks, and the dev-log requirement. Read `AGENTS.base.md` once; it is short.

## Skills

A skill is a folder with a `SKILL.md` (YAML frontmatter with `name` and `description`, then instructions). Claude Code finds them through `.claude/skills` (a symlink to `.agents/skills`); Hermes through `skills.external_dirs` ([agent-harness.md](agent-harness.md#hermes)).

Shared skills in the engine today:

| Skill | Pairs with |
|---|---|
| `setup-vault` | Any vault: takes an empty folder to a running vault, asking a few questions and checking each step |
| `fact-check` | The `fact-checker` subagent: verifies a finished note against its sources |
| `ingest` | Any vault: turns a link (article, video, paper) into a summarised note tied to your goals |
| `company-report` | The `projects` module: reads and updates the tracker with `cli-areas` and `cli-projects` |
| `org-member` | The `org` module: how a named agent works on the message board |
| `livestream-x` | The `livestream` module: adds an X stream by link |

## Updating the engine

```bash
git -C .secondbrain fetch origin
git -C .secondbrain checkout origin/main          # or a tag, or a specific commit
.secondbrain/bin/secondbrain-vault rules          # AGENTS.base.md may have changed
.secondbrain/bin/secondbrain-vault link-skills    # new shared skills
.secondbrain/bin/secondbrain-vault clis install   # a new wrapper, or a new cli-board bundle
secondbrain restart                               # the launcher rebuilds and migrates as needed
git add .secondbrain AGENTS.md .agents/skills && git commit -m "engine: update"
```

The pin is just a commit hash in your vault, so rolling back is checking out the previous one. Migrations only move forward, though: rolling the app back past a migration it has already run means the old code meets a newer schema. Check the release notes or the diff of `app/db/migrations/` before rolling back.

On a server, take the same pin and redeploy ([deployment.md](deployment.md)).

## Changing the engine from inside your vault

Don't edit the pinned `.secondbrain/` checkout in place: your next pin move would discard it, and it mixes your vault work with engine work. Use a worktree:

```bash
git -C .secondbrain worktree add ../secondbrain-my-fix -b fix/my-fix origin/main
# work in ../secondbrain-my-fix, then push the branch and open a PR
```

Once it's merged, move your pin. [`CONTRIBUTING.md`](https://github.com/kon-rad/argo/blob/main/CONTRIBUTING.md) has the rest.
