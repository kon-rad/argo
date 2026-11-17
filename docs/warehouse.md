# Warehouse

Status: **new** - the `warehouse` addon (migrations, connector runner, `/warehouse` page, CLI) ships in this release.

The engine ships no use-case tables. Your vault owns its tables and the connectors that fill them. The engine applies the tables, runs the connectors on their schedules, and shows everything on one page: every table in the database with its rows and size, every connector with its last runs and errors, every scheduled job, your dashboards, and the database's total size.

New to it? The [warehouse guide](warehouse-guide.md) walks through connecting a source, every parameter, and adding, changing and removing sources.

Agents do the building, with three skills: `warehouse-table` (a new table), `warehouse-connector` (a new source) and `warehouse-dashboard` (a new dashboard). See [skills](#skills).

Module `warehouse`, off until listed: `{ "addons": ["warehouse"] }` in `secondbrain.json`.

## The warehouse folder

Everything lives in one vault folder, `warehouse.dir` in `secondbrain.json` (default `warehouse`, relative to the vault):

```
<warehouse.dir>/
  migrations/0001_instagram.sql      tables, in schema "data"
  connectors/instagram/connector.json
  connectors/instagram/run.mjs       any language
  dashboards/instagram.json
```

| Setting | Default | Meaning |
|---|---|---|
| `warehouse.dir` | `warehouse` | The folder above, vault-relative or absolute |
| `warehouse.rawDir` | `<app>/data/warehouse-raw` | Where connectors may keep raw responses: `<rawDir>/<connector>/<run id>/` |

## Tables

Your tables live in the Postgres schema `data`. They're created and changed only by SQL files in `<warehouse.dir>/migrations/`, named `NNNN_slug.sql`:

```sh
secondbrain warehouse migrate --dry-run   # what would run
secondbrain warehouse migrate             # apply, in name order
```

- Each file runs in its own transaction, with `search_path = data`, so `CREATE TABLE instagram_media` lands in `data.instagram_media`.
- Applied files are recorded in `data_migrations` with a checksum. **An applied file can't change:** write a new file instead. A changed one is refused, with its name.
- A file that reaches outside schema `data` is refused before anything runs. That covers `public.`, `CREATE/DROP SCHEMA`, roles, `GRANT`, `SET search_path`, extensions, and DDL on another schema. This is a guard against mistakes, not a security boundary.
- The deploy step runs `data migrate` after the engine's own migrations when the addon is on.

**Rules for a good table:**
- a primary key, so a re-run updates rather than duplicates;
- typed columns;
- `NULL` for a value the source didn't give, never 0;
- `timestamptz` in UTC;
- `numeric` for money, with a currency column;
- for numbers that change over time, a snapshot table keyed by id + day (for example `instagram_media_daily`).

## Connectors

A connector is a folder with a `connector.json` and a script:

```json
{
  "name": "instagram",
  "description": "Instagram professional accounts",
  "command": ["node", "run.mjs"],
  "schedule": { "every": "1d", "at": "03:10" },
  "timeoutSec": 1800,
  "tables": ["instagram_accounts", "instagram_media"],
  "env": ["INSTAGRAM_KONRADGNAT_ACCESS_TOKEN"],
  "config": { "accounts": [{ "username": "konradgnat", "tokenEnv": "INSTAGRAM_KONRADGNAT_ACCESS_TOKEN" }] },
  "enabled": true
}
```

| Key | Meaning |
|---|---|
| `name` | Must match the folder |
| `command` | Run in the connector folder, without a shell |
| `schedule` | `every`: `15m`, `6h`, `1d`, ...; optional `at` (`HH:MM`, UTC) for daily runs. Without it the connector only runs by hand |
| `timeoutSec` | Killed after this (default 900) |
| `tables` | The tables in schema `data` this connector may write. Any other is refused |
| `env` | Names of the keys it needs (never values). The page flags missing ones |
| `secrets` | Env names filled from the engine's own secret store when the run starts. Today: `"IG_TOKEN": "social-token:instagram:<account>"`, the encrypted, refreshed token the social metrics collector keeps (needs `SOCIAL_TOKEN_ENC_KEY`). The value never touches the vault, and it's redacted from errors |
| `config` | Anything the script needs; passed in `DATA_CONFIG` |

### Runner contract

`secondbrain warehouse run <name> [-- args]` runs one connector now; `secondbrain warehouse run --due` runs every enabled connector whose schedule is due. The `secondbrain-warehouse-run` timer calls the second every 15 minutes.

**The script gets:**
- its folder as the working directory;
- the server's environment, plus:
  - `DATA_CONNECTOR`, `DATA_RUN_ID`;
  - `DATA_RAW_DIR`, a fresh folder for this run's raw files;
  - `DATA_CONFIG`, the `config` as JSON;
  - `DATA_STATE`, the JSON state the last successful run saved, or `{}`;
- any arguments after `--`, e.g. `secondbrain warehouse run instagram -- --backfill`.

**The script prints JSON lines on stdout:**

| Line | Effect |
|---|---|
| `{"table": "instagram_media", "row": {...}}` | Upsert into `data.instagram_media` on its primary key. Only the columns in the row are written; others keep their values |
| `{"state": {...}}` | Saved with the run and handed back next time |
| `{"log": "..."}` | Kept with the run (last 50); other non-JSON lines count as logs too |

- A row for an undeclared table, an unknown column, or a missing key column fails the run, naming it.
- The script never connects to the database, so it can't write anywhere else.
- Rows are written in batches of 500; every write is an idempotent upsert, so re-running repairs.
- Exit 0 is `ok`. A non-zero exit, a timeout or a refused line is `failed`, with the error and the last 2 KB of stderr. The values of the `env` keys are redacted.
- Runs are recorded in `sources` (`kind = 'warehouse-connector'`) and `ingest_runs`.

Exit codes of `secondbrain warehouse`: 0 ok, 1 error, 2 a connector failed.

## The /warehouse page

| Tab | Shows |
|---|---|
| Overview | Database size, schema `data` size and table count, connectors ok / failing / never run / broken, next due run |
| Tables | Every table in every schema: rows (exact under 200,000, the planner's estimate above, marked `~`), size, and its owner (a connector, or the engine module whose health check names it). A table in schema `data` opens to its columns and latest 20 rows |
| Connectors | Each connector: schedule, tables, missing keys, last 10 runs with rows and errors, the command to run it now. Broken `connector.json` files are listed with their error |
| Jobs | Connector schedules with their next run, and the timers of every enabled module |
| Dashboards | Each `<warehouse.dir>/dashboards/<name>.json`, rendered |

API, behind the login: `GET /api/warehouse/overview`, `/tables`, `/tables/:schema/:table`, `/connectors`, `/jobs`, `/dashboards`, `/dashboards/:name`.

## Dashboards

```json
{
  "title": "Instagram",
  "panels": [
    { "title": "Posts", "chart": "number", "sql": "select count(*) from data.instagram_media" },
    { "title": "Followers", "chart": "line", "sql": "select day, followers_count from data.instagram_account_daily order by day", "x": "day", "y": ["followers_count"] },
    { "title": "Top reels", "chart": "table", "sql": "select caption, views from ..." }
  ]
}
```

- `chart` is `number`, `line`, `bar` or `table`.
- Each panel's SQL runs read-only, capped at 500 rows and 10 s, through the same runner as the Database page.
- A panel with bad SQL shows its error; the others still render.

## Skills

The engine's `skills/` folder has one per move. Each ends by checking its work with `secondbrain warehouse`.

| Skill | Does |
|---|---|
| `warehouse-table` | Writes a migration following the table rules above, dry-runs it, applies it |
| `warehouse-connector` | Reads the API's docs, scaffolds `connector.json` and the script, pages through everything, supports `--backfill`, runs it and checks the rows |
| `warehouse-dashboard` | Writes a dashboard spec from existing tables and checks every query |

## CLI

```sh
secondbrain warehouse migrate [--dry-run]
secondbrain warehouse run <connector> [-- args]
secondbrain warehouse run --due
secondbrain warehouse status
secondbrain warehouse tables [--all]
```

## Not covered yet

- Running a connector from the page.
- A database role per connector. Connectors already can't write outside their declared tables, because only the runner writes.
- Retention of raw files (they're kept until you delete them).
