---
name: fact-check
description: Verify the factual claims in one finished output (a stand-up, research note, ingest note, blog post, dev log) against its sources, and return an evidence table with a verdict per claim. Use as the last step of any skill whose output the user reads without checking, or when asked to "fact-check", "verify the claims in", or "check this against the sources". Reports only; never edits the output.
---

# Fact-check

Shared by Claude Code (through the read-only `fact-checker` subagent in `.claude/agents/`) and Hermes (read from `.agents/skills/` through `skills.external_dirs`).

The writer can't grade its own work. This skill is the separate check: every factual claim in the output is traced to a source the checker actually opened, or it is flagged.

## Inputs

The caller must pass:

1. **Output**: the path of the file to check (or the text, if it isn't saved yet).
2. **Sources**: the files, URLs or context pack the output was written from. For a daily briefing this is its context pack; for a research note, the URLs in its Sources section.
3. **Scope** (optional): which sections to check. Default: all of it.

If the sources aren't given, ask for them or report every claim `unresolved`. Never check claims against memory.

## Procedure

1. Read the output. List every **checkable claim**: names, dates, numbers, prices, versions, quotes, "X did Y", "X supports Y", file paths, commands. Skip opinions, recommendations and the author's own plans.
2. For each claim, open the source it should come from and find the supporting passage. Search the source; don't skim.
3. Give one verdict:

| Verdict | Means |
|---|---|
| `verified` | An opened source says this. Quote or cite the line |
| `incorrect` | An opened source says something different. Give the source's version and the correction |
| `unresolved` | No opened source supports or contradicts it. Name the evidence that would settle it |

4. Check the claims **next to** each `incorrect` one too. A wrong date often means a wrong sentence.

## Output

Return exactly this, and nothing else:

```markdown
### Fact-check: <output path>
Checked: YYYY-MM-DD · Claims: N · verified V · incorrect I · unresolved U

| # | Claim (short) | Verdict | Source (path:line or URL) | Correction / missing evidence |
|---|---|---|---|---|
| 1 | ... | verified | ... | |
| 2 | ... | incorrect | ... | Source says ... → change to ... |
| 3 | ... | unresolved | - | Needs ... |
```

## Rules

- **Read-only.** Never edit the output or the sources. The caller applies corrections.
- Every `verified` and `incorrect` row names a source the checker opened in this run. A confident verdict with no source is `unresolved`.
- Keep claims short in the table (under ~15 words) and don't paste long source passages.
- No secrets in the table. If a claim involves a key or token, check its existence, not its value.

## How callers use the result

| Caller | What it does with the table |
|---|---|
| A daily briefing | Drops every bullet marked `incorrect` or `unresolved` before delivering, and ends with "N items dropped as unverifiable" when N > 0 |
| Research and ingest notes | Applies corrections, then moves `unresolved` items into the note's "What's confirmed vs. inferred" section and open questions. No separate checks file |
| Blog posts and public copy | Applies corrections; any `unresolved` claim is either cut or sourced before publishing |
