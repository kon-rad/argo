# Connect Telegram

Talk to your agents from your phone. A Telegram bot is a chat that one of your agents answers: you send "research X" or "what is on the board?", the agent works in your vault under the same rules and guard as at your desk, and replies in the chat. This page creates a bot, connects it to Claude Code or Hermes, and checks it end to end.

You need a vault with an agent already connected ([Claude Code](03-claude-code.md) or [Hermes](04-hermes.md)), and a machine that stays on, usually the server from [Connect servers and computers](06-connect-machines.md). A laptop works for a trial, but the bot goes quiet when the laptop sleeps.

## How it fits together

| Piece | What it is |
|---|---|
| The bot | An account Telegram creates for you through BotFather. It has a **token** (a secret) and a username |
| The poller | One agent process that holds the token and listens for messages. **A token has exactly one poller**: two processes on one bot break both |
| The allowlist | The Telegram user IDs the agent will answer. Anyone else who finds the bot is ignored |
| The agent | Claude Code (through its Telegram channel plugin) or Hermes (through its gateway), running in your vault |

**Use one bot per agent.** If you run both Claude Code and Hermes on Telegram, create two bots. Switching one token between agents is how you end up with two pollers. Hermes is also the one that delivers scheduled jobs (a morning brief, a daily draft), so give it a bot that stays on Hermes.

## 1. Create the bot

1. In Telegram, open a chat with `@BotFather` and send `/newbot`.
2. Give it a display name, then a username that ends in `bot`.
3. BotFather replies with the token. It looks like `123456789:AA...`. **Treat it like a password.** Do not paste it into a note, a commit, or a chat with an agent.
4. Optional but sensible: send `/setprivacy` to BotFather and keep privacy on, and `/setjoingroups` to disable if you only want private chats.

If a token leaks, send `/revoke` to BotFather and use the new one.

## 2. Find your Telegram user ID

Send any message to `@userinfobot`. It replies with your numeric ID. In a private chat the chat ID equals your user ID, so this one number is also where the bot sends messages to you.

## 3. Connect it to an agent

Pick the agent you want on this bot. The token goes in a file on the machine that runs the agent, never in the vault's tracked files.

### Option A: Claude Code

Claude Code reads Telegram through a channel plugin, so a message in the chat arrives in a live Claude Code session started in your vault.

1. Install the plugin from the official marketplace (`telegram` in `claude-plugins-official`) with Claude Code's `/plugin` command.
2. Store the token and the allowlist where the plugin looks:

```bash
mkdir -p ~/.claude/channels/telegram && chmod 700 ~/.claude/channels/telegram
printf 'TELEGRAM_BOT_TOKEN=%s\n' 'PASTE_TOKEN_HERE' > ~/.claude/channels/telegram/.env
printf '{ "allowFrom": ["YOUR_USER_ID"] }\n' > ~/.claude/channels/telegram/access.json
chmod 600 ~/.claude/channels/telegram/.env ~/.claude/channels/telegram/access.json
```

3. Start Claude Code in the vault with the channel on:

```bash
cd /path/to/vault
claude --channels plugin:telegram@claude-plugins-official
```

Send the bot a message. It should answer in the chat.

**Keeping it running.** A terminal you close ends the bot. On a server, run it in a `tmux` session under a systemd unit so it survives reboots and restarts when it fails. A template (replace `<user>` and `/path/to/vault`):

```ini
[Unit]
Description=Claude Code on Telegram, in the vault
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=<user>
WorkingDirectory=/path/to/vault
Environment=HOME=/home/<user>
Environment=PATH=/home/<user>/.bun/bin:/home/<user>/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStartPre=/bin/sleep 8
ExecStart=/usr/bin/tmux -L tg new-session -d -s tg -x 160 -y 50 -c /path/to/vault "claude --channels plugin:telegram@claude-plugins-official"
ExecStop=/usr/bin/tmux -L tg kill-session -t tg
Restart=on-failure
RestartSec=60
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp claude-telegram.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now claude-telegram
sudo -iu <user> tmux -L tg attach -t tg      # look inside; detach with Ctrl-b d
```

Three details in that template are there on purpose:

- **Its own tmux socket (`-L tg`).** A shared tmux server would live in another unit's cgroup, and systemd would see this unit as exited.
- **The `sleep 8`.** On a quick restart the new session can start while the old plugin is still exiting, and the new one is left without the Telegram connection. Eight seconds apart is enough.
- **No one at the keyboard.** A session started by systemd cannot answer permission prompts. Either run it in a permission mode that does not ask, and then back it with deny rules (no `sudo`, no reading `.env` or credentials files) in a settings file passed with `--settings`, or accept that it will stall on the first prompt. The vault's guard hook still applies in every mode, and the deny rules keep holding when prompts are off. Choose this knowingly: a bot that does not ask can run anything those rules allow, for whoever is on the allowlist.

**Known problem: the plugin sometimes does not start.** Some Claude Code versions start the session but never launch the Telegram plugin's process, and then no message arrives. If `/mcp` in the session shows the telegram plugin as failed, that is this. Two fixes: pin the Claude Code version that works (`DISABLE_AUTOUPDATER=1` and the versioned binary path in `ExecStart`), and add an `ExecStartPost` check that waits up to a minute for the plugin's process and exits non-zero if it never appears, so `Restart=on-failure` tries again:

```bash
#!/usr/bin/env bash
# ExecStartPost: fail the start if the Telegram plugin's process (bun) never appears.
for _ in $(seq 1 30); do
  pgrep -u "$USER" -f 'bun server.ts' >/dev/null && exit 0
  sleep 2
done
echo "telegram plugin did not start within 60 s" >&2
exit 1
```

