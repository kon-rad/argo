# secondbrain

**An exocortex you own.** Your notes, your projects, your agents and your body's data in one private place: plain markdown in a git repo you control, an app that searches and maps it, and agents that work inside it under rules you write.

Computing is turning into an exocortex: memory, perception and judgment running partly outside your head. That is happening either way. The open question is who holds the keys. If the exocortex belongs to an ad company, it is the most complete record of your inner life ever kept, and it isn't yours. If it belongs to you, it is the biggest upgrade to human agency since writing. This repo is the engine for the second kind.

## What it's for

- **Remember your life, on your terms.** Everything is markdown in a [PARA](vault-template/PARA%20Guide.md) vault (Projects, Areas, Research, Archives). No proprietary format, no lock-in: it opens in any editor, syncs with git, and outlives the app.
- **Find anything, and see the shape of it.** Keyword and semantic search over the whole vault, a database page you can ask questions in plain language, and a 3D brain map of how your notes, projects and goals connect.
- **Put agents to work without handing them the keys.** Claude Code and Hermes work in the vault under one set of rules (`AGENTS.md`), with hooks that block reading your secrets, force pushes and other mistakes, and that ask for a dev log before an agent calls a job done.
- **Run a company of agents, if you want one.** Optional modules add a project tracker, a message board where named agents report to you, and a ledger of what they cost.
- **Stay the author.** Agents take the overhead. The writing, the reflection and the decisions stay with you.

Private by construction: the engine never sees your notes. Your vault is your own private repo, and this public repo plugs into it as a submodule.

## Made to be worn: Exo

The second brain is half of a pair. The other half is **Exo**, a modular wearable computer: display glasses, earbuds and a few keys on a sling, built around a Raspberry Pi, that you hold a button and talk to. Details and the waitlist: https://exo.myargoquest.com <!-- public-ok -->

The two share one design rule: the agents are yours, the data is yours, and nothing important moves without you. Together they make a loop:

| Exo (on you) | secondbrain (your vault and server) |
|---|---|
| Push-to-talk to your own agents, wherever you are | The agents' memory, skills and rules live here |
| A ring and body sensors capture what your body is doing | The `ring` module stores that data next to your notes |
| A small screen for glanceable views | The projects feed, and the map and tv kiosk views (`?kiosk=1`) |
| Thin client: it carries nothing worth stealing | Everything lives in your vault and your database |

You don't need Exo to use secondbrain: it runs the same on a laptop or a small server. Exo is where it's heading, an exocortex that leaves the screen.

## What's in the box

| Path | What |
|---|---|
| `app/` | The web app: browse and search your vault (keyword and semantic), a database explorer, and optional modules. Runs on your laptop with no login, or on a server behind Caddy with password + authenticator login |
| `vault-template/` | A PARA vault with the shared agent rules, ready to fill |
| `harness/` | Hooks Claude Code and Hermes both run: a guard against dangerous tool calls, and a gate that asks for a dev log before an agent finishes |
| `skills/` | Shared agent skills (`SKILL.md`, used by both Claude Code and Hermes) |
| `bin/secondbrain-vault` | Starts a vault, compiles its `AGENTS.md`, links the skills |
| `addons/tv-kiosk/` | Flash a Raspberry Pi that shows the app full screen on a TV |

**Modules** (all off until you list them in `MODULES`): `projects` (tracker), `org` (agent message board), `usage` (what your agents cost), `map` (3D brain map), `tv` (your own video channel), `voice` (read notes aloud locally), `livestream` (stream stats), `ring` (wearable ring data), `agents` (kanban, chats and cron history). Each is described in [`app/README.md`](app/README.md).

## How it fits together

Your notes live in **your own vault**, a private git repo. This repo is the **engine**, added to the vault as a git submodule at `.secondbrain/`. You pull engine updates by moving the pin; the engine never sees your notes.

```
my-vault/                      private
├── .secondbrain/              this repo, pinned
├── AGENTS.local.md            your rules for agents
├── AGENTS.md                  generated: shared rules + yours
├── CLAUDE.md                  @AGENTS.md
├── .agents/skills/            your skills + links to the shared ones
├── .agents/guard.local.json   your extra guard rules
├── secondbrain.json           optional: metrics, map folders, channels
├── .env                       your settings and keys (gitignored)
└── Projects/ Areas/ Research/ Archives/
```

## Quick start

```bash
mkdir my-vault && cd my-vault && git init
git submodule add https://github.com/kon-rad/secondbrain.git .secondbrain
.secondbrain/bin/secondbrain-vault init .
cp .env.example .env
```

Then run the app: see [`app/README.md`](app/README.md) (Node 22, Postgres 15 with pgvector).

## Updating

```bash
git -C .secondbrain pull origin main      # or check out a release tag
.secondbrain/bin/secondbrain-vault rules   # refresh AGENTS.md
.secondbrain/bin/secondbrain-vault link-skills
git commit -am "engine: update"
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Agents: read [`AGENTS.md`](AGENTS.md) first.

## License

MIT
