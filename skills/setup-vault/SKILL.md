---
name: setup-vault
description: Take someone from an empty folder to a running private vault. Ask a few questions, then run the git, init, app and index steps with a check after each, and stop before connecting an agent harness. Use when the user says "set up my vault", "start my second brain", "install argo", "get me started", or hands over a new machine and asks how to begin.
---

# Set up your vault

A vault is an empty folder that becomes a private git repo of plain markdown, with the engine plugged in as a submodule at `.secondbrain/` and a web app indexing it. This skill walks a new user there by asking four questions and then running the steps, one at a time, checking each before the next.

It stops once the vault runs and search works. Connecting an agent harness (Claude Code, Hermes, another tool) is the next page, not this skill.

## When to use

- The user has no vault yet and wants one, on this machine or another.
- The user says "set up my vault", "start my second brain", "install this", or "where do I begin".
- A fresh machine needs the prerequisites and a first vault.

Don't use for: adding notes to an existing vault (`ingest`), connecting an agent to a vault that already runs, or a server deployment. Point to the docs page for those.

## Ask these questions first

Ask all four in **one** batch, then work from the answers. Don't run anything before the answers are in.

| Question | Why it decides | Suggested default |
|---|---|---|
| Where should the vault live? An absolute path to a **new or empty** folder | `init` refuses a folder that already has content. If the user has an existing markdown folder, create a fresh empty vault and move notes in at Step 4 | `~/second-brain` |
| Which operating system is this? macOS, Debian or Ubuntu, or something else | Picks the install commands in Step 1. "Something else" means install the five tools by the user's own means, then continue | Detect it if you can; confirm |
| Semantic search now, later, or never? | Only affects Step 5. Keyword search needs no keys | Later |
| Which agent harness will you connect after this? Claude Code, Hermes, another tool, or none yet | Only picks the "Next" pointer; this skill does not connect it | None yet |

Also confirm the target folder, if it exists, is empty: `ls -A <path>` prints nothing (a bare `.git` from a previous attempt is fine to reuse).

## Step 1: Prerequisites

Five tools, with versions:

| Tool | Version | For |
|---|---|---|
| git | any recent | The vault is a git repo; the engine is a submodule |
| Python | 3.9+ | The vault CLI and the agent hooks (standard library only) |
| Node.js | 22+ | The app |
| PostgreSQL | 15+ | The search index |
| pgvector | 0.8+ | Semantic search; must be built for the same Postgres |

Check what is already there, then install only what is missing:

```bash
git --version; python3 --version; node --version; psql --version
psql -c 'select 1'            # proves the server answers
```

On macOS (Homebrew):

```bash
brew install git node@22 python postgresql@15
brew services start postgresql@15
git clone --branch v0.8.1 https://github.com/pgvector/pgvector.git /tmp/pgvector
make -C /tmp/pgvector PG_CONFIG=$(brew --prefix postgresql@15)/bin/pg_config
make -C /tmp/pgvector install PG_CONFIG=$(brew --prefix postgresql@15)/bin/pg_config
```

On Debian or Ubuntu:

```bash
sudo apt install git python3 postgresql postgresql-contrib
sudo apt install postgresql-16-pgvector      # match the installed Postgres major version
sudo -u postgres createuser --superuser "$USER"
# Node 22 through nvm, fnm or the NodeSource packages
```

There is a scripted path too, which installs all five and nothing else:

```bash
curl -fsSL https://kon-rad.github.io/argo/install.sh | sh
```

**Check:** `psql -c 'select 1'` answers, and `node --version` prints 22 or later.

## Step 2: Create the vault

```bash
mkdir -p <path> && cd <path>
git init
git submodule add https://github.com/kon-rad/argo.git .secondbrain
.secondbrain/bin/secondbrain-vault init .
cp .env.example .env
git add -A && git commit -m "new vault"
```

