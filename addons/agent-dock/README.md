# Agent Dock

A small macOS app, and the CLI under it, for talking to your org's agents in a terminal. Click an agent, pick a harness, and a terminal window opens with that agent's persona loaded. A second view shows which agents, harnesses, models and board cards are running on this machine, with history.

| | |
|---|---|
| Runs on | macOS 14 or later for the app and for `launch`. The rest of the CLI (`run`, `ps`, `history`, `roster`) also runs on Linux |
| Needs | A vault with a compiled roster (`secondbrain org compile` writes `.agents/org/org-agents.json`), Python 3.9+, and at least one of `claude`, `codex`, `hermes` |
| Build | Xcode or its command line tools (`swift build`). No other dependency |
| Talks to | Nothing over the network, apart from an Ollama server on this machine if there is one |
| Stores | An append-only run log in `~/.local/state/secondbrain/agent-dock/` |

## What it does

- **Agents.** One card per agent in the roster, grouped by team, leads first: avatar, name, role, team, and one button per harness. A harness with more than one model to offer has an arrow beside its button: the button starts the default, the arrow lists every provider and model. A harness that is not installed is greyed out. Clicking the avatar uses the first installed harness. A green dot marks an agent that is running here now.
- **Running.** Every agent process on this machine: the ones opened here, and any `claude`, `codex`, `hermes` or `zen-agent` started elsewhere (a card runner, a dispatcher, your own terminal). Each row has the agent, harness, mode (interactive, headless or service), provider, model, board card and folder. Models an Ollama server holds in memory are listed underneath.
- **History.** Past runs, newest first, with how long each took. Search by agent, model or card.

The app holds no rules of its own. Everything it shows is the JSON that `agent-dock --json` prints, so the CLI is the whole feature and the app is a window on it.

## What an agent is started with

All three harnesses get the same agent: the persona file the roster names (`prompt_file`), and a short note that this is a live chat with the owner and not a card wake.

| Harness | Command | Persona reaches it as |
|---|---|---|
| Claude Code | `claude --agent <name> -n <name> --model <model>` | The agent file in `.claude/agents/`; any other persona file goes in `--append-system-prompt` |
| Codex | `codex --cd <vault> --model <model> "<persona>"` | The opening message, without the Claude Code frontmatter |
| Hermes | `hermes chat -m <model> --provider <provider> --base-url <url> -q "<persona>"` | The opening message. See "Hermes: provider and model" below |

The model is, in order: `--model` on the command line, the roster's model when the roster runs that agent on the same harness, then the setting. A roster model for another harness is never passed on (a Codex model name would stop Claude Code from starting).

The agent runs in the vault folder, through your login shell, so it sees the same `PATH`, keys, hooks and permission rules as one you type by hand. Agent Dock adds no permissions and removes none.

## Where the terminal opens

With Ghostty, a click opens a **new tab in the front window** (a window when none is open), through Ghostty's AppleScript commands. The first click makes macOS ask whether Agent Dock may control Ghostty; without that, nothing opens and the app says so (System Settings > Privacy & Security > Automation). Set `"open": "window"` for a window per agent. Terminal.app always gets a new window.

## Hermes: provider and model

The Hermes menu is built from two places:

- **Local (Ollama).** Every chat model the Ollama server on this machine has on disk, largest first, read live from its `/api/tags`. Embedding models are left out. Nothing to configure: pull a model and it appears.
- **API key** and **Subscription.** The entries you list under `runtimes.hermes.choices`, each with the `auth` it uses.

`"provider": "ollama"` is this tool's name for a local Ollama server; Hermes is started with `--provider custom --base-url http://127.0.0.1:11434/v1` (or `$OLLAMA_HOST`, or the setting's `baseUrl` to use another machine's server).

**A choice names a provider and a model, never a key.** Keys and logins stay where Hermes keeps them (`hermes auth add`, a provider login, or its environment), so no secret passes through this tool, its settings, its run log or a process list. `auth` only says which kind a choice relies on, so the menu can group it.

