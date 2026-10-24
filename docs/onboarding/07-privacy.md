# Privacy: what stays, what leaves, and how to keep it that way

This page is for the person running a vault. It lists every place your data can go, which of them are on by default, and the habits that keep a private vault private. The maintainers' side, how the public engine stays free of personal data, is [privacy.md](../privacy.md).

## The default: everything stays on your machine

With a fresh vault and no keys in `.env`:

| Data | Where it is | Who can reach it |
|---|---|---|
| Your notes | Markdown in the vault folder, and your private git remote if you pushed | You, and whoever can read that remote |
| The index | A local Postgres database | Processes on your machine |
| The app | `127.0.0.1:5123`, no login | Your browser. Loopback is the boundary; the app never binds another interface |
| Agent transcripts | Wherever your harness keeps them (`~/.claude`, `~/.hermes`) | Your user account |
| Guard blocks | `~/.cache/agent-guard.log`: timestamp, agent, tool and the reason | Your user account |

There is no telemetry, no account and no phone-home anywhere in the engine.

## What leaves, and when you turned it on

Each row is off until its setting exists. Decide per row.

| You set | What leaves your machine | Goes to |
|---|---|---|
| `TOGETHER_API_KEY` | The text of note chunks, for embeddings; your question and the table schema, for the database page's question-to-SQL box | Together AI |
| The embeddings provider set to `ollama` | Nothing. Embeddings run on your machine or your server | Your own Ollama |
| `DEPLOYMENT=server` and a deploy | The whole vault checkout and index live on that server, behind a password + authenticator login over HTTPS | Your server |
| `SECONDBRAIN_DB_URL` | Queries from the laptop to the server's Postgres | Your server, over the private network you chose |
| The agent ledger on a machine | Every turn of every agent session on that machine: prompts, responses, tool calls and results, tokens, model. Values of secret-named variables in the env files you named with `--redact-env` are removed first | Your server (module `usage`) |
| The ledger's `--proxy` | Each Claude Code API call, with its system prompt and tools, stored once by hash on the machine; synced only when `--redact-env` is set | Your server |
| `metrics[]` with `collect` in `secondbrain.json` | Requests to YouTube, X, Instagram or a chain RPC for the numbers you listed | Those platforms |
| `livestream.*` in `secondbrain.json` | Polls of your channels; a summary JSON (viewers, hours) served **without login** under `/public/` | Those platforms; anyone with the URL |
| `LINKEDIN_*`, `BUFFER_API_KEY` | The posts you queue, with their media; for relayed posts, a media URL Buffer fetches from your server | LinkedIn, Buffer, the networks behind it |
| Claude Code or Hermes themselves | Whatever the agent reads goes to its model provider, as with any use of that harness. The guard keeps secret files out; the rules keep output small | Your model provider |

The last row is the one to think about most. An agent that reads your notes sends them to a model. That is what you asked it to do, and it is the same trade as pasting a note into a chat window. The engine's job is to make sure it is only ever the notes, never the keys.

## The habits that matter

**Keep the vault remote private.** The vault is your life. A public vault repo is the one mistake nothing here can undo. Check the remote's visibility before the first push, and again before you add a collaborator.

**Never commit `.env`.** The template's `.gitignore` covers `.env` and `.env.*` from the first commit. Verify once: `git check-ignore .env` prints `.env`. If a key ever lands in a commit, rotate it first and clean history second; a rotated key is useless, a cleaned history is not proof.

**Let the guard do its job.** When an agent says `guard:` blocked something, it was about to put a secret into a transcript, force-push, or sync destructively. The fix is to do the work another way (a script, a sourced env, a dry run), not to disable the rule. Only `rsync_dry_run` can be disabled, and only on purpose in `guard.local.json`.

**Give agents a user, not your user, for anything that matters.** The hooks check the text of tool calls. A script an agent writes runs as the Unix user and reads what that user can read. Signing keys, other people's data and production credentials belong under a different user or on a different machine.

**Use the server login as designed.** One user, scrypt password plus TOTP, `__Host-` cookie, origin check on every write, lockouts on repeated failures, `POST /api/auth/logout-all` to end every session. Put the authenticator secret in your password manager at `auth-setup` time; re-running `auth-setup` is the only other way back in.

**Mind what is public on purpose.** Two things are served without a session when their module is on: the livestream summary JSON (no private data) and, briefly while a post publishes, a media file behind an unguessable token for Buffer to fetch. Nothing else is.

**Keep module data backed up.** Notes are in git. Tracker rows, board messages, usage and ring data exist only in Postgres. `DEPLOY_DB_BACKUP=1` installs a nightly dump; keep it somewhere encrypted.

**Scrub before you share.** Bug reports, screenshots, pasted errors: no paths with your name, no hostnames, no note contents. The maintainers run a leak check on the engine; nothing runs on what you paste into an issue.

## Checklist

- [ ] The vault remote is private.
- [ ] `git check-ignore .env` prints `.env`; `git ls-files | grep -c '^.env$'` prints 0.
- [ ] Inside each agent, `cat .env` is refused with a `guard:` reason.
- [ ] You know which rows of the "what leaves" table you have turned on, and you are fine with each.
- [ ] On a server: HTTPS answers, the login asks for both factors, and Postgres is not reachable from the internet.
- [ ] Every agent machine's ledger install named its env files with `--redact-env`.
- [ ] The authenticator secret and the `AUTH_*` lines are in your password manager.
- [ ] A nightly database dump exists if you use any module that stores records.

Next: [Configuration and secrets](08-config-and-secrets.md).
