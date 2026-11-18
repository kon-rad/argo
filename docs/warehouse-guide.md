# Warehouse guide: connect, run and change data sources

Status: **works** - the `warehouse` addon is live on a production install, with an Instagram connector that backfilled two years of account insights and every post in one run.

This is the hands-on guide. It walks through turning the warehouse on, connecting a first source, every parameter a connector takes, how the warehouse sits inside the engine, and how to add, change, pause and remove sources later. The short reference, with the same rules in table form, is [warehouse.md](warehouse.md).

## What the warehouse is for

You want numbers from services you use (Instagram, RevenueCat, Stripe, an analytics API, a spreadsheet) stored in your own Postgres, refreshed on a schedule, and readable by you and your agents. The warehouse gives you that with three plain files per source, all kept in your vault:

| You write | The engine does |
|---|---|
| A **SQL migration** that creates the tables | Applies it to schema `data`, records it, refuses edits to applied files |
| A **connector**: `connector.json` plus a script in any language that prints JSON lines | Runs it on its schedule, validates every row, upserts it, records the run, redacts keys from errors |
| A **dashboard**: a JSON file of SQL panels | Renders it on the `/warehouse` page, read-only |

Features at a glance:

- **One page for all your data.** `/warehouse` lists every table in the database (engine and yours) with rows, size and owner, every connector with its last ten runs, every scheduled job, your dashboards, and the database's total size.
- **Connectors can't damage anything.** A script never gets a database connection. It prints rows; the engine writes them, only into the tables the connector declared, only into columns that exist.
- **Idempotent by design.** Every write is an upsert on the table's primary key, so running a connector twice, or re-running after a failure, repairs rather than duplicates.
- **Incremental runs.** A connector can save a small JSON state (a cursor, a last-seen date) and gets it back on the next run.
- **Backfills.** Arguments after `--` go to the script, so a connector can offer `--backfill` for full history.
- **Secrets stay out of the vault.** A connector names the env keys it needs, or asks for an engine-managed token; values never sit in its files and are redacted from logs and errors.
- **Agents build it for you.** Three skills (`warehouse-table`, `warehouse-connector`, `warehouse-dashboard`) cover each move, and each ends by checking its own work.

## How it fits into the engine

```
 vault (git)                              server
 ───────────                              ──────
 <warehouse.dir>/                          secondbrain-warehouse-run.timer  (every 15 min)
   migrations/0001_x.sql  ── deploy ──▶       │
   connectors/x/connector.json                ▼
   connectors/x/run.py    ◀── reads ──  secondbrain warehouse run --due
   dashboards/x.json                          │  spawns the script, no shell, no DB access
                                              ▼
                                         script stdout: {"table": ..., "row": {...}}
                                              │  validate table, columns, key
                                              ▼
                                         Postgres: schema data  (your tables)
                                                   sources, ingest_runs  (run history)
                                                   data_migrations  (applied files)
                                              │
                                              ▼
                                         /warehouse page and /api/warehouse/*
```

The pieces, and where each lives:

