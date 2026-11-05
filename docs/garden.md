# The vault gardener

Status: **works** - the vault gardener ships (PR #104); the timer runs in shadow mode until `garden.apply` is true.

`secondbrain garden` is a nightly command that keeps a PARA vault organised without anyone filing by hand. It treats every top-level folder under `Projects/`, `Areas/` and `Research/` as a **shelf**, gives each shelf note a small header, renders a catalog of every shelf, archives project shelves that are finished or stale, proposes stale areas, normalises folder names, and writes a report. Module `garden`; settings under `garden` in `secondbrain.json` ([configuration.md](configuration.md)).

## Why shelves

PARA says Projects and Areas hold only live work and everything else goes to Archives. Nothing enforces that, so the live folders fill with dead weight. The gardener needs one place to read and write the state of a folder; that is the shelf note (`README.md` by default, `garden.shelfFile`) and its frontmatter:

```yaml
---
shelf: Projects/demo          # the folder; always rewritten from the real path
status: active                # active | dormant | archived
project: none                 # a tracker project slug (module `projects`), or none
kind: project                 # project | area | resource, from the root folder
last_reviewed: 2026-11-03     # set on every run that writes
archive_after: default        # `default` = garden.projectArchiveAfterDays (90) for projects, never for others; or `120d`, or `never`
pin: false                    # true: never archive, propose or rename this shelf
---
```

The owner edits a line; the gardener obeys it on the next run. Keys that are not the gardener's (`title`, `tags`, anything else) are kept in place, and the body of the note is never rewritten except for one generated block at its end:

```markdown
<!-- shelf:start -->
**Status:** active · **Project:** demo · **Kind:** project · **Reviewed:** 2026-11-03
**Design:** [[demo-design]]
**Next action:** Ship the thing
**Newest:** [[plan]] · [[notes]]
**Most linked:** [[plan]] (4)
**Siblings:** `Projects/other`
<!-- shelf:end -->
```

The **Next action** line comes from `<shelf>/dev-log/README.md` when it has a Resume block (`- **Next action:** ...`). Newest is by file mtime, most linked by inbound wikilinks.

## What a run does

| Step | Shadow | `--write` | `--apply` |
|---|---|---|---|
| Discover shelves, read headers | yes | yes | yes |
| Plan: archive, propose, rename, loose notes | yes | yes | yes |
| Move and rename with `git mv`, rewrite path links | | | yes |
| Write shelf notes (create missing ones) and the generated block | | yes | yes |
| Write the catalog (`garden.catalogFile`, default `garden/catalog.md`) | | yes | yes |
| Write the report (`garden.reportDir/<date>.md`) | yes | yes | yes |

Rules, in order, one action per shelf:

1. `pin: true`, `status: archived`, or listed in `garden.pinned`: nothing.
2. A **project** shelf whose tracker project is `parked` or `done`, or with no commit in `archive_after` days (or no git history at all), moves to `<archiveDir>/<YYYYQn>/projects/<name>` and gets `status: archived`.
3. An **area** shelf with no tracker project and no commit in `garden.areaProposeAfterDays` (180) is **proposed** in the report. Areas are standards you maintain, so a quiet one is not a dead one; the gardener never moves them on its own.
4. A **resource** shelf (`Research/`) is never archived by age.
5. A folder whose name is not lowercase kebab-case is renamed (`Models Research` becomes `models-research`), up to `garden.maxRenames` (5) a night.

Notes sitting loose directly in a root folder (`Research/x.md`) are listed under "Needs a human". The vault root itself is yours and is not scanned.

Caps and safety: at most `garden.maxMoves` (25) archive moves a night; never a delete; `git mv` only, so one night is one commit you can `git revert`; a move is refused when its target exists, its source is gone, or any file under it has uncommitted changes (those belong to whoever is editing them); the shelf note and catalog are skipped when they themselves are uncommitted. Nothing under dot-folders, nested repositories, `node_modules` and the like is ever a shelf.

The gardener does not commit. Pair it with the vault sync timer ([sync.md](sync.md)), which commits whatever it changed, or commit by hand after reading the report.

## Running it

```
secondbrain garden                 # shadow: report only
secondbrain garden --write         # shelf notes, catalog, report
secondbrain garden --apply         # also move and rename
secondbrain garden --no-db         # don't ask the tracker for project stages
secondbrain garden --today 2026-11-03 --no-wiki
```

Exit code 2 means apply mode refused at least one move; the report says which and why.

On a server with `MODULES=...,garden`, `deploy.sh` installs `secondbrain-garden.timer`, which runs `--write` at 04:30 Asia/Tokyo. Set `"garden": { "apply": true }` in `secondbrain.json` once a week of reports looks right, and the same timer starts moving files.

## Reading the report

```
# Garden report 2026-11-03
**Mode:** write (shelf notes and catalog written, nothing moved)
119 shelves, 41 shelf notes created, 17 archive candidates, 12 proposals, 5 renames, 9 for a human.
## Would archive        a table: from, to, reason, result
## Proposed (areas)     a numbered list; archive one with status: archived, keep it with pin: true
## Would rename
## Needs a human        loose notes, over-cap items, refused moves
## Skipped: uncommitted changes
```

To revert a night that applied: `git log --oneline -n 5`, then `git revert <sha>` of the gardener's commit.
