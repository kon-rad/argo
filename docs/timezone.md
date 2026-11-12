# Time zone

Status: **shared helpers, Usage and session inspection, Running/Live, Org, and TV work**. The configured IANA location or UTC is kept in your vault's `secondbrain.json`.

## What it does

The CLI validates and saves the zone while preserving other settings and the file's owner, group and permissions.
The metadata API returns the current validated value on each request, including changes made without a server restart.
Shared frontend time helpers, Usage charts, credit/subscription dates and observation times, subscription resets
and summaries consume that value. The session list and session detail use the same effective zone for Started
timestamps: `YYYYMMDD HH:mm` on a 24-hour clock. Duration is elapsed time from the first to the last recorded
step, not time spent working. Context occupancy and capacity remain separate recorded values; missing values are
shown as `?` on either side, or `-` when neither was recorded.
Org message tooltips and board-token Made and Last seen values use the shared zone; token values include seconds and
an absent Last seen remains `never`. TV uses it for the selected episode and episode-strip generated labels. These
mounted views update when their cached metadata is refetched, including a cleared setting falling back to the browser.
The Usage live view formats its Updated time in the shared zone. The legacy Running view does the same for its read
time and includes a zoned, second-precision start time in each running-duration tooltip. Both mounted views update
when their cached metadata is refetched, including a cleared setting falling back to the browser.

| Setting | Metadata API value |
|---|---|
| `"timezone": "<Area/City>"` or `"UTC"` in `secondbrain.json` | That configured zone |
| Not set (the default), or not a valid zone | `null`, for browser-zone fallback in frontend consumers |

The server's own zone is never used: it says where the machine is, not where you are. Travel is never inferred.
The Usage ledger shows the chosen zone and its source (`vault setting` or `this browser`).
Usage charts bucket hours and days in that zone. When the effective zone changes after initial metadata loading,
the selected bucket is recalculated and its old session interval is cleared. An initial bookmarked session range
is preserved. See [Usage configuration](configuration.md#usage-page-providers-and-sections) for session filters.

## Change it

```sh
secondbrain timezone                         # show it
secondbrain timezone set Asia/Singapore      # set it (validated; the file's other keys are kept)
secondbrain timezone clear                   # back to each browser's zone
secondbrain timezone show --json
```

Geographic IANA names (`America/Los_Angeles`, `America/New_York`, `Europe/Berlin`) and `UTC` are accepted.
Abbreviations and fixed-offset aliases (`EST`, `GMT`, `Etc/GMT+5`) are rejected; a geographic zone retains its
daylight saving rules. A refused value changes nothing and exits 2. The metadata API reads the setting on each request,
so no server restart is needed. Reload a page after CLI changes to refresh its cached metadata.

The command writes `secondbrain.json` on the machine it runs on. If your vault syncs between machines, commit and
sync the change as you would any other setting so the server sees it.

### Asking an agent

Tell your agent where you are and it runs the command. For example, flying from Los Angeles to Singapore:

> I'm in Singapore now, switch the app's time zone.

The agent runs `secondbrain timezone set Asia/Singapore` and replies with the line it printed,
`timezone: America/Los_Angeles -> Asia/Singapore`. Put the rule in your vault's `AGENTS.local.md` if you want every
agent to do this when you mention travelling (your own zone belongs in your vault, never in the engine).

## API

`GET /api/meta` returns `timezone`: the validated configured zone, or `null` when it is unset or invalid.
The frontend consumes this field and falls back to the browser's zone for `null`. Credit and subscription readings,
Usage bucketing, and shared helper timestamps use the same chosen zone.
