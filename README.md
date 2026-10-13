# secondbrain

<!-- TODO(konrad): write the intro prose before the repo goes public. -->

TODO(konrad): one paragraph on what this is and who it's for.

## What's in the box

| Path | What |
|---|---|
| `app/` | The Second Brain web app: browse, keyword and semantic search over your markdown vault, a database explorer, and optional Ring and Agents pages. Runs locally with no login, or on a server behind Caddy with password + authenticator login |
| `vault-template/` | A PARA vault (Projects, Areas, Research, Archives) with shared agent rules |
| `harness/` | Hooks that Claude Code and Hermes both run: a guard that blocks dangerous tool calls, and a gate that asks for a dev log before an agent finishes |
| `skills/` | Shared agent skills (`SKILL.md` format, used by Claude Code and Hermes) |
| `bin/secondbrain-vault` | Starts a vault, compiles its `AGENTS.md`, links the skills |

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
