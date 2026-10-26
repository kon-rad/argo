# Telegram bridge for zen-agent

A Telegram bot that answers through [zen-agent](../../zen-agent/README.md). Each message is one `zen-agent run`, on the cheap model in your `zen.json`, so a chat from your phone costs a few thousand tokens instead of a Claude Code session's context. It is the third way to put an agent on Telegram, next to the Claude Code channel plugin and the Hermes gateway ([Connect Telegram](../../docs/onboarding/11-telegram.md)).

| | |
|---|---|
| Runs on | Any machine with zen-agent, Python 3.9+ and the vault. One process, no dependencies |
| Talks to | Telegram's long-polling API (outbound HTTPS only, no open port, no webhook) |
| Answers | Only the numeric user IDs in `TELEGRAM_ALLOWED_USERS`, in private chats. Everyone else gets no reply at all |
| Costs | One zen-agent run per message, capped by `BRIDGE_MAX_TURNS` and `BRIDGE_MAX_TOKENS`. The answer ends with its token count |

## What it does

- **A conversation per chat.** The first message starts a session; the next ones `--resume` it, so the agent remembers the thread. `/new` starts over, and a session also restarts by itself after `BRIDGE_MAX_RUNS` messages (default 20), because a resumed session is replayed on every run and long ones cost more than they help.
- **Commands.** `/new`, `/status` (session, runs, what the last run cost), `/help`. Everything else goes to the agent.
- **The message is never an argument.** It goes to zen-agent on stdin, so text that starts with `-` cannot be read as a flag.
- **Failures are told, not hidden.** A timeout, a budget stop or a crash comes back as a short message in the chat.
- **Restart-safe.** The polling offset is saved before a message is handled, so a message that crashes a run is skipped, not replayed forever.

## Where it shows up

Every run is a zen-agent session in the vault's `.zen/sessions`, so `secondbrain usage-sync` (every five minutes on a server) puts it on the `/usage` page with the rest: tokens, cost in dollars, model, the session viewer with the full text of each message and answer. The bridge labels each run `work_type=telegram` and gives it a `telegram` wake reason whose ref is the Telegram message id, so you can filter the page to Telegram. The chat ID and the message text are never in the labels.

## Set it up

1. **Create the bot** with `@BotFather` (`/newbot`) and note the token. This must be a bot no other process polls. Find your user ID with `@userinfobot`.
2. **Write the settings** to a file outside the vault, readable only by you:

   ```bash
   mkdir -p ~/.zen && cp addons/telegram-bridge/env.example ~/.zen/telegram-bridge.env
   chmod 600 ~/.zen/telegram-bridge.env
   $EDITOR ~/.zen/telegram-bridge.env     # token, your user ID, vault path, persona
   ```

3. **Check zen-agent works** from the vault: `cd /path/to/vault && echo "say hi" | zen-agent run --json --quiet` prints one JSON object with a `text` field.
4. **Try it in a terminal**, then install the service:

   ```bash
   set -a; . ~/.zen/telegram-bridge.env; set +a; python3 addons/telegram-bridge/bridge.py   # Ctrl-C to stop
   sed -e 's#<user>#YOU#g' -e 's#/path/to/vault#/your/vault#g' addons/telegram-bridge/telegram-bridge.service \
     | sudo tee /etc/systemd/system/telegram-bridge.service >/dev/null
   sudo systemctl daemon-reload && sudo systemctl enable --now telegram-bridge
   journalctl -u telegram-bridge -f
   ```

   It prints `bridge: up as @yourbot` when the token is good. With no token or no allowlist it exits with code 2 and says which.

## Security

The allowlist is the only gate between the internet and an agent with the tools in `ZEN_TOOLS`. Keep it to your own ID, and keep `ZEN_TOOLS` narrower than at your desk (no `shell` unless you want it). The vault guard runs on every tool call inside zen-agent. The token lives only in the env file; the bridge never prints it, and its errors name the failure class, not the URL. Telegram cloud chats are not end-to-end encrypted: do not ask the bot to print secrets.

## Not covered

Groups, several bots in one process, voice and photos (text only), and streaming partial answers. Each message is one answer.

## Tests

`python3 -m pytest addons/telegram-bridge` runs 12 tests with no network and no zen-agent: the allowlist, the stdin hand-off, session resume and rollover, commands, failure messages, chunking, offset-before-handle, and that the token never reaches an error.