The same `choices` list works for Claude Code and Codex when you want a model menu there.

## Build the app

```bash
cd addons/agent-dock/app
./build.sh --vault ~/path/to/vault            # writes build/AgentDock.app
./build.sh --vault ~/path/to/vault --icon ~/logo.png --install   # your own Dock icon, copied to /Applications
```

`--vault` only sets the default; **File > Choose Vault** changes it later. Drag the app to the Dock to keep it there. The build is signed ad hoc for this machine, so build it on each Mac instead of copying the bundle.

## Use the CLI

```bash
agent-dock roster                          # agents, teams, which harnesses are installed
agent-dock launch ada --runtime codex      # open a terminal tab (Ghostty, else a Terminal window)
agent-dock launch ada --runtime hermes --provider ollama --model example-model:7b
agent-dock run ada --runtime claude        # run in this terminal, and record the run
agent-dock run ada --card t_0123abcd       # note the board card the chat is about
agent-dock ps                              # what is running here now
agent-dock history                         # past runs
```

Every command takes `--json`. The vault comes from `--vault`, then `SECONDBRAIN_VAULT`, then the folder you are in. To have `agent-dock` on your `PATH`, link `addons/agent-dock/bin/agent-dock` into a folder that is on it.

## Settings

Optional, in the vault's `secondbrain.json`:

```json
{
  "agentDock": {
    "terminal": "auto",
    "open": "tab",
    "runtimes": {
      "claude": { "model": "sonnet" },
      "hermes": {
        "provider": "ollama",
        "model": "example-model:7b",
        "choices": [
          { "label": "Cloud, fast", "provider": "example-provider", "model": "example-model-1", "auth": "api-key" },
          { "label": "Plan model", "provider": "example-login", "model": "example-model-2", "auth": "subscription" }
        ]
      }
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `terminal` | `auto` | `ghostty`, `terminal` (Terminal.app) or `auto`: Ghostty when it is installed |
| `open` | `tab` | `tab` or `window`, for Ghostty |
| `roster` | `.agents/org/org-agents.json` | The compiled roster, relative to the vault |
| `runtimes.<id>.command` | `claude`, `codex`, `hermes` | The executable, a name on `PATH` or a full path |
| `runtimes.<id>.model` | `sonnet` for Claude Code, empty otherwise | Empty leaves the harness on its own default |
| `runtimes.hermes.provider`, `baseUrl` | empty | The default provider and its endpoint. `ollama` means a local Ollama server. Empty leaves Hermes on its own default |
| `runtimes.<id>.choices` | none | Extra menu entries: `label`, `provider`, `model`, optional `baseUrl`, and `auth` (`api-key` or `subscription`) |

## Where history comes from

The run log has two kinds of rows. A run opened through `agent-dock run` (which is what the app's buttons do) is recorded exactly: start, end and exit code. A run started some other way is recorded only while the app is open, or when `agent-dock ps --record` runs: it is noted when first seen and closed when its process is gone, so its end time is accurate to the refresh interval (5 seconds in the app) and it has no exit code.

This log is local to one machine and holds no tokens or costs. The app's `/usage` page is the ledger for those, across machines.

For a process it did not start, the agent's name is read from `--agent` or `--persona`, or from a persona's "You are **name**" line in the command; a session with none of these shows as having no persona. The board card is the first `t_xxxxxxxx` id in the working folder or the command.

## Tests

```bash
python3 -m pytest addons/agent-dock        # the CLI: 24 tests, no network, fake runtimes
cd addons/agent-dock/app && swift build    # the app compiles
build/AgentDock.app/Contents/MacOS/AgentDock --snapshot /tmp/dock   # draws each view to a PNG and quits
```

`--snapshot` lets a build be checked without screen recording permission: the app draws its own window.

## Not in it

- No resume button. Use the harness's own (`claude --resume`, `codex resume`, `hermes chat --continue`).
- No remote machines. It shows and starts what is on this Mac.
- It does not change what an agent may do; that stays with the harness's settings and the vault's guard hook.
