---
name: livestream-x
description: Register the owner's X (Twitter) live broadcast so its viewers and hours are tracked by the app's `livestream` module. Use whenever the owner sends a link containing x.com/i/broadcasts/ or twitter.com/i/broadcasts/ (often as a reply to the "You're live on ... paste the broadcast link" ping), or says "track this X stream", "here's the X link", or "I'm live on X".
---

# Livestream X link

X live broadcasts can't be found without a login, so the owner pastes the link and this skill registers it. Once a broadcast is registered, the livestream timer on the server reads it every minute (viewers, start, end) from X's public broadcast endpoint until X marks it ended. A link sent after the stream ended still logs that stream's hours.

## Steps

1. Take the link (or the bare id after `/i/broadcasts/`) from the owner's message. Don't ask them to confirm it.
2. Register it. On the server, as the app user, from the app directory:

   ```bash
   cd <app dir> && set -a && . /etc/secondbrain/env && set +a && \
     node --no-warnings server/dist/cli-livestream.js x '<link>'
   ```

   From another machine, the same command in one ssh call (never loop ssh).

3. Reply in one or two lines with what the command printed, for example: "Tracking your X stream, 12 watching right now."
   - `x: <id> running` or `x: live <id>, N watching`: tracking.
   - `x: <id> not_started, waiting`: registered; tracking starts when the broadcast goes live.
   - `x: <id> ended` / `timed_out`: logged from X's own start and end times.
   - `not an X broadcast link`: say so and ask for the `x.com/i/broadcasts/...` link (a post link `x.com/<user>/status/...` doesn't work; open the post and copy the broadcast link from it).
   - `poll failed: x ...`: X refused the read. The link is still registered and the timer retries every minute; say that.

## Notes

- One link per stream. Re-sending the same link is harmless.
- Viewer counts come from X's `total_watching`; the summary sums X with YouTube, Twitch and Kick (the channels in `secondbrain.json` → `livestream`) and counts the hours of a multistream once.
