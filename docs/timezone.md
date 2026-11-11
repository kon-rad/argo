# Time zone

Status: **settings CLI and metadata API work**. The configured IANA location or UTC is kept in your vault's `secondbrain.json`.

## What it does

The CLI validates and saves the zone while preserving other settings and the file's owner, group and permissions.
The metadata API returns the current validated value on each request, including changes made without a server restart.
The dependent frontend slice applies that value to shared time helpers, Usage charts, credit/subscription readings
and summaries. Session inspection, live/running views, TV and Org consumers follow in later integration slices.

| Setting | Metadata API value |
|---|---|
| `"timezone": "<Area/City>"` or `"UTC"` in `secondbrain.json` | That configured zone |
| Not set (the default), or not a valid zone | `null`, for browser-zone fallback in frontend consumers |

The server's own zone is never used: it says where the machine is, not where you are. Travel is never inferred.
The frontend integration shows the chosen zone and its source (`vault setting` or `this browser`).

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
so no server restart is needed.

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
The dependent frontend integration consumes this field and falls back to the browser's zone for `null`.
