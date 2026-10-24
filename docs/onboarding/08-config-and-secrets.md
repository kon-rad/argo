# Configuration and secrets

Three places hold settings, each for one kind of value, and nothing personal is ever compiled into the engine. This page is where each thing goes on each machine, and how agents and scripts read it without ever printing it. The full list of variables and keys is [configuration.md](../configuration.md).

## The three places

| File | Holds | On | Committed? |
|---|---|---|---|
| `<vault>/.env` | Keys and per-machine settings | Your laptop, and any machine that runs the launcher | No. Gitignored by the template |
| `/etc/secondbrain/env` | The same, for the server. Owned `root:<app user>`, mode 640 | The server | No. Created by `deploy.sh` from `app/deploy/env.example`, then edited by hand once |
| `<vault>/secondbrain.json` | Structured, non-secret settings for modules: goal and mission notes, map folders, metrics, shows, channel handles | Every machine, through git | Yes, to your private vault |

The test for which file a value belongs in: **is it secret, or does it differ between machines?** Then `.env`. **Is it a list or a map, the same everywhere, and safe to commit to a private repo?** Then `secondbrain.json`. **Would it differ between two users?** Then it is never in the engine's code, which is the maintainers' rule.

The inventory of every variable, with a comment each, is `.env.example` in your vault (copied from `vault-template/env.example`) and `app/deploy/env.example` for the server. A new engine version can add variables; diff the examples after a pin move.

## How the app reads them

- The app reads `<vault>/.env` at start, validates every value and refuses to start with a clear message if one is invalid. Unknown module names are ignored; an unparsable `secondbrain.json` is reported and replaced by empty defaults.
- **A value already in the process environment wins over the file.** `SECONDBRAIN_DB=local secondbrain` forces the local database for one run without editing anything.
- `deploy.sh` reads only its own `DEPLOY_*` keys from the vault `.env`, literally: it never sources the file, so a `$` in some other value cannot break it.
- The launcher finds the vault by walking up from `.secondbrain/app/bin/`. `VAULT_ROOT` points it elsewhere.

## What goes where: a worked example

A laptop and a server, semantic search through Together, the `projects` and `map` modules, the server also running `usage`:

`<vault>/.env` on the laptop:

```
MODULES=projects,map
OWNER_NAME=owner
TOGETHER_API_KEY=...
DEPLOY_HOST=my-server
DEPLOY_PUBLIC_HOST=brain.example.com
DEPLOY_VAULT_DIR=/srv/vault
DEPLOY_MODULES=projects,map,usage
```

`/etc/secondbrain/env` on the server:

```
DEPLOYMENT=server
PUBLIC_ORIGIN=https://brain.example.com
VAULT_ROOT=/srv/vault
MODULES=projects,map,usage
SCAN_INTERVAL_MINUTES=30
AUTH_PASSWORD_HASH=...
AUTH_TOTP_SECRET=...
TOGETHER_API_KEY=...
```

`<vault>/secondbrain.json`, committed:

```json
{
  "goalsFile": "Areas/goals.md",
  "map": { "divisionFolders": { "writing": ["Areas/blog"] } },
  "projects": { "reportFile": "projects.md" }
}
```

Note what is duplicated on purpose (`MODULES` and `DEPLOY_MODULES` must agree for the server's timers to match its routes; `TOGETHER_API_KEY` is on both machines because both embed or answer questions) and what is not (the `AUTH_*` values exist only on the server and in your password manager).

## How agents read secrets

The base rules tell every agent the one safe way:

```bash
set -a; . ./.env; set +a          # load into the shell, not into the conversation
[ -n "$TOGETHER_API_KEY" ] && echo set   # check a key exists without printing it
```

Everything else is blocked by the guard: `cat`, `grep`, `head`, `sed`, `cp`, `curl`, `echo` and the other readers, whenever their text names `.env`, `.env.<anything>` (not `.env.example`), `auth.json` or `.credentials.json`; and file-tool reads and writes of the same. Claude Code's own `permissions.deny` in `.claude/settings.json` says the same thing a second time. A script that needs a key uses `python-dotenv` or sources the file the same way.

Flags that keep a file *out* of a transfer (`rsync --exclude .env.local`) are recognised and allowed, because that is how a deploy protects the server's secrets.

## Secrets with their own rules

| Secret | Made by | Lives | Notes |
|---|---|---|---|
| `AUTH_PASSWORD_HASH`, `AUTH_TOTP_SECRET` | `secondbrain auth-setup` on your laptop | Server env, your password manager | The password is never stored. Re-run `auth-setup` to change either |
| Agent ledger token (`sbd_...`) | `secondbrain ingest-device add` on the server, shown once | `ledger.json`, mode 0600, in the machine's OS data folder | `SB_LEDGER_TOKEN` in the environment overrides it. Add a device per machine; revoke per machine |
| `PROJECTS_FEED_TOKEN` | `deploy.sh`, first run | Server env | Read-only; the only thing it opens is the projects feed |
| `SOCIAL_TOKEN_ENC_KEY` | You: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` | Server env | Encrypts stored OAuth tokens at rest. Losing it means reconnecting the accounts |
| `REDACT_ENV_FILES` | You | Server env | Extra env files whose values are redacted from agent transcripts before they are archived |
| `TS_AUTHKEY`, `TV_PASSWORD`, `WIFI_PASSWORD` | You, for the TV kiosk | Your laptop `.env`, only while flashing | The auth key is one-off and deleted from the Pi after it joins; only a hash of the password goes on the card |

## Changing a setting safely

| Change | Then |
|---|---|
| Anything in `.env` on a laptop | `secondbrain restart` |
| Anything in `/etc/secondbrain/env` | `ssh my-server 'systemctl restart secondbrain'` |
| `MODULES` on the server | Also `DEPLOY_MODULES` in the laptop `.env`, then `deploy.sh`, so the timers follow |
| `secondbrain.json` | Commit and push; the server's pull brings it. The app reads it once at start, so restart on each machine |
| `AGENTS.local.md` or `.agents/guard.local.json` | `secondbrain-vault rules` for the first; the guard reads the second on every call |
| A key you suspect leaked | Rotate it at the provider first, then replace it in each env file, then restart. Never commit the old one to "fix" history |

## Rotating and auditing

Keep a short note in your vault, in `Areas/` and without values, of every key you have issued: name, provider, which machine's env file holds it, when you last rotated it. The vault's own search then answers "what has access to what" without opening a single env file. The agent ledger's `--redact-env` and the server's `REDACT_ENV_FILES` only know about the files you name; a key that lives in a file you did not name is a key that can end up in a transcript.

Next: [Orchestrate agents](09-orchestrate-agents.md).
