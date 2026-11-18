---
name: warehouse-connector
description: Build a connector for the warehouse addon that pulls from an API or another source into the vault's tables on a schedule - a folder with connector.json and a script that prints JSON lines, run by `secondbrain warehouse run`. Use when the user wants data from a service (RevenueCat, Instagram, Stripe, an analytics API, a spreadsheet) stored and refreshed, wants a backfill of all history, or wants a source's schedule changed.
---

# warehouse-connector

A connector is a folder `<warehouse.dir>/connectors/<name>/` with a `connector.json` and a script in any language. The script never connects to the database: it prints JSON lines, and the engine's runner validates and upserts them into the tables the connector declares. Full contract: the engine's `docs/warehouse.md#runner-contract`.

## Steps

1. **Read the source's API reference** before writing anything. You need:
   - the auth method;
   - every endpoint you'll call, with its fields;
   - pagination;
   - rate limits;
   - how far back history goes.

   Write down what the API can't give (for example, past daily follower counts), so nobody expects it later.
2. **Tables first.** Use the `warehouse-table` skill: entity tables, plus `_daily` snapshot tables for numbers that change. Apply them.
3. **Keys stay in env.** Put each key's *name* in `env` (e.g. `REVENUECAT_IMAGYM_API_KEY`) and its value in the server's env file. Never write a value into the folder, a row, a log line or a raw file. Strip tokens from URLs before logging.
4. **Write `connector.json`:**

   ```json
   {
     "name": "revenuecat",
     "description": "RevenueCat metrics per app",
     "command": ["node", "run.mjs"],
     "schedule": { "every": "1d", "at": "02:30" },
     "timeoutSec": 900,
     "tables": ["revenuecat_overview_daily"],
     "env": ["REVENUECAT_IMAGYM_API_KEY"],
     "config": { "apps": [{ "app": "imagym", "projectId": "proj...", "keyEnv": "REVENUECAT_IMAGYM_API_KEY" }] }
   }
   ```

   - `schedule.at` is UTC.
   - Per-account or per-app settings go in `config`, which the script reads from `DATA_CONFIG`.
   - Leave out `schedule` for a manual-only connector.
5. **Write the script.** Prefer Node (`run.mjs`, built-in `fetch`, no packages). It must:
   - print one `{"table": "<name>", "row": {...}}` per row, using exact column names and keys always present;
   - page through every page;
   - back off on HTTP 429 and on rate-limit headers, and retry 5xx a few times;
   - accept `--backfill` (passed as `secondbrain warehouse run <name> -- --backfill`) to pull all history; the normal run pulls only recent data;
   - save a cursor with `{"state": {...}}` if incremental pulls need one, and read it from `DATA_STATE`;
   - write raw responses to `DATA_RAW_DIR` only if they'd be worth re-parsing (gzip big ones);
   - print `{"log": "..."}` for progress and anything skipped, such as a metric the API refused;
   - exit non-zero on a real failure. A metric the API won't give is `null` plus a log line, not a failure.
6. **Run it:** `secondbrain warehouse run <name>`. Then check:
   - `secondbrain warehouse status` shows `ok` with row counts;
   - spot-check rows with SQL against what the API's own UI shows.
7. **Backfill** if history is wanted: `secondbrain warehouse run <name> -- --backfill`. Report the counts and the earliest date reached.
8. **Confirm the schedule** on the `/warehouse` page (Connectors and Jobs tabs). Say which keys must be set on the server for the timer runs.

## Script skeleton

```js
const cfg = JSON.parse(process.env.DATA_CONFIG || '{}');
const state = JSON.parse(process.env.DATA_STATE || '{}');
const backfill = process.argv.includes('--backfill');
const emit = (table, row) => console.log(JSON.stringify({ table, row }));
const log = (msg) => console.log(JSON.stringify({ log: msg }));

async function get(url, headers, tries = 4) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && i < tries) { await new Promise((r) => setTimeout(r, 2 ** i * 2000)); continue; }
    throw new Error(`${res.status} ${url.replace(/([?&](access_token|key|token)=)[^&]+/g, '$1[redacted]')}: ${(await res.text()).slice(0, 300)}`);
  }
}
// ... emit rows ...
console.log(JSON.stringify({ state: { ...state, lastRun: new Date().toISOString() } }));
```

## Done means

- The run is `ok`, with the rows counted per table.
- Spot checks match the source.
- Missing keys are named.
- The connector shows on `/warehouse` with its next run.
