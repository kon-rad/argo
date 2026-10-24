# Set up your vault

From nothing to a private vault you can browse and search, in six steps. Each step ends with a check, so you know it worked before moving on. The reference for every detail is [getting-started.md](../getting-started.md).

## Step 1. Install the prerequisites

| Tool | Version | Why |
|---|---|---|
| git | any recent | The vault is a git repo and the engine is a submodule |
| Python | 3.9+ | The vault CLI and the agent hooks (standard library only) |
| Node.js | 22+ | The app |
| PostgreSQL | 15+ | The search index |
| pgvector | 0.8+ | Semantic search. It must be built for the same Postgres the app uses |

macOS with Homebrew:

```bash
brew install git node@22 python postgresql@15
brew services start postgresql@15
git clone --branch v0.8.1 https://github.com/pgvector/pgvector.git /tmp/pgvector
make -C /tmp/pgvector PG_CONFIG=$(brew --prefix postgresql@15)/bin/pg_config
make -C /tmp/pgvector install PG_CONFIG=$(brew --prefix postgresql@15)/bin/pg_config
```

Ubuntu or Debian:

```bash
sudo apt install git python3 postgresql postgresql-contrib
sudo apt install postgresql-16-pgvector        # match your Postgres major version
sudo -u postgres createuser --superuser "$USER"
# Node 22: nvm, fnm or the NodeSource packages
```

**Check:** `psql -c 'select 1'` answers, and `node --version` prints 22 or later.

## Step 2. Create the vault

A vault is an empty folder that becomes a private git repo, with the engine inside it.

```bash
mkdir my-vault && cd my-vault && git init
git submodule add https://github.com/kon-rad/secondbrain.git .secondbrain
.secondbrain/bin/secondbrain-vault init .
cp .env.example .env
git add -A && git commit -m "new vault"
```

What `init` created, and what each file is for:

| Path | What |
|---|---|
| `Projects/`, `Areas/`, `Research/`, `Archives/` | The PARA folders, each with a README. `PARA Guide.md` explains how to choose |
| `AGENTS.local.md` | Your rules for agents. Starts nearly empty |
| `AGENTS.md` | Generated: the shared rules plus yours. Never edit it by hand |
| `CLAUDE.md` | One line, `@AGENTS.md`, so Claude Code reads the same rules |
| `.claude/settings.json`, `.claude/agents/`, `.claude/skills` | Claude Code wired to the hooks, the fact-checker subagent, a link to the shared skills folder |
| `.agents/skills/`, `.agents/guard.local.json` | Your skills (plus links to the engine's), and your extra guard rules |
| `.env`, `.env.example`, `secondbrain.example.json`, `.gitignore` | Settings. `.env` is gitignored from the first commit |

**Check:** `git status` is clean and `cat AGENTS.md | head -3` shows the generated header.

Two rules from here on. Never make the vault repo public. And never commit inside `.secondbrain/`; it is a pinned copy of the engine.

## Step 3. Run the app

```bash
.secondbrain/app/bin/secondbrain
```

The first run installs dependencies, creates the `secondbrain` database, runs the migrations, builds the server and the web UI, starts the server on `http://127.0.0.1:5123` and opens your browser. Later runs just start it.

Put the launcher on your PATH so the rest of these docs read naturally:

```bash
ln -s "$PWD/.secondbrain/app/bin/secondbrain" ~/.local/bin/secondbrain
```

**Check:** the browser shows the app, and `secondbrain status` says it is running.

## Step 4. Put notes in and build the index

Write a few notes, or move an existing folder of markdown into `Projects/`, `Areas/` or `Research/`. Then:

```bash
secondbrain scan
```

On a laptop, scans only run when you ask (or press the rescan button in the nav bar). The scanner skips credential-shaped files (`.env*`, `*.pem`, `*.key` and the like), so they are never indexed and never served.

**Check:** keyword search finds a word from one of your notes, and opening the note shows its backlinks.

Already have an Obsidian vault? `init` refuses a folder that has content, so create the vault empty as above and then move your notes into it. PARA is a convention, not a requirement: the app indexes every markdown file under the vault, whatever the folders are called. Obsidian ignores dot-folders, so `.secondbrain/` never shows up in its search.

## Step 5. Turn on semantic search (optional)

Keyword search needs no keys. For semantic and hybrid search, pick one:

| Option | Where the text goes | Setup |
|---|---|---|
| Together AI | Note chunks are sent to Together's embedding API | Add `TOGETHER_API_KEY=` to `.env` |
| Ollama | Nothing leaves your machine | Run Ollama with `nomic-embed-text` or `bge-m3`, and set the embeddings source's provider to `ollama` on the Sources page |

Then `secondbrain embed`. Re-run it when notes change; a server does it on a timer.

**Check:** search in `semantic` mode finds a note by meaning, with different words than the note uses.

## Step 6. Back it up and keep it private

Push the vault to a **private** remote. That is your backup, and it is how a server or a second computer gets a copy later.

```bash
git remote add origin <your private remote>
git push -u origin main
```

Before the first push, set your commit email for the vault to something you are happy to see in its history, and confirm `.env` is not tracked:

```bash
git check-ignore .env        # prints .env
```

**Check:** the remote is private, and `git ls-files | grep -c '^.env$'` prints 0.

## What you have now

- A private git repo of markdown with the engine pinned inside it.
- The app on `http://127.0.0.1:5123`, bound to loopback with no login, because on a laptop loopback is the boundary.
- Keyword search, and semantic search if you turned it on.

## Next

- [Connect Claude Code](03-claude-code.md): five minutes, because `init` already wired it.
- Turn on modules when you want them: `MODULES=projects,map` in `.env`, then `secondbrain restart`. Each one is described in [modules.md](../modules.md).
- When something fails, the troubleshooting table at the end of [getting-started.md](../getting-started.md#troubleshooting) covers the usual causes: pgvector built for the wrong Postgres, Postgres not on 5432, a module page missing because the server was not restarted.