| Piece | Where | Notes |
|---|---|---|
| Addon manifest | `app/server/src/addons/warehouse/manifest.ts` | Declares the `warehouse` CLI, the timer, the nav entry under Vault, the health check (`data_migrations` answers) and the settings key |
| Settings | `secondbrain.json` → `warehouse` | `dir` and `rawDir`, see [Turn it on](#1-turn-it-on) |
| Your files | `<warehouse.dir>/` in the vault | Reach the server the same way every vault file does, through [vault sync](sync.md). A connector added on your laptop runs on the server after the next sync |
| Tables | Postgres schema `data` | Separate from the engine's tables in `public`, so engine migrations and yours never collide |
| Migration ledger | `data_migrations` | File name and checksum of every applied file |
| Run history | `sources` (`kind = 'warehouse-connector'`) and `ingest_runs` | Status, rows per table, saved state, the last 50 log lines, the error |
| Timer | `secondbrain-warehouse-run` | Installed by the deploy when the addon is on. Calendar `*:0/15`, persistent (catches up after downtime), exit code 2 counts as success so one failing connector doesn't mark the unit failed |
| Deploy step | `app/deploy/deploy.sh` | Runs `secondbrain warehouse migrate` after the engine's own migrations. A failing vault migration is reported and the engine deploy still stands |
| Token store | `social_metric_tokens` | The encrypted, auto-refreshed Instagram tokens from [social metrics](social-metrics.md); a connector can borrow one through `secrets` |
| Page and API | `/warehouse`, `GET /api/warehouse/*` | Behind the login, read-only |

## 1. Turn it on

Add `warehouse` to the addons in your vault's `secondbrain.json`, and optionally say where its folder lives:

```json
{
  "addons": ["warehouse"],
  "warehouse": { "dir": "warehouse" }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `addons` contains `"warehouse"` | off | Turns the addon on: page, CLI, API, timer, deploy step. `MODULES=warehouse` in `.env` means the same |
| `warehouse.dir` | `warehouse` | The folder holding `migrations/`, `connectors/` and `dashboards/`. Vault-relative or absolute. Any folder works, for example `.agents/data` to keep it next to your agent config |
| `warehouse.rawDir` | `<app>/data/warehouse-raw` | Where connectors may keep raw API responses, one folder per run: `<rawDir>/<connector>/<run id>/` |

Then deploy (see [deployment.md](deployment.md)). The deploy installs the timer and applies any migrations already in the folder. Check it:

```sh
secondbrain warehouse status     # database size, schema data size, every connector and its last run
```

Open `/warehouse`: the Overview tab should show the database size and zero connectors.

## 2. Create the tables

Tables come only from SQL files in `<warehouse.dir>/migrations/`, named `NNNN_slug.sql` and applied in name order. Write plain table names; each file runs with `search_path = data`, so `create table revenuecat_subscribers` lands in `data.revenuecat_subscribers`.

```sql
-- warehouse/migrations/0002_revenuecat.sql
create table revenuecat_subscribers (
  app_id        text not null,
  subscriber_id text not null,
  first_seen    timestamptz,
  last_seen     timestamptz,
  entitlements  jsonb,
  primary key (app_id, subscriber_id)
);

create table revenuecat_daily (
  app_id   text not null,
  day      date not null,
  mrr      numeric,
  currency text not null default 'USD',
  active_subscriptions integer,
  primary key (app_id, day)
);
```

```sh
secondbrain warehouse migrate --dry-run   # lists the pending files
secondbrain warehouse migrate             # applies them, each in its own transaction
```

Rules that keep tables useful:

| Rule | Why |
|---|---|
| Every table has a **primary key** | The runner upserts on it. A table without one is refused at the first row |
| Typed columns, `timestamptz` in UTC | Dashboards and agents can compare across sources |
| `NULL` when the source gave no value, never 0 | A zero is a reading; a gap is not |
| `numeric` for money, plus a currency column | No float rounding, no guessing USD vs. anything else |
| A snapshot table keyed by id + day for numbers that change | APIs usually give only today's value; history is what you keep yourself |

What the migration runner enforces:

- **An applied file can't change.** Its checksum is in `data_migrations`; an edited file is refused, by name. Schema history only moves forward, in new files.
- **Everything stays in schema `data`.** A file mentioning `public.`, `pg_catalog.`, `information_schema.`, `CREATE/ALTER/DROP SCHEMA`, roles, `GRANT`/`REVOKE`, `SET search_path` or `SET role`, `CREATE EXTENSION`, or DDL on a schema-qualified name outside `data`, is refused before anything runs. Every pending file is checked first, so one bad file applies nothing. This guards against mistakes; it is not a security boundary.

## 3. Write the connector

A connector is a folder `<warehouse.dir>/connectors/<name>/` with a `connector.json` and a script. The script can be in any language the server has.

### connector.json, every parameter

```json
{
  "name": "revenuecat",
  "description": "RevenueCat subscribers and daily MRR for our iOS apps",
  "command": ["python3", "run.py"],
  "schedule": { "every": "1d", "at": "02:30" },
  "timeoutSec": 1800,
  "tables": ["revenuecat_subscribers", "revenuecat_daily"],
  "env": ["REVENUECAT_API_KEY"],
  "secrets": {},
  "config": { "apps": ["app_abc123", "app_def456"], "pageSize": 1000 },
  "enabled": true
}
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | - | Lowercase letters, digits, `-` and `_`. **Must match the folder name**, or the connector is listed as broken |
| `description` | no | `""` | Shown on the Connectors tab |
| `command` | yes | - | The program and its arguments, as an array. Run in the connector's folder, **without a shell**, so no pipes, globs or `~` |
| `schedule.every` | no | - | A number and a unit: `15m`, `6h`, `1d`, `7d`. Without a `schedule` the connector runs only by hand |
| `schedule.at` | no | - | `HH:MM` in **UTC**. Anchors the slots: with `every: "1d", at: "02:30"` it runs daily at 02:30 UTC |
| `timeoutSec` | no | `900` | The run is sent SIGTERM after this, SIGKILL 5 s later, and recorded as failed |
| `tables` | effectively yes | `[]` | Tables in schema `data` (names without `data.`) this connector may write. A row for any other table fails the run |
| `env` | no | `[]` | Names (never values) of env keys the script needs. The Connectors tab and `status` flag missing ones; their values are redacted from errors and logs |
| `secrets` | no | `{}` | Env names filled from the engine's secret store at run time. Supported today: `"IG_TOKEN": "social-token:instagram:<account>"`, the encrypted Instagram token from [social metrics](social-metrics.md) (needs `SOCIAL_TOKEN_ENC_KEY`). A secret that can't be read fails the run before the script starts |
| `config` | no | `{}` | Any JSON object. The script receives it as `DATA_CONFIG`. Put account lists, API versions and page sizes here, not in the script |
| `enabled` | no | `true` | `false` pauses scheduled runs. You can still run it by hand |

**How schedules decide "due".** Slots are anchored at the start of the UTC day, or at `at` when given: `6h` runs at 00:00, 06:00, 12:00 and 18:00 UTC. A connector is due when it has never run, or hasn't **started** since the most recent slot. The timer checks every 15 minutes, so a run starts up to 15 minutes after its slot. A manual run counts: if you ran it by hand after today's slot, the timer skips it ("no connector is due") until the next slot. Due connectors run one at a time.

### Where keys come from

The script inherits the server's environment, so an `env` key must be in the server's env file (`/etc/secondbrain/env` on a standard install; see [configuration.md](configuration.md)). Add it there (the timer's service reads that file at every start, so nothing needs restarting) and check:

```sh
secondbrain warehouse status     # "missing env REVENUECAT_API_KEY" disappears once it is set
```

For Instagram, store the account's token once with `secondbrain metrics social token instagram <account> < token.txt` (or connect it through the app, see [social metrics](social-metrics.md)) and reference it with `secrets`; the engine keeps it encrypted and refreshes it before it expires, so the connector never handles a 60-day token rotation.

### The runner contract

What the script receives:

| Variable | Holds |
|---|---|
| working directory | The connector's folder |
| everything in the server's environment | Including the `env` keys you listed |
| each `secrets` name | The resolved secret value |
| `DATA_CONNECTOR` | The connector's name |
| `DATA_RUN_ID` | This run's id in `ingest_runs` |
| `DATA_RAW_DIR` | A fresh, empty folder for this run's raw files |
| `DATA_CONFIG` | The `config` object, as JSON |
| `DATA_STATE` | The `state` the last **successful** run saved, as JSON, or `{}` |
| arguments | Whatever followed `--` on the command line, e.g. `--backfill` |

What the script prints on stdout, one JSON object per line:

| Line | Effect |
|---|---|
| `{"table": "revenuecat_daily", "row": {"app_id": "app_abc123", "day": "2026-11-17", "mrr": 412.50, "currency": "USD"}}` | Upsert into `data.revenuecat_daily` on its primary key. **Only the columns present in the row are written**; other columns keep their stored values |
| `{"state": {"cursor": "abc"}}` | Saved with the run if it succeeds, handed back as `DATA_STATE` next time. The last one printed wins |
| `{"log": "page 3 of 12"}` | Kept with the run (the last 50 lines). Any non-JSON line counts as a log too |

Use stderr for anything you don't want parsed; its last 2 KB is attached to a failed run.

How a run ends:

| Outcome | Status | What is kept |
|---|---|---|
| Exit 0, every row valid | `ok` | All rows; the new state |
| A row names an undeclared table, an unknown column, or lacks a key column | `failed`, naming the table or column | Rows validated before it; the **previous** state |
| Non-zero exit | `failed`, with the exit code and stderr tail | Rows already printed; the previous state |
| Timeout | `failed`, "timed out after Ns" | Rows already printed; the previous state |
| A `secrets` entry can't be resolved | `failed` before the script starts | Nothing |

Keeping validated rows on failure is safe because every write is an idempotent upsert: the next run rewrites them. Not advancing the state on failure means the next run starts from the last good cursor.

Writes go in batches of 500. Within a batch, a later row with the same key wins. A JSON object or array value is stored as JSON, so map nested API fields to a `jsonb` column.

### A complete minimal connector

```python
#!/usr/bin/env python3
# warehouse/connectors/revenuecat/run.py
import json, os, sys, urllib.request

def emit(obj):
    print(json.dumps(obj), flush=True)

config = json.loads(os.environ["DATA_CONFIG"])
state = json.loads(os.environ["DATA_STATE"])
key = os.environ["REVENUECAT_API_KEY"]
backfill = "--backfill" in sys.argv[1:]

for app in config["apps"]:
    since = None if backfill else state.get(app)
    url = f"https://api.example.com/v1/apps/{app}/metrics"
    if since:
        url += f"?since={since}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = json.load(r)
    # keep the raw response next to the run, for debugging and re-parsing
    with open(os.path.join(os.environ["DATA_RAW_DIR"], f"{app}.json"), "w") as f:
        json.dump(body, f)
    for d in body["days"]:
        emit({"table": "revenuecat_daily", "row": {
            "app_id": app, "day": d["date"], "mrr": d.get("mrr"),
            "currency": d.get("currency", "USD"),
            "active_subscriptions": d.get("active"),
        }})
        state[app] = d["date"]
    emit({"log": f"{app}: {len(body['days'])} days"})

emit({"state": state})
```

The API URL is a placeholder: point it at the real endpoint. The pattern is what matters: config in, state in, rows out, state out, exit 0.

### Run it

```sh
secondbrain warehouse run revenuecat                 # one run now
secondbrain warehouse run revenuecat -- --backfill   # pass arguments to the script
secondbrain warehouse run --due                      # what the timer does
secondbrain warehouse status                         # last run per connector
secondbrain warehouse tables                         # your tables with rows and size (--all for every schema)
```

`run` prints `revenuecat run 42: ok {"revenuecat_daily":730}`. Exit codes: 0 ok, 1 error (bad usage, unknown connector), 2 a connector failed.

Then check the rows on `/warehouse` → Tables: a table in schema `data` opens to its columns and latest 20 rows, and the Owner column names the connector that declared it.

## 4. Add a dashboard

A dashboard is `<warehouse.dir>/dashboards/<name>.json`:

```json
{
  "title": "Subscriptions",
  "description": "From the revenuecat connector",
  "panels": [
    { "title": "Apps tracked", "chart": "number", "sql": "select count(distinct app_id) from data.revenuecat_daily" },
    { "title": "MRR (USD)", "chart": "line", "sql": "select day, sum(mrr) as mrr from data.revenuecat_daily where currency = 'USD' group by day order by day", "x": "day", "y": ["mrr"] },
    { "title": "Active subscriptions by app", "chart": "bar", "sql": "select app_id, max(active_subscriptions) as active from data.revenuecat_daily group by app_id", "x": "app_id", "y": ["active"] },
    { "title": "Latest days", "chart": "table", "sql": "select * from data.revenuecat_daily order by day desc limit 20" }
  ]
}
```

| Key | Meaning |
|---|---|
| `chart` | `number` (first value of the first row), `line`, `bar` or `table` |
| `sql` | A read-only query; capped at 500 rows and 10 seconds |
| `x`, `y` | For `line` and `bar`: the column for the x axis and the columns to plot |

A panel with bad SQL shows its error and the rest still render. Dashboards appear on the Dashboards tab as soon as the file reaches the server; nothing to deploy.

## 5. Change a source

| You want to | Do this |
|---|---|
| **Change the schedule** | Edit `schedule` in `connector.json`. The next timer check uses it |
| **Pause a source** | Set `"enabled": false`. Scheduled runs stop; `run <name>` still works; tables and history stay |
| **Add an account, app or option** | Edit `config`. The script reads it on the next run. For example, adding a second Instagram account is one entry in `config.accounts` plus one line in `secrets` |
| **Add a column** | Write a new migration, `0003_revenuecat_churn.sql` with `alter table revenuecat_daily add column churned integer;`, run `migrate`, then have the script print the new field. Old rows keep `NULL` until a run rewrites them |
| **Change a column's type or key** | A new migration with the `alter table`. Never edit an applied file; it will be refused |
| **Write to a new table** | Create it in a new migration, then add its name to `tables`. A row for an undeclared table fails the run |
| **Rotate a key** | Replace the value in the server's env file. For an Instagram `secrets` token, run the `token` command again; it replaces the stored one |
| **Re-pull history** | `secondbrain warehouse run <name> -- --backfill` (if the script supports it). Upserts mean existing rows are corrected, not duplicated |
| **Change the script** | Edit it. Keep the output rows' keys the same, or you will create new rows instead of updating old ones |

## 6. Remove a source

Removing a connector and removing its data are separate steps, on purpose.

1. **Stop it running:** set `"enabled": false`, or delete the folder `<warehouse.dir>/connectors/<name>/`. Once the folder is gone the connector leaves the Connectors and Jobs tabs. Its run history stays in `ingest_runs`.
2. **Keep or drop the data.** The tables stay in schema `data` and stay on the Tables tab (with no owner). To drop them, write a new migration:

   ```sql
   -- warehouse/migrations/0007_drop_revenuecat.sql
   drop table if exists revenuecat_daily;
   drop table if exists revenuecat_subscribers;
   ```

   and run `secondbrain warehouse migrate`. Don't delete the earlier migration that created them: applied files are history.
3. **Remove what it used:** its dashboard file, its keys from the server's env file, and its raw files under `<rawDir>/<name>/` (raw files are kept until you delete them).

**Renaming** a connector is a remove and an add: the new name starts a new history and has no saved state, so its first run behaves like a first run. Run it with `--backfill` if the script needs history to start over.

## 7. Let an agent do it

The engine ships three skills in `skills/`. Ask an agent in plain words ("store our RevenueCat data daily", "add a followers chart") and it loads the matching one:

| Skill | Does | Checks itself with |
|---|---|---|
| `warehouse-table` | Writes a migration that follows the table rules, dry-runs it, applies it | `secondbrain warehouse migrate --dry-run`, then `tables` |
| `warehouse-connector` | Reads the API's docs, scaffolds `connector.json` and the script, pages through everything, supports `--backfill`, runs it and checks the rows | `secondbrain warehouse run <name>`, then `status` |
| `warehouse-dashboard` | Writes a dashboard from existing tables and checks every query | Each panel's SQL against the database |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Connector listed as **BROKEN** | Invalid `connector.json`, or `name` doesn't match the folder | The error names the field. Fix the file |
| `table "x" is not in this connector's tables` | The script printed a row for an undeclared table | Add it to `tables`, or fix the table name in the script |
| `table data.x does not exist (run secondbrain warehouse migrate)` | The migration hasn't been applied on this server | `secondbrain warehouse migrate`; check the file reached the server |
| `data.x has no column "y"` | The script prints a field the table lacks | A new migration adding the column, or drop the field from the row |
| `row for data.x is missing key column "k"` | A primary-key value is null or absent | Fix the script; keys are required |
| `has no primary key; upserts need one` | The table was created without one | A new migration adding a primary key |
| A migration refused as changed | An applied file was edited | Revert the file; put the change in a new file |
| A migration refused as reaching outside schema `data` | The file names `public.`, a role, `GRANT`, `SET search_path`... | Use plain table names; keep it to your tables |
| `missing env KEY` on the Connectors tab | The key isn't in the server's env file | Add it there, then run the connector |
| `secret IG_TOKEN (...): no stored token for that account` | No Instagram token stored for that account | Store one with the `token` command, see [social metrics](social-metrics.md) |
| The timer says "no connector is due" | It already ran (by hand or on schedule) since the last slot | Expected. `run <name>` forces a run |
| `timed out after Ns` | The run took longer than `timeoutSec` | Raise `timeoutSec`, or make the script incremental with `state` |

## Limits, today

- Connectors run on the server, from the CLI or the timer. The page doesn't start runs yet.
- `secrets` resolves Instagram tokens only; other services use `env`.
- There is no database role per connector. Connectors already can't write outside their declared tables, because only the runner writes.
- Raw files are kept until you delete them.
- Account- and API-side limits are the source's: if an API can't return past values, the warehouse can only keep history from the day the connector starts.

See also: [warehouse.md](warehouse.md) (reference), [addons.md](addons.md), [configuration.md](configuration.md), [social-metrics.md](social-metrics.md), [deployment.md](deployment.md).
