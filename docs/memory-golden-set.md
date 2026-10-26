# The golden set: check that recall finds what you know is there

A golden set is a fixed list of questions whose answers you already know, each paired with a string that must show up in the top results. You run the list through `cli-org recall`, count how many questions found their answer, and run it again after anything changes. It is the cheapest way to turn "the agents have memory" into a number you can watch.

This page is the method. The stores it tests, and what each one costs the context window, are on [Memory, and how to check it works](memory.md).

## What it measures

| Number | Question it answers | How to get it |
|---|---|---|
| **hit@8** | Of the questions, what share found the expected string in the top 8 results? | Count the questions that are not `MISS`, divide by the total |
| **First-hit position** | When it was found, how far down? | The `first match at hit N` value; lower is better |
| **Characters returned** | What did the call cost the context window? | Length of the output; divide by four for a rough token count |

The third number matters as much as the first. A change that finds the same answers while returning less text is a win, and a change that raises hit@8 by pasting twice as much into the context is not obviously one. Retrieved text that is not relevant makes models worse, not neutral (see the context-rot checks on the memory page).

## Build the question list

A file with one case per line: the question, a pipe, and the expected string. These four are made-up examples of the shape; use your own.

```text
# questions.txt
why does cli-board return 401|BOARD_TOKEN
where do I put a new engine module flag|MODULES
how is the vault index rebuilt|embed
chocolate cake recipe zzzqx|
```

Rules that make the list worth running:

1. **Use a string only the right answer contains.** A path, a flag name or an unusual phrase. Short or common strings (`3`, `ring`, `63`) match by accident and make the score look better than it is.
2. **Write the question the way an agent would ask it, not the way the note is titled.** Paraphrases are where retrieval breaks. If every question reuses the note's own words, you are testing keyword search.
3. **Cover four kinds of case.**

| Kind | Example | A pass means |
|---|---|---|
| Known answer | The one place a rule lives | The expected string is in the top 8 |
| Paraphrase | The same fact asked in other words | Same |
| Abstain | A nonsense or unwritten topic | The call says nothing was found |
| Update | A fact that was corrected (`--supersedes`) | The new value shows up and the old one does not |

Abstain and update cases come from the way long-term memory benchmarks are built: [LongMemEval](https://arxiv.org/abs/2410.10813) tests information extraction, reasoning across sessions, reasoning about time, knowledge updates and knowing when not to answer. A recall that always returns something can never pass the last one.

15 to 30 questions is enough to catch a regression. Add a case every time recall fails you in real work.

## Run it

```sh
while IFS='|' read -r q expect; do
  case "$q" in ''|'#'*) continue ;; esac
  out=$(cli-org recall "$q" --limit 8 </dev/null)
  hit=$(printf '%s\n' "$out" | grep -E '^\[' | grep -n -i -F -- "$expect" | head -1 | cut -d: -f1)
  printf '%s | first match at hit %s | %s chars\n' "$q" "${hit:-MISS}" "$(printf '%s' "$out" | wc -c)"
done < questions.txt
```

Each result line starts with `[fact]`, `[memory]` or `[vault]`, which is what the `grep -E '^\['` keeps. The first matching line's position is the first-hit position.

For an abstain case (empty expected string), score it by hand: the output should be the single line `nothing found; try other words, or it is not written down yet`, and the character count should be tiny.

Two traps:

- **`</dev/null` is not optional when `cli-org` is reached through an ssh wrapper.** `ssh` reads the loop's stdin, so the loop quietly ends after the first question.
- **Run it as a role that can read the facts table.** The facts table has row-level security. A database role without access sees zero rows and raises no error, so the fact arm looks empty and every fact question becomes a `MISS`. Run from the server, or through a wrapper that connects as the right role.

## Read the result

Keep the output next to the date and the commit you ran it on. Then compare runs:

| You changed | Look at | A good result |
|---|---|---|
| The recall code | hit@8 and characters | hit@8 holds, characters fall |
| The embedding model or the index | hit@8 and first-hit position | No question that passed before now misses |
| The notes (a big reorganisation) | Every `MISS` | The expected string moved, so update the list, not the code |
| Nothing | Both | The same numbers; a drop means the data changed under you |

A miss has three possible causes, and the fix differs. Open the full `recall` output for that question: if the right note is present but ranked low, it is a ranking problem; if the fact exists but a different wording does not match, it is a matching problem; if nothing relevant exists, it was never written down.

## Calibrate before you set a threshold

Do not pick a cutoff from intuition and then write its test. Run the golden set, print the scores of the hits you want and the hits you do not, and see whether any value separates them.

On the vault this page was measured on, the embedding model (`multilingual-e5-large-instruct`) scored nearly everything between 0.78 and 0.89 cosine similarity: gibberish 0.80 to 0.85, an off-topic note 0.888, the relevant query 0.82. No fixed floor could keep the relevant hit and drop the noise, so a similarity floor of 0.4, written first, had to be thrown away. What worked instead was a rule about agreement: a hit found only by meaning is kept only when a keyword-backed hit sits beside it, and such hits fill at most half the quota. The floor still exists as an opt-in setting (`ORG_RECALL_MIN_SIMILARITY`) for embedders whose scores spread out.

## What one vault measured

On 2026-10-26, before and after the recall fixes, on one real vault. Read these as an illustration of the method, not as a benchmark.

| Probe | Before | After |
|---|---|---|
| 10 known-answer questions, expected source in the top 8 | 10 of 10 | 10 of 10 |
| Size of those answers | 4.2 to 5.0 KB | 3.1 to 5.1 KB (median about 12 percent smaller) |
| Two nonsense queries | 8 hits each | 0 hits (`nothing found`) |
| A fact question that used to return no fact | no fact | the right fact, first |

The expected strings in that check were loose, so it shows "nothing was lost", not a precision score. The first run, on the earlier code and with the same loose strings, found 9 of 10 known-answer questions and 5 of 10 paraphrased fact lookups.

## Make it routine

Today this is a script you run by hand. A weekly run that appends hit@8, mean first-hit position and mean characters to a small log, so a slow decline shows up as a line going the wrong way, is the obvious next step and is not built in the engine yet. Until then, run it before and after any change to recall, the index or the embedder, and paste both outputs into the pull request.

## Sources

- [LongMemEval](https://arxiv.org/abs/2410.10813), the benchmark behind the abstain and update cases (primary: the paper)
- [Context Rot](https://www.trychroma.com/research/context-rot), Chroma's report on how model quality drops as the input grows (primary)
- Engine code: `app/server/src/cli-org.ts` (`recallVault`), `app/server/src/org-powers.ts` (`shapeVaultHits`, `recallFactsLoose`)
- Related pages: [Memory, and how to check it works](memory.md), [Retrieval and the chat module](rag.md)
