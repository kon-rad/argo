# Getting started

From nothing to a vault you can browse and search on your own machine. About 15 minutes, most of it installing Postgres.

## 1. Install the prerequisites

| Tool | Version | Why |
|---|---|---|
| git | any recent | The vault is a git repo; the engine is a submodule |
| Node.js | 22 or later | The app server and web UI |
| Python | 3.9 or later | `secondbrain-vault` (stdlib only) and the agent hooks |
| PostgreSQL | 15 or later | The search index |
| pgvector | 0.8 or later | Semantic search. Must be built for the same Postgres the app uses |

**macOS (Homebrew):**

```bash
brew install git node@22 python postgresql@15
brew services start postgresql@15
# pgvector, built against that Postgres:
git clone --branch v0.8.1 https://github.com/pgvector/pgvector.git /tmp/pgvector
make -C /tmp/pgvector PG_CONFIG=$(brew --prefix postgresql@15)/bin/pg_config
make -C /tmp/pgvector install PG_CONFIG=$(brew --prefix postgresql@15)/bin/pg_config
```

**Ubuntu / Debian:**

```bash
sudo apt install git python3 postgresql postgresql-contrib
sudo apt install postgresql-16-pgvector      # match your Postgres major version
sudo -u postgres createuser --superuser "$USER"
# Node 22: use nvm, fnm, or the NodeSource packages
```

## 2. Make a vault

A vault is your own private git repo. The engine goes inside it as a submodule at `.secondbrain/`.

```bash
mkdir my-vault && cd my-vault && git init
git submodule add https://github.com/kon-rad/secondbrain.git .secondbrain
.secondbrain/bin/secondbrain-vault init .
cp .env.example .env
```

`init` refuses a folder that already has content (other than `.git`, `.gitmodules` and `.secondbrain`). It creates:

| Path | What |
|---|---|
| `Projects/`, `Areas/`, `Research/`, `Archives/` | The PARA folders, each with a README. See `PARA Guide.md` |
| `AGENTS.local.md` | Your own rules for AI agents (starts nearly empty) |
| `AGENTS.md` | Generated: the engine's shared rules plus yours. Don't edit it by hand |
| `CLAUDE.md` | One line, `@AGENTS.md`, so Claude Code reads the same rules |
| `.claude/settings.json` | Claude Code wired to the guard and dev-log hooks |
| `.claude/agents/fact-checker.md` | A read-only fact-checking subagent |
| `.claude/skills` | A symlink to `.agents/skills` |
| `.agents/skills/` | Your skills, plus symlinks to the engine's shared ones |
| `.agents/guard.local.json` | Your own extra guard rules (empty to start) |
| `.env.example`, `.gitignore`, `secondbrain.example.json` | Settings templates; `.env` is gitignored |

Commit it:

```bash
git add -A && git commit -m "new vault"
```

Push it to a **private** remote if you want a backup. Never make your vault public.

## 3. Run the app

```bash
.secondbrain/app/bin/secondbrain
```

On first run the launcher installs dependencies, creates the `secondbrain` database, runs the migrations, builds the server and web UI, starts the server on `http://127.0.0.1:5123` and opens your browser.

The index starts empty. Build it once with `secondbrain scan` (or the rescan button in the nav bar). On your laptop, scans only run when you ask; a server rescans every `SCAN_INTERVAL_MINUTES`.

Put it on your PATH if you like:

```bash
ln -s "$PWD/.secondbrain/app/bin/secondbrain" ~/.local/bin/secondbrain
```

| Command | Does |
|---|---|
| `secondbrain` | Start (if needed) and open the browser |
| `secondbrain stop` / `restart` / `status` / `logs` | Manage the server |
| `secondbrain scan` | Re-index the vault now |
| `secondbrain embed` | Embed new and changed notes for semantic search |
| `secondbrain dev` | Server and web UI in watch mode, for development |
| `secondbrain help` | Every subcommand, including the module CLIs |

The launcher reads `<vault>/.env`. It finds the vault by walking up from `.secondbrain/app/bin/`; set `VAULT_ROOT` to point it elsewhere.

## 4. Turn on semantic search (optional)

Keyword search works with no keys. For semantic and hybrid search, pick one:

- **Together AI:** add `TOGETHER_API_KEY` to your vault `.env`.
- **Fully local:** run [Ollama](https://ollama.com) with `nomic-embed-text` or `bge-m3`, and set the embeddings source's `provider` to `ollama` on the Sources page.

Then:

```bash
secondbrain embed
```

## 5. Turn on modules (optional)

Everything beyond browse, search and the database page is a module, and all of them are off by default. List the ones you want in your vault `.env`:

```
MODULES=projects,map
```

Then `secondbrain restart`. What each one does and needs: [modules.md](modules.md).

## 6. Let agents in (optional)

Open the vault in Claude Code (run `claude` in the vault folder) or point Hermes at it ([agent-harness.md](agent-harness.md)). Both read `AGENTS.md`, both run the guard hook before every tool call, and both are asked for a dev log when they change code or config.

Write your own rules in `AGENTS.local.md`, then:

```bash
.secondbrain/bin/secondbrain-vault rules
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `extension "vector" is not available` during migrations | pgvector was built for a different Postgres. Rebuild it with that server's `pg_config` |
| `postgres did not come up on localhost:5432` | Postgres isn't running, or isn't on 5432. Set `DATABASE_URL` |
| Semantic search returns 503 | No embedding provider: add `TOGETHER_API_KEY` or run Ollama |
| A module's page is missing | The module isn't in `MODULES`, or the server wasn't restarted |
| `init` says the folder already has content | `init` only starts new vaults. Use an empty folder |
