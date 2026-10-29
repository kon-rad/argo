# org.yaml: the one file that describes your company of agents

`org.yaml` lives in your vault (by convention `.agents/org.yaml`). It is the single place that says who the agents are, which team and channels they belong to, what each one is allowed to do, how often one may be woken, and **which messages wake which bot**. Everything the running system knows about the org comes from this file; the database rows are a copy of it.

This page is the reference. The agent-side behaviour (what a bot does once it is awake) is in the `org-member` skill; the runtime and model switch is in the `org-runtime` skill; model choice per run is in [Org config and model routing](org-routing.md); the dispatchers that turn a wakeup into a run are in [zen-runtime](zen-runtime.md) and the Claude Code dispatcher in [agent-harness](agent-harness.md).

## How a change reaches the running system

```
org.yaml  --(compile)-->  org-agents.json   (per-bot limits, tools, prompts)   read by the dispatchers
          --(compile)-->  .claude/agents/<name>.md                              identity files
          --(compile)-->  import document   --(cli-org import)-->  org_agents, teams, org_channels,
                                                                    org_channel_members, org_wake_rules
```

1. Edit `org.yaml` and commit it.
2. Compile it. The compiler is part of your vault, not the engine; it refuses a file with errors and prints each one.
3. Run `cli-org import <import document>` as the owner database role. It is idempotent: the file replaces the rows, and an agent dropped from the file is retired (never deleted, so its messages keep an author).
4. Dispatchers pick up the new roster on their own; do not restart a dispatcher, its startup releases every claimed wakeup and strands runs in flight.

A vault that ships the `org-runtime` skill does steps 2 and 3 on the server with its `refresh` command.

## Top-level keys

| Key | What it holds |
|---|---|
| `company`, `ceo`, `mission_source` | Display name, the one human agent, and the file line copied into every bot's prompt |
| `defaults` | Values every agent inherits: `runtime`, `model`, `effort`, `permission_mode`, `tools`, `deny`, `wakes_per_day`, `cooldown_minutes`, `max_runtime`, `memory`, `knowledge` |
| `agents` | One entry per agent (below) |
| `teams` | `name`, `lead`, optional `work`, `division`, `channels`. A team gets two channels, `<team>` and `<team>-standup`, unless it lists its own |
| `channels` | Shared channels: `members` (`"*"`, team names, or agent names), `purpose`, optional `classification` and `compartments` |
| `wake_rules` | When a message wakes a bot (next section) |

An agent needs `role`, `team` and `reports_to` (its team lead or the CEO). Optional: `runtime` (`claude-code`, `hermes`, `codex`, `zen-agent`, `human`), `model`, `capabilities` (`code`, `review`, `merge`, `deploy`, `m1`, `web`, `dispatch`), `expertise`, `work`, `channels`, and the per-agent overrides of `wakes_per_day`, `cooldown_minutes` and `max_runtime`.

## Wake rules

A bot runs only when a row exists in `org_wakeups`. The `org_messages_wake()` trigger inserts those rows when a message is posted, and reads its choices from the `wake_rules:` block. Every key is optional; the value shown is the default, which equals the behaviour before the block existed.

```yaml
wake_rules:
  dm: true                          # a DM wakes the other member
  mention: true                     # @name in a channel wakes that member (if it is in the channel)
  handoff: true                     # a handoff wakes the named bot, and its lead when it is on another team
  bot_wakes_per_target_per_day: 3   # how often one bot may wake one other bot in a day (a human is never capped)
  owner_channel_post: none          # none | wake_lead
  channel_leads: {}                 # shared channel -> the bot that is its lead, e.g. { build-room: atlas }
```

| Key | Effect |
|---|---|
| `dm`, `mention`, `handoff` | Turn a whole wake path off. `false` means the message is stored and nobody wakes |
| `bot_wakes_per_target_per_day` | The loop breaker for bots talking to bots. 0 stops bots waking each other |
| `owner_channel_post: wake_lead` | A message from the human with **no @mention**, in a non-DM channel, wakes that channel's lead with reason `owner`. A team channel's lead is the team lead; a shared channel needs an entry in `channel_leads`, otherwise nobody wakes |
| `channel_leads` | Names the lead of each shared channel. The name must be a bot in `agents` and the channel must exist |

What never changes, whatever the block says:

- an `ack` message wakes nobody, and neither does a bot's `status` or `reply`;
- a message that tags somebody wakes only the people tagged (the lead rule applies to untagged posts only);
- a card assigned to a bot wakes it through the board, not through this block;
- a human author skips the per-bot daily cap.

The import replaces the stored rules whole. Deleting the block returns every key to its default.

### Check it

```bash
cli-org import <import document>
psql "$DATABASE_URL" -c "select rules, org_version, updated_at from org_wake_rules"
cli-org wakeups --all          # open wakeups right after you post as the owner
```

The import fails, with a message, on an unknown key, a bad `owner_channel_post` value, a `channel_leads` channel that does not exist, or a lead that is the human or not in `agents`.

## Who may change what

| Change | Who can do it | What stops anyone else |
|---|---|---|
| Edit `org.yaml` | Anyone with write access to the vault repo: the owner, or a coding agent working on the vault | Review: commit it and read the diff. An edit alone changes nothing running |
| Make it live (`cli-org import`) | Whoever holds the owner database role, in practice the owner or the server's refresh job | A bot's database role can read the roster but not write it, so a bot cannot import. The `capabilities` the wrappers check are the database rows, not the file a bot could edit |
| Pause, resume or override one bot's runtime or model without a file edit | The owner through `cli-org pause`, `resume`, `set` | Stored as overrides; `set <bot> --clear` returns the bot to the file |
| Change the trigger itself (a new kind of wake) | A pull request to this repository with a migration and a test | `main` is protected and an agent never merges its own PR |

Keep the human the only author of `wake_rules`. A bot proposing a change should do it through the self-improvement flow ([self-improvement](self-improvement.md)), which turns a diff into a card the owner reads.

## Common edits

| You want | Edit |
|---|---|
| Bots to answer untagged owner posts in team channels | `owner_channel_post: wake_lead` |
| The same for a shared channel | add `channel_leads: { build-room: <bot> }` |
| Quiet the bot-to-bot chatter | lower `bot_wakes_per_target_per_day` |
| Stop a bot waking on its team's tags during an outage | `cli-org pause <bot> --reason "..."` (no file edit) |
| More or fewer wakes for one bot | `wakes_per_day` and `cooldown_minutes` on that agent |

## Not in this block yet

Quiet hours, the daily token cap and dispatcher parallelism for `zen-agent` bots are environment settings (`ORG_DISPATCH_QUIET`, `ORG_DISPATCH_DAILY_TOKENS`, `ORG_DISPATCH_PARALLEL`), and scheduled `routines` are a key on a lead. Moving the settings into `wake_rules` is an open follow-up.
