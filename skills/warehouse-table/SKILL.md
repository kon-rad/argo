---
name: warehouse-table
description: Create or change a table in the vault's own database schema (schema "data") for the warehouse addon, by writing a numbered SQL migration file and applying it with `secondbrain warehouse migrate`. Use when the user wants to store a new kind of data (an API's records, metrics, a tracker), add a column, or add a snapshot table, or when the warehouse-connector skill needs somewhere to write. Not for engine tables (those are engine migrations).
---

# warehouse-table

The vault owns its tables. They live in Postgres schema `data` and are created only by SQL files in `<warehouse.dir>/migrations/`. `warehouse.dir` is set in `secondbrain.json` (default `warehouse`). Full reference: the engine's `docs/warehouse.md`.

## Steps

1. **Find the folder.** Read `secondbrain.json` for `warehouse.dir`, then list `<warehouse.dir>/migrations/`. The new file is the next number: `NNNN_<slug>.sql`, four digits, kebab or snake slug.
2. **Check what exists.** Run `secondbrain warehouse tables`, and read the previous migrations, so you extend rather than duplicate. **Never edit an applied file;** the runner refuses it. A change is a new file (`ALTER TABLE ...`).
3. **Shape the data from the source, not from a guess.** If the data comes from an API, read the API's reference for the exact fields and types first.
4. **Write the SQL.** Plain names with no schema prefix (the runner sets `search_path = data`). Follow the rules below.
5. **Dry run:** `secondbrain warehouse migrate --dry-run` lists the file as pending, or names the problem.
6. **Apply:** `secondbrain warehouse migrate`. Then `secondbrain warehouse tables` shows the new table with 0 rows.

## Table rules

| Rule | Why |
|---|---|
| Every table has a **primary key** that identifies a record in the source (an API id, or id + day) | Connectors upsert on it; without one the runner refuses to write |
| **Entities** (a post, an order, a customer) get one row each, updated in place: `<source>_<things>` | One current row per thing |
| **Numbers that change** (likes, MRR, followers) also get a snapshot table: `<source>_<things>_daily`, keyed by id + `day date` | History you can chart; the entity row only holds the latest |
| Use typed columns: `bigint` for counts, `numeric` for money plus a `currency text` column, `timestamptz` for times (UTC), `date` for days, `text` for ids, even numeric-looking ones | Queries and dashboards stay simple; ids don't lose digits |
| `NULL` means the source didn't say. Never default a metric to 0 | A 0 is a claim |
| Add `extra jsonb` only for fields you don't model yet | Keeps everything without guessing types |
| Add `updated_at timestamptz NOT NULL DEFAULT now()` on entity tables | Shows freshness |
| Index what dashboards filter on (owner/account + time) | |
| Comment the file: the source, the endpoint, and what each table holds | The next agent reads it |

## Not allowed

The runner refuses any of these before anything runs:
- anything outside schema `data`: `public.`, other schemas, `CREATE`/`DROP SCHEMA`;
- roles, `GRANT`, `SET search_path` or `SET role`, `CREATE EXTENSION`.

Deleting data is a deliberate migration (`DELETE FROM ... WHERE ...` with a comment saying why), never a side effect.

## Example

```sql
-- 0003_revenuecat.sql: RevenueCat API v2, one row per app per day from /metrics/overview.
CREATE TABLE revenuecat_overview_daily (
  project_id   text        NOT NULL,
  app          text        NOT NULL,   -- e.g. imagym, manifestly
  day          date        NOT NULL,   -- UTC day of the reading
  mrr          numeric,
  currency     text,
  active_subscriptions bigint,
  active_trials        bigint,
  revenue_28d  numeric,
  new_customers_28d bigint,
  extra        jsonb,
  sampled_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, day)
);
```
