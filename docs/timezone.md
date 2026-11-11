# Time zone

Status: **works**. One IANA time zone for the whole app, kept in your vault's `secondbrain.json`.

## What it does

The Usage ledger, credit and subscription readings, live/running views, Sessions list and session pages,
summaries, TV and Org pages use the configured zone. Usage charts bucket hours and days by it, so a day bar,
the sessions it opens and their displayed times agree. The Sessions list writes Started as `YYYYMMDD HH:mm`
on a 24-hour clock in this zone.

| Setting | Zone used |
|---|---|
| `"timezone": "<Area/City>"` in `secondbrain.json` | That zone, on every device |
| Not set (the default), or not a valid zone | Each browser's own zone |

The server's own zone is never used: it says where the machine is, not where you are. Travel is never inferred.
The Usage page shows the zone in use and where it came from (`vault setting` or `this browser`).

## Change it

```sh
secondbrain timezone                         # show it
secondbrain timezone set Asia/Singapore      # set it (validated; the file's other keys are kept)
secondbrain timezone clear                   # back to each browser's zone
secondbrain timezone show --json
```

Only IANA names are accepted (`America/Los_Angeles`, `Europe/Berlin`, `UTC`), never offsets or abbreviations, so
daylight saving changes are handled for you. A refused value changes nothing and exits 2. The app reads the setting
on each page load, so no restart is needed; reload the page.

The command writes `secondbrain.json` on the machine it runs on. If your vault syncs between machines, commit and
sync the change as you would any other setting so the server sees it.

### Asking an agent

Tell your agent where you are and it runs the command. For example, flying from Los Angeles to Singapore:

> I'm in Singapore now, switch the app's time zone.

The agent runs `secondbrain timezone set Asia/Singapore` and replies with the line it printed,
`timezone: America/Los_Angeles -> Asia/Singapore`. Put the rule in your vault's `AGENTS.local.md` if you want every
agent to do this when you mention travelling (your own zone belongs in your vault, never in the engine).

## API

`GET /api/meta` returns `timezone`: the configured zone, or `null` when none is set. The web app's `useAppTimezone`
hook (`app/web/src/lib/useTimezone.ts`) reads it and sets the default for the helpers in `app/web/src/lib/time.ts`.
