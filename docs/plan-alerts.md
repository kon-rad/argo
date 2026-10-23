# Plan alerts

A Telegram message when the Claude plan fills up: once per window per threshold, at 60, 80 and 90 percent of the five-hour and the seven-day window, with the three sessions that read the most cache in that window and one line saying which to clear.

## Why

Long sessions re-read their whole history on every call, so the context size, not the number of messages, decides the burn. A few big sessions can fill a window while the rest of the work is small. The alert names them while there is still room to act.

## How it works

- **The percentage is the plan's, not ours.** It reads `plan_usage_snapshots.used_pct` (written from the Claude Code statusline, `five_hour` and `seven_day`). Nothing here computes a plan percent, because the weight of each token type against the plan is not published.
- **Newest reading per window**, across every machine that reports one, and only while the window has not reset (`resets_at` in the future). A reading without `resets_at` is skipped: without it two windows cannot be told apart.
- **One alert per crossing.** Table `plan_alerts` has a primary key of (window, threshold, resets_at). A crossing is claimed by inserting its row; only the run that inserts sends. When `resets_at` moves, the window is a new one and alerts again. A dip below a threshold and back inside the same window is the same crossing.
- **A jump** from 50 to 92 percent sends one message (for 90) and records 60 and 80 as done, so one reading never produces three messages.
- **A failed send gives the claim back**, so the next run tries again.
- **The top three** come from the `usage_facts` view: sessions grouped by host and session id, ordered by `cache_read` summed over the window (`resets_at` minus 5 hours or 7 days, up to now). The message shows tokens, the share of the window's total, the number of calls, and where it ran (machine, bot and card, model).
- **"Clear this one"** names the biggest session: for an interactive session, write its Resume block and `/clear`; for an unattended bot or lane run, shorten its context or split the card.

## Where it runs

The droplet holds the readings from every machine (the Mac pushes its own), so only the droplet alerts. `cli-usage-sync` runs every 5 minutes there and calls the check after the sync. It sends through the Hermes bot to its home channel, the same way the livestream and social timers do, and reads only the bot token and home channel from the Hermes env file.

Turn it off without a deploy by setting `PLAN_ALERTS=off` in the service environment.

## Commands

```
secondbrain plan-alert --dry-run   # print the plan readings and the message(s) that would be sent; claims nothing, sends nothing
secondbrain plan-alert             # check now and send what is due
```

Example dry-run output shape:

```
five_hour: 83% used, resets 2026-10-22T14:00:00.000Z, read 2026-10-22T11:59:00.000Z

--- would send (five_hour, crossed 60, 80) ---
Claude plan: the five-hour window is at 83% (crossed 80%). It resets 2026-10-22 14:00 UTC.

Top sessions by cache reads in this window:
1. 3f2a9c1d: 400M (40%) over 310 calls; mac, claude-opus-5-5
...
Clear this one: 3f2a9c1d on mac. Write its Resume block, then /clear.
```

(The example is seeded test data, not a real reading.)

## Schema

Migration `1756000014700_plan-alerts.sql`:

```sql
CREATE TABLE plan_alerts (
  "window"    text        NOT NULL CHECK ("window" IN ('five_hour', 'seven_day')),
  threshold   smallint    NOT NULL CHECK (threshold BETWEEN 1 AND 100),
  resets_at   timestamptz NOT NULL,
  used_pct    real        NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("window", threshold, resets_at)
);
```

## Tests

`server/test/plan-alert.test.ts` seeds plan readings and calls (no production data) and covers: nothing below 60; one message per threshold; no repeat for the same crossing or after a dip; one message for a jump; a new window alerts again; the two windows are independent; resets and missing `resets_at` are ignored; newest reading across hosts; top three inside the window only; a failed send is retried; the dry run claims nothing.

## Thresholds

60, 80 and 90 are constants (`PLAN_ALERT_THRESHOLDS` in `server/src/usage/planAlert.ts`). Changing them needs no migration.