What `init` writes: the PARA folders (`Projects/`, `Areas/`, `Research/`, `Archives/`, each with a README), `AGENTS.local.md` (the user's rules, near empty), the generated `AGENTS.md`, a `CLAUDE.md` pointing at it, Claude Code wired to the hooks and the shared skills, `.agents/org.json` (a starter roster), and the settings files. `.env` is gitignored from the first commit.

**Check:** `git status` is clean and `head -3 AGENTS.md` shows the generated header.

Two rules to state once, now: never make the vault repo public, and never commit inside `.secondbrain/` (it is a pinned checkout of the engine).

## Step 3: Run the app

```bash
.secondbrain/app/bin/secondbrain
```

The first run installs dependencies, creates the `secondbrain` database, runs the migrations, builds the server and web UI, starts on `http://127.0.0.1:5123` and opens the browser (a headless machine prints the URL). Later runs just start it.

Offer to put the launcher on PATH so the docs read naturally:

```bash
ln -s "$PWD/.secondbrain/app/bin/secondbrain" ~/.local/bin/secondbrain
```

**Check:** the browser shows the app, and `secondbrain status` reports it running.

## Step 4: Add notes and build the index

Move a folder of existing markdown into `Projects/`, `Areas/` or `Research/`, or write a few notes, then:

```bash
secondbrain scan
```

The scanner skips credential-shaped files (`.env*`, `*.pem`, `*.key`), so they are never indexed or served. PARA is a convention, not a requirement: the app indexes every markdown file under the vault.

If the user arrived with an existing Obsidian vault, this is the step where its notes come in (Step 2 required an empty folder).

**Check:** keyword search finds a word from one of the notes, and opening a note shows its backlinks.

## Step 5: Semantic search (only if asked for it)

Keyword search needs no keys. For semantic and hybrid search, pick one and set it now:

| Option | Where the text goes | Setup |
|---|---|---|
| Together AI | Note chunks go to Together's embedding API | Add `TOGETHER_API_KEY=` to `.env` |
| Ollama | Nothing leaves the machine | Run Ollama with `nomic-embed-text` or `bge-m3`, then set the embeddings provider to `ollama` on the Sources page |

Then run `secondbrain embed`.

**Check:** `semantic` mode finds a note by meaning, using different words than the note uses. If it returns 503, there is no embedding provider yet.

## Step 6: Back up and keep it private

```bash
git remote add origin <a private remote>
git push -u origin main
```

**Check:** the remote is private, and `git check-ignore .env` prints `.env`.

## Step 7: Hand off to the next page

Report what runs, then point the user at the page for their answer in the last question:

| Their answer | Next |
|---|---|
| Claude Code | `docs/onboarding/03-claude-code.md` |
| Hermes | `docs/onboarding/04-hermes.md` |
| Another tool | `docs/onboarding/05-other-harnesses.md` |
| None yet | Stop; the vault is usable on its own |

## Pitfalls

- **`init` refuses a non-empty folder.** Never run it against someone's existing notes; create the empty vault first and move notes in at Step 4.
- **`extension "vector" is not available`** during migrations means pgvector was built for a different Postgres. Rebuild it with that server's `pg_config`.
- **`postgres did not come up on localhost:5432`** means Postgres is not running or is on another port. Start it or set `DATABASE_URL`.
- **A module's page is missing** means the module is not in `MODULES`, or the server was not restarted. Modules are off by default; this skill does not turn any on.
- **A public `.env` or a public remote** is the one unrecoverable mistake. Check `git check-ignore .env` before the first push, and confirm the remote is private.
- **On a headless machine**, `2` (open a browser) is skipped and a URL is printed instead. Do not treat that as a failure.

## Verification

The setup is done when all of these hold, on the machine where the vault will live:

1. `git -C <path> status` is clean.
2. `secondbrain status` reports the server running, and the app loads on `http://127.0.0.1:5123`.
3. Keyword search returns a note the user wrote or moved in.
4. `git check-ignore .env` prints `.env`, and the remote is private.

Report the vault path, which steps ran, the search result, and which step (03, 04 or 05) is next. Say plainly what was not done: no module was enabled, no agent harness was connected, no server was set up.