### Option B: Hermes

Hermes talks to Telegram through its gateway, which is also what delivers scheduled jobs.

1. Put the token in Hermes's env file, `~/.hermes/.env`: `TELEGRAM_BOT_TOKEN=...`
2. Enable the platform in `~/.hermes/config.yaml`:

```yaml
gateway:
  platforms:
    telegram:
      enabled: true
```

3. Set the allowed users to your Telegram ID using Hermes's own Telegram setup instructions, then restart the gateway.

Hermes also takes a `platform_toolsets.telegram` list in its config. That list is the set of tools the agent may use when the message came from Telegram, so keep it smaller than your desk session's list. Run Hermes from the vault so it finds `AGENTS.md` and the guard ([Connect Hermes](04-hermes.md)).

Check the exact key names against your Hermes version; they have moved between releases.

### Option C: zen-agent (the cheap one)

The [telegram-bridge add-on](https://github.com/kon-rad/argo/blob/main/addons/telegram-bridge/README.md) is a small Python process that answers each message with one `zen-agent run` on the cheap model in your `zen.json`. Use it for everyday questions, board work and notes from your phone, and keep the Claude Code bot for work that needs Claude. It needs its own bot (a third one if you run both of the others), a token file outside the vault, and the allowlist:

```bash
mkdir -p ~/.zen && cp .secondbrain/addons/telegram-bridge/env.example ~/.zen/telegram-bridge.env
chmod 600 ~/.zen/telegram-bridge.env     # then fill in the token, your user ID and the vault path
set -a; . ~/.zen/telegram-bridge.env; set +a; python3 .secondbrain/addons/telegram-bridge/bridge.py
```

It prints `bridge: up as @yourbot` when the token is good. The add-on's README has the systemd unit, the cost limits (`BRIDGE_MAX_TURNS`, `BRIDGE_MAX_TOKENS`, a fresh session every 20 messages) and the commands `/new` and `/status`. It refuses to start with an empty allowlist.

## 4. Check it

Run these in order. The first that fails is the problem.

| Check | How | Pass |
|---|---|---|
| The token is valid | `set -a; . ~/.claude/channels/telegram/.env; set +a; curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" \| jq .ok` | `true` |
| One poller per token | Only one agent unit uses this token. Compare the tokens of your Claude Code bot and your Hermes bot | They differ |
| The service is up | `systemctl is-active claude-telegram` | `active` |
| The plugin is running | `pgrep -f 'bun server.ts'` | A process ID |
| It answers you | Send the bot `hello` from the account in `allowFrom` | A reply in the chat |
| It ignores strangers | Message the bot from a second Telegram account | No reply |
| The guard holds | Ask it to `cat .env` | A block whose reason starts with `guard:` |

The `getMe` line sources the token without printing it. Do not drop the `jq .ok`: the full reply is harmless, but a habit of echoing the URL is not.

## 5. Add, change and remove a connection

| To | Do |
|---|---|
| Allow another person | Add their ID to `allowFrom` in `access.json`, or Hermes's allowed-users setting. Restart the agent. Anyone on the list can run your agent, so keep it to people you would give your terminal |
| Replace a leaked token | `/revoke` in BotFather, put the new token in the same file, restart the agent |
| Move a bot to another agent | Stop the old poller first, then start the new one. Never run both |
| Pause the bot | `sudo systemctl disable --now claude-telegram` (Hermes: stop the gateway). Messages sent meanwhile wait on Telegram's side for a short time, then are dropped |
| Remove it | Disable the unit, delete the token file, and delete the bot with `/deletebot` in BotFather |

## 6. Make requests show up on your board

If you use the [kanban board](../board-design.md), have the Telegram agent file a card for every request before it starts work, so the request shows on the board and a lost session can be resumed from the card. That is a skill in your vault's `.agents/skills/` plus one line in `AGENTS.local.md`: "Every request sent on Telegram gets a card on the board before the work starts." Give every card an assignee; an unassigned card is invisible work.

## 7. Get a ping when an agent needs you

A bot can also message you first. A server script that posts to Telegram's `sendMessage` method with the bot's token and your user ID as `chat_id` is enough for approvals and failures, and it needs no running poller because it only sends. The engine's `app/deploy/org-notify.sh` does this using the Claude Code bot's token and the first ID in `allowFrom`. Keep messages under about 3,500 characters (Telegram's limit is 4,096).

## Security notes

- The allowlist is the only thing between the internet and an agent with shell access to your vault. Keep it short.
- Token and allowlist files are `chmod 600`, outside the vault, and denied to the agent's file tools (`Read(**/.env)`, and the channel folder in your deny rules) so a prompt injection cannot make the agent read them.
- Everything an agent writes into a chat is stored by Telegram. Do not ask a Telegram-connected agent to print secrets or private journal text. Read [Privacy](07-privacy.md) for where each kind of data goes.
- Telegram cloud chats are not end-to-end encrypted, bots included.
- Anything you paste into a note, a dev log or a commit message must pass the leak check; real chat IDs are one of the things `scripts/check-public.sh` looks for.

## What this page does not cover

- A bot per agent persona. One bot with one agent is the supported shape; routing one chat to several agents is your own work.
- Group chats. The setup above assumes private chats with an allowlist.
- A Telegram transport for the standalone [zen-agent](../zen-agent.md). It has none; a bridge that calls `zen-agent run` per message is a later add-on.

Next: [Privacy](07-privacy.md) for what leaves your machine, or back to the [onboarding overview](README.md).
