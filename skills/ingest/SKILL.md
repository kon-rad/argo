---
name: ingest
description: Ingest one piece of content (blog post, article, YouTube video, podcast, PDF, paper, thread) into the vault as a single markdown note with a 1-sentence summary, a 5-sentence summary, and 5 key insights, each tied to the owner's own recent work and thinking. Use when the user says "ingest this", "/ingest <url>", "copy this post into research/<folder> and summarize it", or hands over a link and asks how it relates to what they're working on.
---

# Ingest

One piece of content in, one markdown note out. The note should be worth rereading: tight summaries, then insights that connect the source to what the owner is actually building, with real wikilinks, not generic takeaways.

The vault's `AGENTS.md` governs everything here: markdown only, absolute dates, never invent figures.

## Inputs

- **Source**: a URL (blog, article, YouTube, podcast page, PDF link) or a local file path.
- **Destination** (optional): a folder. If none is given, choose it: an author folder if one exists (`Research/<author>/`), otherwise a topic folder, otherwise ask.

Resolve the folder against the real tree with `find` first; create intermediate folders only when they're genuinely missing.

## Step 1: Fetch and read the whole source

Work in a scratch directory, not the vault.

| Source | How |
|---|---|
| Web page / blog | `curl -sL -o post.html <url>`, then strip to text with a small Python `re`/`html` script. Read all of it, including tables |
| YouTube | `uvx --from youtube-transcript-api youtube_transcript_api <id>` for captions, `yt-dlp --dump-json` for title, channel, date and runtime |
| PDF | Read it page by page |
| Local file | Read it |

If the fetch fails or is paywalled, say so. Don't summarize from memory or the title.

## Step 2: Decide what gets stored

**Don't copy third-party text into the vault in full**, even if asked to "copy this post". Store metadata, a link, the summaries, the insights and a few short attributed quotes (a sentence or less each). Say in the note's header that the source text isn't reproduced and link it, and say so in the final reply.

A full copy is fine only for the owner's own content (their talks, drafts, transcripts of their own videos).

## Multi-part sources (books, serials, course series)

1. Create a folder named after the work (`Research/<work-slug>/`), not a single file.
2. Fetch every part and **read all of them** before writing. Don't summarise parts you only skimmed.
3. Write one note per part, `chapter-NN-<kebab-title>.md`, as a progressive summary: one sentence, a ~150-word summary, bullets, an "Ideas in play" table, a running "Story so far" line, at most two short attributed lines. Link prev / next / the summary.
4. Write `<work-slug>-summary.md` with the Step 4 template (the five insights live here), plus a chapter index table and a glossary.
5. An open licence (GPL, CC) doesn't change Step 2. Record the licence and keep to summaries plus short quotes.

## Step 3: Gather the owner's recent work and thinking

This is what makes the insights specific, so don't skip it. A few tool calls:

1. `git log --since="<today − 30 days>" --pretty='%ad %s' --date=short | head -40`: what was shipped.
2. The owner's working files, if the vault has them (a todo list, a goals file: `goalsFile` in `secondbrain.json`, a priorities note). Read their heads.
3. `find Research Projects Areas -name '*.md' -mtime -30` (skip dot folders and code): recent notes. Read the heads of the 4 to 6 most related to the source's themes.
4. Every sibling note in the destination folder, plus a `grep -ril` for 2 to 3 key terms from the source across `Research/ Projects/ Areas/`.

## Step 4: Write the note

**Filename:** kebab-case title. Add the publication date if the source is dated. Follow the neighbouring convention in the folder.

**Template:**

```markdown
# <Title as published>
### <One-line subtitle: the source's core claim, in plain words>

**Author:** <name>   (or **Channel:** / **Speakers:** for video)
**Published:** YYYY-MM-DD
**Source:** <url>
**Ingested:** YYYY-MM-DD
**Length:** <words or runtime>
**Source text:** Not copied into the vault. Summaries and short attributed quotes only. Read the original at the link above.

---

## One sentence
<One sentence, and it may be long. The thesis plus the reason it matters.>

## Five sentences
1. … (the argument in order: setup, main claims, implications, conclusion. Specific numbers, names and dates from the source.)

---

## Five key insights, and how they connect to my work

### 1. <Insight as a claim, not a topic label>
<2 to 4 sentences on what the source says and why it's non-obvious.>

**Connection:** <Name the specific project, note or todo and say concretely what it changes: a design constraint, a gap, a validation, a content idea. Use [[wikilinks]] to real notes. Mark which insight is **most likely to change the plan**.>

(× 5)

---

## Short quotes worth keeping
- "…" (at most 4 quotes, each under ~20 words)

## What's confirmed vs. inferred
| Confirmed (from the source) | Inferred (my reading) |
|---|---|

**Open questions:** …

## See also
- [[sibling notes]], [[related project notes]]

## Sources
- Primary: [Title](url) (author, date)
```

## Rules for the insights

- **Each connection must name something real** found in Step 3: a file, project, todo or decision. If an insight has no real connection, say so briefly, or pick a different insight. Don't invent a link.
- Aim for a mix: at least one insight that **validates** current work, one that **exposes a gap or risk**, and one that is a **content or action idea**.
- Flag exactly one as **most likely to change the plan**.
- Where the source updates or contradicts an earlier note in the vault, say so and link it.
- Write in the owner's register (see `AGENTS.local.md`): direct and specific. Name the trade-off instead of listing options.

## Finish

1. Check that each `[[wikilink]]` target exists (`find . -name '<target>.md'`) and fix or remove any broken ones.
2. Reply with the note's path, the one-sentence summary, the insight flagged "most likely to change the plan", and a line saying the source text wasn't copied in full, if that applies.
3. Don't commit unless asked.
