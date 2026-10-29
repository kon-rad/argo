# Privacy: keeping the engine clean

This repo is public. The vaults that use it are private and full of someone's life. This page is how the two stay apart, for the people who maintain the engine and for anyone keeping a fork.

## The contract

**The engine never contains anything that would differ between two users.** If a value is about a person, a machine or an account, it is read from the vault at run time, with a default that works for a stranger, or the feature is off.

| Kind of thing | Lives in | Never in the engine as |
|---|---|---|
| Secrets (API keys, password hashes, tokens) | Vault `.env`, server `/etc/secondbrain/env` | A default, a fixture, a comment |
| Per-machine settings (hosts, origins, paths, names, modules) | The same env files | A hardcoded host, IP, home directory or username |
| Structured personal settings (accounts, channels, folders, shows) | `secondbrain.json` in the vault | A list in code |
| Agent rules about you | `AGENTS.local.md` | Lines in `AGENTS.base.md` |
| Your guard rules | `.agents/guard.local.json` | Entries in `guard.py` |
| Your skills | The vault's `.agents/skills/` | Folders in `skills/` |
| Notes, media, real data | The vault and its backups | Test fixtures: write fake data |

## The checks

Every pull request and every push to `main` runs them in CI. Run them locally too, before you push.

| Check | Catches | Run it |
|---|---|---|
| `scripts/check-public.sh` | Real IPv4 addresses (anything outside `127.0.0.1`, `0.0.0.0` and the RFC 5737 documentation ranges), email addresses, Telegram-style chat IDs, and every line of your private denylist | `scripts/check-public.sh` (whole repo) or `scripts/check-public.sh <paths>` |
| gitleaks | Keys and tokens, over the whole git history | `gitleaks detect --source . --log-opts=--all --redact` |

### Your private denylist

The generic patterns can't know your name, your hosts or your folder names. Put those in `~/.config/secondbrain/denylist.txt`, one fixed string per line (`#` starts a comment), or point `SB_DENYLIST_FILE` at another file:

```
# names
Jane Example
# hosts and paths
my-droplet
/Users/jane
```

**The denylist is never committed**, so CI can't run it: only you can. Make it a habit to run `scripts/check-public.sh` before every push.

### When a match is fine

A line that is a reviewed, intentional public value (a project URL, a documentation IP in a test) can end in `# public-ok` (or `<!-- public-ok -->` in markdown). The scanner skips it. Use it sparingly and say why in the PR.

Vendored code (`node_modules`, `package-lock.json`) is skipped by the generic scans, since it carries its maintainers' contact details; the denylist still scans everything.

## What else becomes public

When a repo is public, more than the current files is visible:

- **Every branch**, not just `main`.
- **The full history.** Deleting a file in a later commit doesn't remove it from history.
- **Pull request titles, bodies, comments, and their commits.** GitHub keeps a ref for every PR's commits, and it can't be rewritten.
- **CI logs** of public workflow runs.
- **Commit author emails.** Set the engine checkout to your GitHub noreply address before you commit:

```bash
git -C .secondbrain config user.email "<id>+<user>@users.noreply.github.com"
```

## If something slips through

1. **Rotate the secret first.** Assume anything that reached a public repo has been copied. Rewriting history doesn't un-publish it.
2. Remove it from the current tree in a PR.
3. If it must leave history too, that means rewriting it (`git filter-repo`), and because PR refs can't be rewritten, possibly recreating the repo. Report security problems privately: see [`SECURITY.md`](https://github.com/kon-rad/argo/blob/main/SECURITY.md).
