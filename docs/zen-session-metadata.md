# Zen session provenance

Zen records how each invocation started and the selected model's catalogue context window in its session trace. Collectors can use those recorded facts instead of guessing from a computer name or cumulative token totals.

## Trace fields

Each startup appends a `meta` line to the session JSONL file in the configured `sessionsDir` (default `.zen/sessions` inside the workdir). Existing metadata and trace format version 1 remain compatible. These are the relevant additional fields, shown as a partial example:

```json
{
  "type": "meta",
  "version": 1,
  "model": "example/model",
  "entrypoint": "wake",
  "context_window": 32768
}
```

| Field | Recorded value |
|---|---|
| `entrypoint` | The actual entrypoint supplied by the producer: `chat`, `run`, `wake`, `serve` or `subagent`. `null` when the caller did not supply it |
| `context_window` | The selected model catalogue's positive finite `contextWindow`, or `null` when it is missing or invalid |
| `parent` | The parent session identity for a delegated child; existing parent and tool restrictions remain in force |

The catalogue window is a configured capacity, not a measurement of the current prompt. Keep a custom provider's `contextWindow` consistent with its model/server configuration. Input/output usage totals do not establish either this capacity or current context occupancy. Older traces without these fields remain unknown; these changes do not backfill guesses into them.

## Producers

| Invocation | `entrypoint` |
|---|---|
| `zen-agent chat` | `chat`, including startup before the first prompt |
| `zen-agent run "..."` | `run` |
| A card or dispatcher calling `runWake` | `wake` |
| A chat created by `ChatHost` / `zen-agent serve` | `serve` |
| The `delegate` tool's child session | `subagent` |

A caller constructing `ZenAgent` directly can supply its entrypoint. Without one it records `null`. An explicit channel, such as Telegram, remains separate provenance for the collector to preserve. See [Usage configuration](configuration.md#usage-page-providers-and-sections) for conversation collection and the distinction between session usage and account quotas.

## Check your installation

Use your existing `zen.json`, model/provider configuration and normal credentials. Provider keys belong in the environment named by `apiKeyEnv`, not in the trace or configuration file. Build instructions and provider examples are in the [Zen README](https://github.com/kon-rad/argo/blob/main/zen-agent/README.md).

After a normal invocation, inspect the session's `meta` line in your configured trace directory. Confirm the recorded model and entrypoint match the invocation. A resumed trace can contain another `meta` line for the new startup. When a value was not recorded, leave its interpretation unknown rather than filling it from the host or usage totals.

## Verification

The producer regression tests run the real compiled `run` CLI against a loopback synthetic SSE provider and start/quit the real `chat` CLI with zero model requests. Existing real `runWake`, served chat and delegated-child fixtures verify their persisted trace metadata. Invalid and missing capacities remain `null`.

The constructor label matrix is serialization coverage. The separate real-entrypoint tests establish that the invocation paths actually supply the right labels. These tests use isolated synthetic configuration and do not call an external model. Changes to reactive web timestamp consumers are delivered separately from this producer metadata change.
