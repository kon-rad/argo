# Skills: library, assignments, versioned deployments

Status: **pilot** - the `skills` addon: catalog, policy, lifecycle and machine reconciliation work and are tested; off by default, and every runtime keeps its legacy behaviour until a vault turns management on.

The `skills` addon answers four questions about the [Agent Skills](https://agentskills.io/specification) packages your agents use:

1. **What exists?** Every package in the vault's skill folders, the engine and any extra roots you list, with its full content digest, Git revision, dirty state and validity. Overrides and duplicates are shown side by side.
2. **Who gets what?** A Git-tracked policy grants skills to the organization, a team or an agent. Denial wins. Each agent and skill pair is explained.
3. **What is installed where?** `secondbrain skills sync` deploys the exact approved packages into a managed folder on each machine and acknowledges the digests to the app. The Machines page compares what is wanted with what each machine reported.
4. **How do I change a skill?** Drafts, previews and proposed changes, applied as a Git branch for your normal review. Nothing becomes active without that review.

It is not a sandbox. A catalog decides what an agent is *offered*; it does not stop a process with file or shell tools from reading other folders (see [Runtime support](#runtime-support)). Skill availability never grants tool, credential or publishing authority; those stay in the org config and the guard.

## Turn it on

1. Add `"skills"` to `addons` in the vault's `secondbrain.json` (or to `MODULES`). The app gets a **Skills** link under Work and the `/api/skills` routes; `secondbrain skills` and the `cli-skills` wrapper become available.
2. That is all for read-only use. Without a policy file the mode is **legacy**: every runtime keeps discovering every skill in its own folders, exactly as before, and the app only shows what exists.
3. To manage assignments, add the policy file (below) with `mode: managed` through your normal review. Only then do grants, denials and lifecycle states take effect, and only for runtimes that read a generated view.

## Where packages come from

| Source | Default folder | Layout | Precedence |
|---|---|---|---|
| `private` | `.agents/skills` (`skills.privateRoot`) | `<name>/SKILL.md` | 1 (wins) |
| `engine` | the engine's `skills/` | `<name>/SKILL.md` | 2 |
| `legacy` | `.hermes/skills` (`skills.legacyRoot`, `null` to skip) | `<category>/<name>/SKILL.md` | 3 |
| `external` | each `skills.externalRoots[]` entry | `<name>/SKILL.md` | 4, in listed order |

Home folders (`~/.claude/skills`, `~/.hermes/skills`) and plugin caches are never scanned unless you list them as external roots.

Categorized roots may nest categories up to six levels. Hidden folders (including `.archive`), dependency/cache folders and linked category folders are not traversed. A root reports its limit or read error rather than silently claiming a complete inventory.

Each candidate has a source-qualified id (`private:report`, `engine:report`, `legacy:media/report`, `external:<id>:report`). The effective package for a name is the highest-precedence candidate, matching the runtimes' "first folder wins". A private folder that is a `secondbrain-vault link-skills` link to the engine package is the same package (`linkOf`), not an override.

### Package identity

The digest covers **every file** in the package, scripts, references and assets included:

- files are sorted by package-relative path; for each, `path \0 x|- \0 size \0 sha256(content) \n` is hashed with SHA-256; the result is written `sha256:<hex>`;
- `.git`, `.DS_Store`, `__pycache__`, `node_modules` and `*.pyc` are not part of a package;
- a package is **invalid** (listed, never deployed) when it has no `SKILL.md`, a frontmatter error, no `name`/`description`, a symlink that resolves outside the package, a directory symlink, a special file, a secret-like file (`.env`, `*.pem`, `*.key`, `id_rsa*`, `credentials.json`, `.npmrc`, `.netrc`, ...; never read), or exceeds 1000 files, 10 MiB per file, 50 MiB in total or 12 levels;
- a package folder that is itself a link must land inside a configured root.

zen-agent computes the same digest (`zen-agent/src/skillpkg.ts`); both test suites check one shared vector.

Git provenance comes from the repository that holds the files: the last commit touching the package (`revision`), whether it has uncommitted changes (`dirty`), and whether it is tracked. A root outside Git shows these as unknown.

### Management metadata (optional)

Kept under the open format's `metadata:` key, so a package stays valid for any other client:

```yaml
---
name: clip
description: Cut a clip from a recording. Use when asked to trim or excerpt a video.
metadata:
  version: "2"
  owner: media
  depends: [report]            # reported, never granted implicitly
  requires:
    bins: [ffmpeg]             # checked on PATH at sync time
    env: [VIDEO_API_KEY]       # names only; values are never read or copied
---
```

## The policy

One YAML file in the vault's Git history, default `.agents/skills-policy.yaml` (`skills.policyFile`). Git is its history and its review route; the database never holds an editable copy.

```yaml
version: 1
mode: managed                 # legacy (default) | managed
org:
  grant: [fact-check]         # every agent
  deny: []
teams:
  media: { grant: [clip, video] }
agents:
  writer-1: { grant: [ingest], deny: [video] }
lifecycle:
  video: { status: deprecated, replacement: clip, note: "merged into clip" }
pins:
  report: "engine:report"     # deploy this candidate instead of the effective private override
```

- Grants come from the org, the agent's team and the agent. `*` means every catalogued name.
- **A denial at any level wins** over every grant.
- `disabled` and `removed` skills are unavailable to everyone; `deprecated` ones stay assigned with a warning.
- A granted skill whose package is missing or invalid is **unavailable**, with the reason.
- A policy that does not parse fails closed: nothing is granted and `sync` refuses to deploy, leaving existing deployments as they are.
- `knowledge:` paths in the org config that point into a skills folder are shown as **references**. They are never grants.

### States the app keeps apart

| State | Meaning | Evidence |
|---|---|---|
| Reference | Named in the agent's knowledge paths | org config |
| Assigned | The policy offers it to the agent | policy + catalog |
| Installed | The machine acknowledged that digest in the agent's view | acknowledgement |
| Ready | Installed, and the machine reported no missing program or variable | acknowledgement |
| Loaded | A session actually used it | only a recorded source: today, a `Skill` tool call in a session summary (name only; the revision is not recorded there), or a successful Zen trace `toolResult` for `read_skill`, whose details identify the package digest and revision |

The app never shows "loaded" without one of those records.

## Runtime support

| Runtime | Support | What it means |
|---|---|---|
| zen-agent | catalog-filtered | With `managedSkills` in `zen.json`, a run reads its persona's view, verifies every package digest, copies the packages into an immutable per-run snapshot, and lists and loads (`read_skill`) only those. The trace's meta line records `skills_packages` (name, id, digest, revision). Legacy folders are not also read. File and shell tools can still read other folders. See [zen-agent](zen-agent.md#37-managed-skills). |
| Claude Code | catalog-only | `secondbrain skills view-path <agent> --runtime claude-code` prints a generated folder of that agent's skills to point a project's `.claude/skills` at. Global and project skill folders stay visible and files stay readable. |
| Hermes | catalog-only | Point `skills.external_dirs` at `secondbrain skills view-path <agent> --runtime hermes`. Profile-local skills stay visible. |
| Codex | catalog-only | `secondbrain skills view-path <agent> --runtime codex` prints a verified folder to link as `.agents/skills` in a separate workspace. Existing project and user folders remain visible; the manager does not enforce native Codex isolation. |
| Others | none | No adapter; the runtime loads what its own configuration says. |

Old callers keep working: nothing moves or rewrites `.agents/skills`, `link-skills` or the runtimes' own folders. Scripts that call a skill's files directly bypass any catalog.

For a Codex catalog, create a separate workspace with `.agents/skills` pointing to the printed view path, and start the runtime there. Add the code checkout separately if needed. Do not replace the vault's existing `.agents/skills`: it is an authored package source. This adapter generates and verifies packages; it does not automatically configure or restart native sessions, suppress their global skills, or claim that a session loaded a package without telemetry.

Package validation rejects credential filenames (including `auth.json` and `.credentials.json`) before reading their contents. Resolved aliases may not target ignored directories or credential paths. The detail and file APIs apply the same path checks at read time, so a rejected package or a file replaced by a link is not an alternative route to its contents.

Bundles and generated stores are stricter: every file must participate in the approved digest. Ignored paths, credential names, duplicate entries and unlisted staging files are refused. A failed deployment preserves the previous view. Remote acknowledgements require HTTPS; HTTP is allowed only on loopback for development, and redirects are refused.

Standalone acknowledgements recheck prerequisites from verified installed metadata. A changed policy digest produces drift even if the selected package digests happen to be identical. Removal checks include wildcard grants; explicitly resolving one skill adds a denial without removing the wildcard's grants to other skills. A create proposal refuses an occupied destination instead of replacing a newer package.

## Changing skills

The app and `secondbrain skills` call the same service. It writes only into two vault folders:

- **Drafts** (`skills.draftsDir`, default `.agents/skill-drafts/<name>/`): a package being edited. It is not in any skill root, so no runtime ever loads it. Saving a draft saves the draft, nothing else.
- **Proposed changes** (`skills.changesDir`, default `.agents/skill-changes/<id>/`): the target package and/or policy file, the digests they were made against, and the preview.

| Action | Effect when merged and synced |
|---|---|
| create | A new private package from a draft (may override an engine or legacy one; the preview says so) |
| update | Replace the package with the draft; refused if the package changed since the draft started |
| disable | No new run receives it |
| deprecate | Still assigned, with a warning and an optional replacement |
| restore | Back to active |
| remove | `lifecycle: removed`; refused while any grant, pin or dependent skill references it, unless you confirm revoking the grants in the same change. Package files and their Git history are kept; machines delete only the copies the manager deployed |
| rollback | The package's files at an earlier Git revision |

Every action shows a preview first: the file diffs, the policy diff, affected agents and acknowledged hosts, dependents, validation, blocking reasons and the running-session note. **Preview writes nothing.** "Export for review" writes a proposed change and says so; it is not applied.

```
secondbrain skills draft new report --from report
secondbrain skills draft write report SKILL.md --file ./SKILL.md
secondbrain skills preview update report          # nothing saved
secondbrain skills propose update report          # exported for review, not active
secondbrain skills apply <change-id>              # commits on branch skills/<id> in a temporary worktree
git push -u origin skills/<change-id>             # then review and merge as usual
```

`apply` never touches your checkout or your current branch, never pushes and never merges. A change whose base moved is **stale** and must be proposed again.

Running sessions: a change applies to new runs after it is merged and the machine syncs. zen-agent runs keep their pinned snapshot until they end; other runtimes keep instructions already in context. Stop or restart a session to drop a revoked skill. An offline machine keeps its last deployment until it syncs.

## Deploying to machines

```
<managed root>/store/<hex>/                 one package per full digest, read-only
<managed root>/views/<agent>/<runtime>      symlink to the active generation
<managed root>/views/<agent>/<runtime>.<gen>/manifest.json, <name> -> ../../../store/<hex>
```

The default managed root is `~/.local/share/secondbrain/skills` (`skills.managedRoot`, or `--root`).

`secondbrain skills sync` resolves the managed policy for the selected agents (default: every agent with an adapter runtime), stages each package, verifies its full digest, builds a new generation, verifies it again through its own links and switches the view with one atomic rename. If anything fails, the previous view stays active and the staging area is removed. A view whose deployed files were modified on the machine is reported **dirty** and left as is; `--repair` moves the modified store folders to `quarantine/` and redeploys. A folder under `views/` that the manager did not create is never replaced. Programs and environment variables a package declares are checked and reported, never installed or copied.

### Two hosts

Host A has the vault checkout; host B is a machine without one. The transport between them is yours (no route accepts a shell or SSH command).

```
# on the server: one device token per machine (shown once)
secondbrain ingest-device add host-a --display "Host A" --kind laptop
secondbrain ingest-device add host-b --display "Host B" --kind server

# host A: from its own up-to-date checkout
git -C /path/to/vault pull
SB_LEDGER_TOKEN=sbd_... secondbrain skills sync --ack --server https://brain.example.com

# host A: a bundle for host B, copied by you
secondbrain skills pack --out skills-bundle.json --agents writer-1,ops-1
scp skills-bundle.json host-b:

# host B
SB_LEDGER_TOKEN=sbd_... secondbrain skills sync --bundle skills-bundle.json --ack --server https://brain.example.com
secondbrain skills status
```

A host with a vault checkout can run `sync` itself instead of using a bundle. Bundles carry package files and digests only; packages cannot contain secret-like files.

### The acknowledgement

`POST /api/skills/ack`, `Authorization: Bearer <device token>`, JSON at most 256 KB:

```json
{ "v": 1, "engine": "<build>", "policyDigest": "sha256:...",
  "views": [{ "agent": "writer-1", "runtime": "zen-agent", "viewDigest": "sha256:...", "generatedAt": "...",
              "status": "current|dirty|failed", "error": null,
              "skills": [{ "name": "clip", "id": "private:clip", "digest": "sha256:..." }],
              "missing": [{ "skill": "clip", "bins": ["ffmpeg"], "env": ["VIDEO_API_KEY"] }], "dirty": [] }] }
```

The token decides the host; the body cannot name one (unknown keys are rejected). At most 64 views and 500 skills per view. The server keeps the latest acknowledgement per host, agent and runtime, and a log of the newest 200 per host.

### What the Machines page shows

| Status | Meaning |
|---|---|
| current | The last acknowledgement matches what the policy wants now |
| drift | A skill's acknowledged digest differs, is missing or is no longer wanted |
| dirty | The machine reported modified deployed files |
| failed | The machine's last sync failed; its previous deployment is still active |
| stale | No acknowledgement within `skills.staleAfterHours` (default 24) |
| never | A registered host that never acknowledged: unknown, not "synced" |

A Git push or merge never marks anything synced. Revocation reaches a machine only when it syncs.

## API

All under `/api/skills`, behind the login, except `/ack`:

| Route | Returns |
|---|---|
| `GET /` (`?refresh=1`) | the library: roots, policy status, every skill with candidates and flags |
| `GET /skill/:name` (`?id=`) | detail: candidates, instructions, files, history, agents, hosts, drafts, changes |
| `GET /skill/:name/file?path=&id=` | one package file (text up to 512 KB, or "binary"); only files the scan listed |
| `GET /matrix`, `GET /agents/:agent` | assignments with reasons |
| `GET /machines` | desired vs acknowledged per host |
| `GET/POST /drafts`, `GET/DELETE /drafts/:name`, `GET/PUT/DELETE /drafts/:name/file` | drafts |
| `GET /changes`, `POST /changes/preview`, `POST /changes` | proposed changes (409 when blocked) |
| `POST /ack` | device-token acknowledgement |

Contracts: `app/shared/skills.ts` (`@secondbrain/contracts/skills`).

## Configuration

`secondbrain.json`, all optional:

```json
{
  "addons": ["skills"],
  "skills": {
    "policyFile": ".agents/skills-policy.yaml",
    "privateRoot": ".agents/skills",
    "legacyRoot": ".hermes/skills",
    "externalRoots": [{ "id": "team-shared", "path": "/srv/shared-skills", "label": "team shared" }],
    "draftsDir": ".agents/skill-drafts",
    "changesDir": ".agents/skill-changes",
    "managedRoot": "~/.local/share/secondbrain/skills",
    "staleAfterHours": 24
  }
}
```

Environment, on a machine that acknowledges: `SB_LEDGER_TOKEN` (its device token; or `--token-file` with mode 600) and `SECONDBRAIN_SERVER` (or `--server`).

## Fixture startup (for checking the pages)

```
cd app
npx tsx server/test/helpers/skills-demo.ts /tmp/skills-demo --db    # DATABASE_URL pointing at a scratch database with migrations applied
VAULT_ROOT=/tmp/skills-demo/full/vault MODULES=skills npm run dev    # library, detail, matrix, machines, a draft and a proposal
VAULT_ROOT=/tmp/skills-demo/empty MODULES=skills npm run dev         # empty states
VAULT_ROOT=/tmp/skills-demo/broken/vault MODULES=skills npm run dev  # an unparseable managed policy
```

The `full` vault has a private override with engine and legacy duplicates, a link-skills link, invalid packages (missing description, bad YAML, an escaping symlink, a `.env` file, a package link outside the roots), a deprecated skill, three agents on three runtimes, a draft and a proposed change. With `--db`, the Machines page shows one current host, one drifted host and one registered host that never acknowledged.

## Limits of this release

- Catalog filtering only; no isolation of file, shell or network access.
- Claude Code and Hermes get a generated folder; pointing them at it is a per-machine configuration step, and their other skill folders remain visible.
- "Loaded" evidence for Claude Code is name-only (session summaries); zen-agent traces record exact digests but are not yet ingested into the app.
- External acquisition (marketplaces, publisher verification) is out of scope; the optional skillreg design is a possible future adapter.

### Review and resume guarantees

Draft exports from the app carry the digest shown by the preview. Saving a draft dismisses that preview; an export with an older digest is refused. Ignored package members cannot be saved to drafts, and an existing ignored member makes a draft invalid instead of silently disappearing.

A managed Zen session records its snapshot identity in its trace. Resume requires that original snapshot, including when management has been disabled or the current view has changed. A missing snapshot exposes no skills until the original is restored. A merge changes source and policy; machine adoption is established separately by sync acknowledgements.

The acknowledgement protocol accepts at most 64 views per request. A root with more views fails acknowledgement explicitly; divide selected agents/runtimes into separate managed roots and acknowledge each. No view is silently omitted.

`skills_packages` in Zen session metadata records the resolved catalog, not use. Only successful `read_skill` tool results prove a read. Managed instruction reads verify the full package again before returning bytes.

Removal previews and proposals require authoritative deployment observations; unavailable operational state fails explicitly. Policy-selected pinned packages contribute dependencies. A failed sync retains unresolved assigned-package names and reasons in its report and acknowledgement and preserves the previous generation. Intentional denials and lifecycle revocations are omitted deliberately. Standalone acknowledgements preserve the last failed attempt until a successful sync.

The app also binds every lifecycle export to a fingerprint of the inspected preview, including its source, policy and affected machines. If those inputs change, the owner must preview again before exporting.
