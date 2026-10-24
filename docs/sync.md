# Vault sync

The vault is a git repo, and every machine that works in it (your laptop, a second computer, a server running agents) has its own checkout. `secondbrain-vault sync` keeps those checkouts in step without anyone pushing by hand: on a timer, each machine commits its own changes, scans them for secrets, pulls everyone else's and pushes. It is built to lose no work, leak no key, and give way to the agent sessions editing the same files.

```
.secondbrain/bin/secondbrain-vault sync run [--dry-run]       one pass, now
.secondbrain/bin/secondbrain-vault sync install [--interval MIN] [--render DIR]
                                                               schedule it on this machine
.secondbrain/bin/secondbrain-vault sync uninstall
.secondbrain/bin/secondbrain-vault sync status [--json]       last run, last success, ahead/behind, problems
.secondbrain/bin/secondbrain-vault sync resolve [--keep local|remote NOTE]
                                                               list conflict copies, pick a side
```

Python 3.9+ and git, nothing else. [gitleaks](https://github.com/gitleaks/gitleaks) is used when it is on `PATH` and recommended.

## Roles

Each machine declares what it is in its own `.env`:

| `SYNC_ROLE` | Who edits here | Conflict default | Typical machine |
|---|---|---|---|
| `owner` (default) | You, and agents working for you in person | `stop`: the sync pauses and alerts, you decide | Your laptop, a second computer |
| `agent` | Agents and timers, nobody watching | `both`: keep both versions, carry on | A server |

Some files are written by one role only. `sync.agentOwned` in `secondbrain.json` lists files a server timer renders (a project report, a dashboard): an `owner` machine never commits them, drops any local change to them before committing, and takes the server's copy when they conflict. That keeps a laptop's stale copy of a generated file from ever overwriting the server's.

## One run

Every run, on the interval you chose and once at login:

1. **Back off if git is busy.** `.git/index.lock` exists, a rebase or merge is in progress, or another sync run holds the lock: exit quietly. Nothing a session is doing is interrupted.
2. **Wait for writes to settle.** If any changed file was modified in the last `settleSeconds` (90), a session is probably mid-edit: wait a minute and look again, up to five times, then go ahead anyway so constant activity can't block the sync for ever.
3. **Drop what this role does not own.** On an `owner` machine, local changes to `agentOwned` files are restored. Pointer moves of embedded repos (a folder with its own `.git` that is not a submodule) are left out unless `sync.embeddedRepos` is `record`.
4. **Stage and check.** `git add -A`, then refuse the whole commit if a staged file looks like a secret by name (`.env`, `*.pem`, `*.key`, SSH keys), if gitleaks flags the staged diff, if the built-in token rules match (private key blocks, AWS, GitHub, Slack and `sk-` style tokens), or if any staged file is over `maxFileMB` (20). On refusal everything is unstaged, nothing is committed, and the alert names the files, never the matched value. Allow a false alarm in `.gitleaksignore`.
5. **Commit** as `sync(<machine>): 3 files: a.md, b.md, c.md`, with the checkout's own git author. `SYNC_MACHINE` defaults to the hostname, so a server's commits and a laptop's are told apart by message.
6. **Fetch.** If it fails you are offline: the commit stays local, the run ends with no alert, unless the last successful sync is more than 24 hours old.
7. **Rebase onto the remote branch.** The tree is clean after step 5, so this is safe. On a conflict:
    - every conflicted file is an `agentOwned` one: take the side that owns it and continue;
    - anything else, policy `stop`: `git rebase --abort` puts the checkout back exactly where it was, the alert names the files, and later runs keep committing locally but skip pull and push until the conflict is gone (they retry it each time, so fixing it by hand is all it takes);
    - anything else, policy `both`: the local version stays as the note, the remote version is written next to it as `<note> (conflict from <machine>).md`, and the sync continues. Nothing is lost and nobody is paged. `sync resolve` lists the copies and `--keep local|remote` picks one.
8. **Push.** If someone pushed in between, fetch and rebase once more and retry. A push that fails three runs in a row alerts.
9. **Write the state** to `~/.local/state/secondbrain/sync.json` and append to `sync.log` in the same folder: last run, last success, ahead/behind, last problem. `sync status` prints it; the app shows it as a header chip ("synced 12m ago", or "sync: conflict" in red) when the state file exists on the machine the app runs on.

A run never force-pushes, never rewrites history and never deletes a file that only one side has.

## Install on a machine

```bash
cd <your vault>
.secondbrain/bin/secondbrain-vault sync run --dry-run   # stage, scan, fetch, report; no commit, no push
.secondbrain/bin/secondbrain-vault sync install          # every 60 minutes, and at login
```

`install` schedules `sync run` with launchd on macOS and a systemd user timer on Linux, and writes a small shim to `~/.local/libexec/secondbrain/` that runs the engine's `tools/sbsync.py` from the vault, so moving the engine pin updates the sync too. `--interval` sets the minutes (default `SYNC_INTERVAL_MIN`, else 60). `--render DIR` writes the scheduler files to a folder without installing anything, so you can read them first.

| Platform | Notes |
|---|---|
| macOS | If the vault is under `~/Documents`, `~/Desktop` or `~/Downloads`, launchd can't read it: `install` also builds `~/Applications/SecondBrainSync.app` (the same small signed launcher the app uses) and schedules that. The first run shows one "allow access to Documents" prompt. Needs the Xcode command line tools for the compile. Push credentials come from your keychain (`credential.helper=osxkeychain`) or an SSH key |
| Linux desktop or server | A user timer; run `loginctl enable-linger $USER` so it runs with nobody logged in. Push credentials: an SSH deploy key or `credential.helper=store` |
| Windows | Not scheduled yet. `sync run` works from any scheduler you set up |
| A server deployed with `deploy.sh` | Set `DEPLOY_VAULT_SYNC=1`: the deploy installs `secondbrain-vault-sync.timer` as the app user every 15 minutes, with `SYNC_ROLE=agent`. The server's env file is `/etc/secondbrain/env` ([deployment.md](deployment.md)) |

Three machines, in the order that costs least: a computer that never had a sync first (its only risk is a refused commit), then the laptop you edit on, then the server, whose old pull-only cron or sync script you remove at the same time.

## Settings

Per machine, in the vault's `.env` (or the environment; the environment wins):

| Variable | Default | Purpose |
|---|---|---|
| `SYNC_ROLE` | `owner` | `owner` or `agent`, above |
| `SYNC_MACHINE` | the hostname | Name in commit messages and conflict copies |
| `SYNC_INTERVAL_MIN` | `60` | Minutes between runs, used by `install` |
| `SYNC_CONFLICTS` | `stop` for `owner`, `both` for `agent` | What a conflict on a note does |
| `SYNC_ALERT` | `desktop` | `desktop` (a macOS notification or `notify-send`; falls back to the log), `log`, or an `https://` URL that receives a POST with a JSON body `{"title", "text"}` (a Slack-style webhook, ntfy, your own endpoint) |
| `SYNC_STATE_DIR` | `~/.local/state/secondbrain` | Where `sync.json` and `sync.log` go. The app reads the same place |

Shared by every machine, committed, in `secondbrain.json`:

```json
"sync": {
  "remote": "origin",
  "branch": "main",
  "agentOwned": ["projects.md"],
  "embeddedRepos": "ignore",
  "maxFileMB": 20,
  "settleSeconds": 90,
  "heartbeat": false
}
```

| Key | Default | Holds |
|---|---|---|
| `remote`, `branch` | `origin`, `main` | What every machine syncs with |
| `agentOwned` | `[]` | Files only `agent` machines commit (vault-relative paths) |
| `embeddedRepos` | `ignore` | `ignore` leaves pointer moves of nested repos unstaged; `record` commits them as gitlinks, as plain `git add -A` would |
| `maxFileMB` | `20` | Largest file a run will commit |
| `settleSeconds` | `90` | How recently a file may have changed before the run waits |
| `heartbeat` | `false` | When on, each run that commits also writes `.sync/<machine>.json` (machine, role, time, engine commit), so every checkout can see when every other machine last synced. Adds no commits of its own |

## When something goes wrong

| Situation | What the run does | Alert |
|---|---|---|
| Offline, fetch fails | Commits locally, skips pull and push | Only after 24 h without a successful sync |
| Git busy (lock, rebase, merge) | Skips the run | No |
| Files still being written | Waits up to five minutes, then goes ahead | No |
| A secret, a key file or a file over the size cap is staged | Unstages everything, commits nothing | Yes, with file names |
| Conflict on a note, policy `stop` | Aborts the rebase, keeps committing locally, retries the pull every run | Once per distinct set of files |
| Conflict on a note, policy `both` | Keeps both versions, continues | No; `sync status` lists the copies |
| Push rejected | Fetches, rebases and retries once, then waits for the next run | After three failed runs in a row |
| Another sync run is still going | Skips | No |

Each alert fires once until its cause clears, so a conflict left for a day is one notification, not twenty-four.

## What it is not

- **Not a file watcher.** Committing on every save would capture half-written files from twenty concurrent sessions. A timer with a settle window is calmer, and `sync run` is there when you want it now.
- **Not a sync for nested repos.** A code repo inside the vault has its own remote and workflow; the vault records at most a pointer to it.
- **Not a database sync.** Module tables (tracker, board, usage) live in Postgres; [deployment.md](deployment.md) covers sharing one database and backing it up.
- **Not a replacement for `.gitignore`.** The secret scan is the second line. The template's `.gitignore` already excludes `.env*`, media and databases; keep it that way.

## Design notes

Why the engine ships this rather than leaving it to a cron line per machine:

- **Conflict policy is the whole problem.** A plain `git pull --rebase` with `-X theirs` silently drops one version of a note. The two policies here either stop and ask, or keep both; neither loses text.
- **Shared checkouts need manners.** Agents and editors write the same files the sync commits. Backing off on git's own locks and on recent writes is what keeps the sync from committing a half-written note or breaking a session's rebase.
- **Secrets live where people type.** The laptop is where keys end up in the wrong file, and the push is the moment it becomes a leak. Scanning the staged diff, not the working tree, catches exactly what is about to leave.
- **Roles instead of machine names.** The first version of this ran as two private scripts, one per machine, each with the other's file names baked in. `owner`/`agent` plus an `agentOwned` list says the same thing for any number of machines and holds nothing personal.
- **State on disk, not in the vault.** `sync.json` is per machine and would be a commit per hour per machine if it lived in the repo. The optional heartbeat piggybacks on commits that happen anyway.
