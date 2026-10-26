# Agent summaries

One short, structured record for every finished agent session, on any harness and any machine, with the metrics counted from the transcript and the facts it learned held back until you approve them. It feeds three things: a daily digest for a stand-up, candidate facts for shared memory, and numbers you can compare before and after a change to your agents.

Module: `usage` (summaries add no module of their own). Timer: off until you set `SUMMARIES=on`.

## What you get

| Piece | Where |
|---|---|
| A summary per session: `request`, `done`, `learned`, `open_items`, `outcome` | table `agent_summaries`, written by `secondbrain summarize` |
| Counts the model cannot invent: files edited, cards, tools, skills, tokens, tool calls, failed tool results, duration | same row, `touched` and `metrics`, computed from the archive and the usage ledger |
| Facts a session proposes | table `agent_summary_facts`, status `proposed`, `promoted` or `rejected` |
| A page | `/usage?view=summaries` |
| A digest for a stand-up | `secondbrain summarize --digest 24`, or `GET /api/summaries/digest?hours=24` |
| Quality checks | `secondbrain summarize-eval` (below) |

Tokens by hour or day, by model, by provider and by harness are on the Usage tab. `provider` is a dimension there next to `model`, `runtime` (the harness) and `host`; Claude Code calls are `anthropic`, Hermes calls carry the provider Hermes billed.

## How it works

```
archive_sessions / archive_messages ──▶ finished sessions (quiet for 30 min, no new summary)
usage_calls                                   │ compact: prompts, responses, tool calls, failed results; keys redacted
                                              ▼
                     provider chain: local model ──▶ Together ──▶ OpenRouter   (first that returns valid JSON wins)
                                              │
                                              ▼
              agent_summaries (+ computed touched, metrics)   agent_summary_facts (proposed)
                                              │
              /usage?view=summaries ◀─────────┴────────▶ digest for the stand-up
                                                           promote ──▶ memory_facts (confidence: inferred, source: the session)
```

- **Which sessions.** Claude Code, Hermes and zen-agent sessions, interactive and headless. Claude Code subagents are skipped (their work shows in the parent's tool calls). A session with fewer than `minSteps` prompt and response steps is recorded as skipped, without a model call.
- **When.** A session counts as finished when nothing was added for `quietMinutes`. If it grows afterwards the next run rewrites its summary; an unchanged transcript costs nothing (a hash of the model's input decides).
- **Rebuildable.** A summary is derived data. Delete rows and the next run writes them again. Never edit one by hand.
- **Prompt version.** `v1`. A new version writes a second row per session beside the old one, so two prompts can be compared on the same sessions.

## The provider chain

The first provider that answers with valid JSON writes the summary; the others are skipped. A provider is skipped when its key is missing, it times out, errors, or answers with something that is not the summary schema, and the attempt is stored on the row (`attempts`) without any key.

Default (`app/config/summaries.json`):

| Order | Provider | Model | Notes |
|---|---|---|---|
| 1 | `ollama` (a home server) | `qwen3.6:35b-a3b` | Address from the variable `SUMMARIES_M1_URL`. Sends `reasoning_effort: "none"`, because a thinking model otherwise spends the whole token budget reasoning and returns an empty answer (measured: 218 tokens against 5 for the same prompt) |
| 2 | `together` | `deepseek-ai/DeepSeek-V4.1-Flash` | Needs `TOGETHER_API_KEY` |
| 3 | `openrouter` | `google/gemini-2.5-flash` | Needs `OPENROUTER_API_KEY`. Check the model id still exists before relying on it |

Change any of it in the vault's `secondbrain.json`:

```json
{
  "summaries": {
    "chain": [
      { "provider": "ollama", "model": "qwen3.6:27b", "baseUrlEnv": "SUMMARIES_M1_URL", "body": { "reasoning_effort": "none" } },
      { "provider": "together", "model": "deepseek-ai/DeepSeek-V4.1-Flash" }
    ],
    "minSteps": 4,
    "quietMinutes": 30,
    "maxInputChars": 24000
  }
}
```

A chain entry is a preset provider id from `llm-presets.json`, a model, and optionally `baseUrl` or `baseUrlEnv`, `timeoutMs`, and `body` (extra request fields). With no model reachable, `secondbrain summarize` exits 1 and the timer unit shows as failed; the sessions are tried again on the next tick.

## Run it

| Command | Does |
|---|---|
| `secondbrain summarize` | Summarize finished sessions from the last 48 hours (`--since H`, `--limit N`) |
| `secondbrain summarize --session ID --force --dry-run` | Re-run one archive session and print the result without saving |
| `secondbrain summarize --digest 24` | Print the markdown digest of the last 24 hours |

Install the timer: set `SUMMARIES=on` (and `SUMMARIES_M1_URL`) in the server's env file and run the deploy script. It runs every 30 minutes, 50 sessions at most per run. Summaries run on the machine that holds the archive.

## Memory: facts are candidates

The model may propose up to five facts per session. They sit in `agent_summary_facts` and are invisible to recall until you promote one on the page (or `POST /api/summaries/facts/:id/promote`). Promotion writes a `memory_facts` row with `confidence = inferred`, author `summarizer`, and the session as its source. A rejected claim is not proposed again for that session.

## Checking the quality

`secondbrain summarize-eval` has three modes.

| Mode | Model used | What it proves |
|---|---|---|
| `--references` | none | The checks themselves. Each golden case ships a hand-written summary that must clear its own bar |
| `--golden [DIR]` | the provider chain, and the judge with `--judge` | A model writes a summary of each golden transcript, which is graded |
| `--sample N` | the judge with `--judge` | The last N stored summaries, graded against their archived transcripts |

Add `--min 0.8` to fail below a mean score and `--out FILE` to save the markdown report.

**Deterministic checks (no model).** Paths, card ids and numbers of three digits or more named in a summary must appear in its transcript; each proposed fact must be mostly made of words the transcript contains; no key-shaped string, em-dash or markdown; under 2,400 characters; `finished` is not allowed when the last three tool results all failed or the agent never answered.

**Golden cases** (`app/server/test/fixtures/summaries/*.json`) are invented transcripts with expectations: the right outcome, phrases that must appear, claims that must not (a blocked deploy is never "deployed successfully"), and the exact files and cards the tool calls touched. Add your own folder with `--golden DIR`; use fake data in anything you commit.

**Judge.** A model scores faithfulness, completeness, concision and outcome from 1 to 5 against the transcript, with faithfulness counted double. It never decides alone, and a judge from the same model family as the writer is biased towards it: point the judge at a different chain when you can.

The score is the mean of the parts that ran. Treat the deterministic checks as the gate and the judge as a second opinion.

## Privacy

Compacted transcripts leave the machine only for the providers in your chain, in order. A local first provider means nothing leaves while it is up; the fallbacks are paid APIs and do receive the compacted text. Keys are removed before sending (the archive's redactor, applied again to the input and to the model's answer). Set a chain with only local providers if you want nothing sent out.

## Not built

Summaries of cron outputs and chat messages, a model-written narrative per day, reading the harness version stamp from `docs/self-improvement.md` (the column exists and stays empty until that stamp does), and persona memory reading summaries (it can query `agent_summaries` today).
