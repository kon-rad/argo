---
name: data-dashboard
description: Create or change a dashboard on the data addon's /data page - a JSON file of SQL panels (number, line, bar, table) over the vault's tables in schema "data". Use when the user wants a chart, a KPI, a table view or a dashboard of data already stored (followers over time, MRR per app, top posts), or wants an existing dashboard changed.
---

# data-dashboard

A dashboard is `<data.dir>/dashboards/<name>.json`. The `/data` page lists and renders every one. Each panel is one read-only SQL query, capped at 500 rows and 10 s. Reference: the engine's `docs/data.md#dashboards`.

## Steps

1. **Know the tables.** Run `secondbrain data tables`, and read the migrations in `<data.dir>/migrations/` for column meanings. Only chart data that exists; if it doesn't, use the `data-connector` skill first.
2. **Write each query and run it** before saving, through the Database page or `psql "$SECONDBRAIN_DB_URL"` (read-only). Check the numbers are plausible.
3. **Pick the chart:**

   | Chart | When | The query returns |
   |---|---|---|
   | `number` | One KPI | One row, one column |
   | `line` | A value over time | `x` (a day or time column, ascending) plus one or more `y` columns |
   | `bar` | Comparing categories, or a short series | `x` (category) plus `y` columns |
   | `table` | Lists: top posts, recent orders | Any columns, `LIMIT` it |

4. **Save the file:**

   ```json
   {
     "title": "Instagram",
     "description": "Both accounts, from the instagram connector",
     "panels": [
       { "title": "Posts stored", "chart": "number", "sql": "select count(*) from data.instagram_media where parent_media_id is null" },
       { "title": "Followers", "chart": "line", "sql": "select day, followers_count from data.instagram_account_daily where username = 'konradgnat' order by day", "x": "day", "y": ["followers_count"] }
     ]
   }
   ```

   - Name tables with their schema: `data.<table>`.
   - Order line charts by `x` ascending.
   - Put money in one currency per panel and say which in the title.
5. **Open `/data` → Dashboards** and check that every panel renders. A panel with bad SQL shows its error.

## Rules

- Read-only SQL only (`select` or `with`). It runs in a read-only transaction anyway.
- Don't invent numbers or fill gaps with 0. A missing day is a gap.
- One dashboard per subject (a source or a project), not one giant page.
