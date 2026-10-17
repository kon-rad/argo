# Deploying to a server

The same app can run on a server, over a checkout of your vault that a git sync keeps current, behind HTTPS and a login. You run `deploy.sh` from your own machine; the server needs no GitHub credentials for the app, because the script ships source with rsync.

## What you need

| | |
|---|---|
| A server | Ubuntu, reachable as root over ssh (an `~/.ssh/config` alias is easiest) |
| A name | A domain pointed at the server (recommended), or its bare IP |
| A vault checkout on the server | Kept current by your own git sync (a cron or timer that pulls) |
| Your laptop | With the vault and the engine, and Node 22 for `auth-setup` |

`deploy.sh` installs Node, Postgres with pgvector, and Caddy on first run.

## First deploy

**1. Create the login, on your own machine:**

```bash
secondbrain auth-setup
```

It asks for a password, enrols an authenticator app (TOTP), and prints two lines, `AUTH_PASSWORD_HASH=...` and `AUTH_TOTP_SECRET=...`. Keep them for step 3. The password itself is never stored.

**2. Add the deploy settings to your vault `.env`:**

```
DEPLOY_HOST=my-server
DEPLOY_PUBLIC_HOST=brain.example.com
DEPLOY_VAULT_DIR=/srv/vault
```

**3. Deploy:**

```bash
.secondbrain/app/deploy/deploy.sh
```

It is idempotent: the first run installs everything, later runs ship code, rebuild, migrate and restart.

**4. Fill in the server's env file, first time only.** `deploy.sh` creates `/etc/secondbrain/env` from `app/deploy/env.example`. Paste the two `AUTH_*` lines, set `PUBLIC_ORIGIN=https://brain.example.com`, `MODULES`, and any keys (`TOGETHER_API_KEY`), then:

```bash
ssh my-server 'systemctl restart secondbrain'
```

The app refuses to start in server mode without `AUTH_PASSWORD_HASH`, `AUTH_TOTP_SECRET` and `PUBLIC_ORIGIN`. That is deliberate: there is no "auth off" for a server.

## Settings

`deploy.sh` reads only its own keys from the vault `.env` (or the environment), and takes them literally: it never `source`s the file, so a `$` in some other value can't break it.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DEPLOY_HOST` | yes | | ssh destination with root |
| `DEPLOY_PUBLIC_HOST` | yes | | The domain or IP Caddy serves |
| `DEPLOY_VAULT_DIR` | yes | | The vault checkout on the server |
| `DEPLOY_APP_USER` | | `secondbrain` | Unix user that owns the vault and runs the app |
| `DEPLOY_APP_DIR` | | `/opt/secondbrain-app` | Where the app is installed |
| `DEPLOY_HERMES_HOME` | | `~<app user>/.hermes` | Hermes home on the server, for the `agents` module |
| `DEPLOY_MODULES` | | `MODULES` | The server's module list, when it differs from your laptop's |
| `EXTRA_CADDY_IMPORT` | | | Caddyfile snippets for other sites on the same box, comma separated |
| `DEPLOY_REDIRECT_FROM` | | | Another host (for example the bare IP) that redirects to the public host |
| `DEPLOY_PAUSE_FILE` | | | A file that holds an agent dispatcher off while the build runs |
| `DEPLOY_EMBED=1` | | off | Install the nightly embed timer (needs a local Ollama on the server) |
| `DEPLOY_DB_BACKUP=1` | | off | Install the nightly `pg_dump` backup timer (needs `b2store` for the app user) |

## What runs on the server

| Unit | When | Installed if |
|---|---|---|
| `secondbrain.service` | Always | Always |
| `secondbrain-agents-sync.timer` | Periodic | `agents` |
| `secondbrain-usage-sync.timer`, `-credits-sync.timer`, usage importer | Periodic | `usage` |
| `secondbrain-projects-render.timer` | Hourly | `projects` |
| `secondbrain-map-build.timer` | Hourly at :20 | `map` |
| `secondbrain-metrics.timer` | Daily 00:30 UTC | `map` |
| `secondbrain-livestream.timer` | Every minute | `livestream` |
| `secondbrain-embed.timer` | Daily 02:30 UTC | `DEPLOY_EMBED=1` |
| `secondbrain-db-backup.timer` | Daily 03:30 UTC | `DEPLOY_DB_BACKUP=1` |

Caddy is rendered from `app/deploy/Caddyfile.template`. If you already run Caddy for other sites, diff the rendered file against your live one before the first deploy, and use `EXTRA_CADDY_IMPORT` for the others.

## The login

One user. The password is hashed with scrypt (128 MiB, verified one at a time); the second factor is RFC 6238 TOTP with single-use codes. Both factors are always checked and failures share one message. Sessions are random 256-bit tokens in a `__Host-` cookie (HttpOnly, Secure, SameSite=Strict); only their SHA-256 is stored. They end after 7 idle days or 30 days total, and `POST /api/auth/logout-all` ends every session. Five failures lock an IP out for 15 minutes; 100 failures in an hour lock everyone out. Every mutating request must carry the right `Origin`.

## Updating a server

1. Move your vault's engine pin ([vault.md](vault.md#updating-the-engine)) and commit.
2. **Compare migrations first.** If anything else has run migrations on the server's database, list `pgmigrations` there and check that every applied migration exists in `app/db/migrations/`. node-pg-migrate refuses to run when the database has a migration the code doesn't.
3. Run `.secondbrain/app/deploy/deploy.sh` again.

## Several machines, one database

You can keep the server as the only database and have your laptop use it (for example over a private network such as Tailscale or WireGuard):

- On the laptop, set `SECONDBRAIN_DB_URL` in the vault `.env`. The launcher then starts the app with `INDEXER=off` and skips migrations.
- Only the server scans and embeds. Two scanners over two checkouts would fight over the index.
- Give the laptop its own database role with only the rights it needs.
