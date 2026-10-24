# Connect servers and computers

One vault, several machines. This page is the map of which machine does what, and the order to add them in. The detailed server procedure is [deployment.md](../deployment.md).

## The shapes it takes

| Shape | Machines | When |
|---|---|---|
| **A** Laptop only | One | You are starting. Everything on this page is optional until you want a second machine |
| **B** Laptop + server | Two | You want the app from a phone, agents running while the laptop sleeps, scans on a timer |
| **C** Server + several agent machines | Three or more | Agents run on more than one computer and you want one ledger of what they did and cost |
| **D** Any of the above + a screen | Plus a Raspberry Pi | A TV or small display showing the map, the TV channel or the projects feed |

Whatever the shape, three rules hold:

1. **The vault moves by git.** Every machine has a checkout of the private vault repo. `secondbrain-vault sync` keeps each one committed, pulled and pushed on a timer ([sync.md](../sync.md)); the simplest server setup is a pull on a timer.
2. **One machine writes the index.** Two scanners over two checkouts fight over the database. The authoritative checkout (usually the server's) scans and embeds; every other machine either has its own database or is a read-only client of that one.
3. **Secrets never travel by git.** Each machine has its own env file, written by hand once. The vault's `.env` is gitignored from the first commit.

## Shape B: add a server

What you need: an Ubuntu box you can reach as root over ssh (an `~/.ssh/config` alias such as `my-server` is easiest), a domain pointed at it (recommended; a bare IP works), and a checkout of your vault on it.

**1. Put the vault on the server and keep it current.** Clone your private vault repo to, for example, `/srv/vault` as the user that will run the app (`secondbrain` by default), using a read-only deploy key. Then a timer or cron entry that pulls:

```
*/10 * * * *  cd /srv/vault && git pull --ff-only --quiet
```

The server never needs push access, and never needs access to the engine's GitHub repo: `deploy.sh` ships the engine source from your laptop with rsync.

If agents on the server write notes you want back on your laptop, give the app user push access instead and set `DEPLOY_VAULT_SYNC=1`: the deploy installs a timer that commits, pulls and pushes as `SYNC_ROLE=agent`, and `secondbrain-vault sync install` does the same on each of your computers ([sync.md](../sync.md)).

**2. Create the login, on your laptop.** One user, password plus authenticator app:

```bash
secondbrain auth-setup
```

It prints `AUTH_PASSWORD_HASH=...` and `AUTH_TOTP_SECRET=...`. The password itself is never stored anywhere.

**3. Tell `deploy.sh` where to go**, in your vault `.env`:

```
DEPLOY_HOST=my-server
DEPLOY_PUBLIC_HOST=brain.example.com
DEPLOY_VAULT_DIR=/srv/vault
```

**4. Deploy:**

```bash
.secondbrain/app/deploy/deploy.sh
```

The first run installs Node, Postgres with pgvector and Caddy, creates the app user, renders the Caddyfile, installs the systemd units and the timers for each module in `DEPLOY_MODULES` (else `MODULES`), and creates `/etc/secondbrain/env` from the example. Later runs ship code, rebuild, migrate and restart, and put the previous build back if the new one does not answer its health route.

**5. Fill in the server's env file, once.** Paste the two `AUTH_*` lines, set `PUBLIC_ORIGIN=https://brain.example.com`, `MODULES`, `SCAN_INTERVAL_MINUTES` and any keys, then `ssh my-server 'systemctl restart secondbrain'`. The app refuses to start in server mode without the two auth values and the origin. There is no "auth off" for a server.

**Check:** `https://brain.example.com` asks for a password and a code, and after login the search works. The ⓘ panel shows the version and commit you shipped.

### The laptop after that

You have two choices for the laptop:

| Choice | Set | Behaviour |
|---|---|---|
| Its own database (default) | nothing | The laptop scans its own checkout into its own Postgres. Two independent indexes, each over its own copy of the vault |
| A client of the server's database | `SECONDBRAIN_DB_URL` in the laptop `.env` | The launcher starts the app with `INDEXER=off` and skips migrations: it never scans or embeds, and reads the server's index |

For the second choice, reach Postgres over a private network (Tailscale or WireGuard), never over the public internet, and give the laptop its own database role with only the rights it needs. Postgres on the server listens on a Unix socket by default; opening it to the private interface is a change you make on purpose.

## Shape C: several machines running agents

Each machine that runs Claude Code or Hermes keeps its own record of every turn in a local SQLite file and syncs it to the server when it can reach it. Offline, rows wait. This is the **agent ledger**, and it needs the `usage` module on the server.

```bash
# On the server: a token for the new machine, shown once
secondbrain ingest-device add laptop-2 --display "Second laptop" --kind laptop

# On your laptop: build the one-file bundle and copy it to the machine
.secondbrain/app/bin/build-ledger.sh      # -> app/server/dist/ledger/ledger.mjs

# On the machine: install it (Node 22.5+ is the only requirement)
node --no-warnings ledger.mjs install --server https://brain.example.com --token sbd_... --host laptop-2 --redact-env /path/to/vault/.env
node --no-warnings ledger.mjs status
```

`install` writes `ledger.json` (mode 0600, it holds the token) next to `ledger.db` in the OS data folder and schedules `ledger run` every two minutes with launchd, a systemd user timer or Task Scheduler. `--redact-env` names env files whose secret-named values are removed before anything leaves the machine; the server only knows its own keys. Details, including the optional capture proxy and the Hermes per-request plugin: "Agent ledger" in the [app README](https://github.com/kon-rad/secondbrain/blob/main/app/README.md).

Upgrade the server before the machines. A newer ledger may send rows an older server does not know; they are kept and retried.

Hermes on the server, and pulling its history to the laptop: [Connect Hermes](04-hermes.md#hermes-on-a-server).

## Shape D: a screen on the wall

`addons/tv-kiosk/` flashes a Raspberry Pi 4 so it boots straight into a full-screen browser on one page of your app: the map in kiosk mode (`/map?kiosk=1`), the TV channel (`/tv?kiosk=1`) or the projects feed. It joins your Tailscale network if you give it a pre-auth key, so it reaches a server that is not public at all. The page, Wi-Fi, password hash and ssh key go onto the card at flash time from your `.env`. Read [the add-on's README](https://github.com/kon-rad/secondbrain/blob/main/addons/tv-kiosk/README.md) before you flash; it erases a disk.

A page behind the login needs a session. The projects feed is the exception: `GET /api/feed/projects` takes a read-only bearer token (`PROJECTS_FEED_TOKEN`, generated by `deploy.sh`), made for exactly this.

## Other machine-to-machine links

| Link | Setting | Direction |
|---|---|---|
| Ring data from the server to a laptop | `RING_PULL_SSH_HOST`, `RING_PULL_DB` on the laptop | Server to laptop, over ssh, `secondbrain ring-pull` |
| Hermes history from the server | `ARCHIVE_SSH_HOST`, `REMOTE_HERMES_HOME`, `REMOTE_HERMES_USER` on the laptop | Server to laptop, over ssh |
| Kanban, chats and cron pages | `AGENT_HUB_URL`, `AGENT_HUB_TOKEN` | The app to an agent-hub service you run separately (module `agents`) |
| Big media kept in object storage | `B2_SERVE_URL` | The app to a local `b2store serve` |

Every one of these is off until its setting exists. Use ssh aliases, not hostnames or IPs, in the env files; aliases are what the docs and the examples assume.

## Keeping several machines in step

| What | How |
|---|---|
| The engine version | Move the pin in the vault, commit, push. The server picks it up at the next `deploy.sh`; laptops at the next `secondbrain restart`, which rebuilds and migrates |
| Migrations | Forward only. Before deploying, check that every migration the server's database has applied still exists in `app/db/migrations/` |
| `AGENTS.md` and skills | `secondbrain-vault rules` and `link-skills` after a pin move, then commit. Hermes picks up skills from the folder; Claude Code through the symlink |
| Module lists | `MODULES` can differ per machine. `DEPLOY_MODULES` sets the server's when it differs from your laptop's |
| Backups | The vault is in git. Module tables (tracker, board, usage, ring) are not derived from markdown: `DEPLOY_DB_BACKUP=1` installs a nightly `pg_dump` timer |

Next: [Privacy](07-privacy.md), which is mostly about which of these links moves what.
