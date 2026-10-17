# Documentation

Start with [getting-started.md](getting-started.md) if you want it running. Read [architecture.md](architecture.md) if you want to know how it fits together before you change it.

| Doc | Read it when |
|---|---|
| [getting-started.md](getting-started.md) | You want a vault and the app running on your laptop, from nothing |
| [architecture.md](architecture.md) | You want the big picture: engine vs. vault, the app, the index, the harness, where data flows |
| [vault.md](vault.md) | You want to understand the vault template, `secondbrain-vault`, `AGENTS.md`, skills, and how to update the engine |
| [configuration.md](configuration.md) | You need a setting: every env variable and every `secondbrain.json` key |
| [modules.md](modules.md) | You want an optional feature (tracker, agent board, map, TV, usage, voice, livestream, ring, agents) |
| [agent-harness.md](agent-harness.md) | You run Claude Code or Hermes in the vault and want to know what the guard and the dev-log gate do |
| [deployment.md](deployment.md) | You want the app on a server behind a login |
| [privacy.md](privacy.md) | You want to know how the engine stays free of personal data, and how to keep your fork that way |

Also:

- [`../app/README.md`](../app/README.md): the app's tech stack, search design and invariants.
- [`../addons/tv-kiosk/README.md`](../addons/tv-kiosk/README.md): a Raspberry Pi that shows the app on a TV.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): how to send a change.
- [`../AGENTS.md`](../AGENTS.md): the rules AI coding agents follow when they change this repo.
