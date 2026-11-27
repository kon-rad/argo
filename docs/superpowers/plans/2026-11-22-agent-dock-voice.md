# Agent Dock voice implementation and release plan

Goal: select a persona, enable Voice Mode, and click the desired harness to begin a spoken conversation in the selected vault. Ship an optional native macOS add-on with local recognition and playback.

## Implementation checklist

- [x] In AgentsView.swift and VoiceView.swift, route persona card harness buttons and model choices through the existing launcher when voice is off. In voice mode carry the selected harness, model and provider to the worker. Use the gear for speech configuration and one toolbar info menu for shortcut help.
- [x] In Voice.swift capture echo-processed audio through AVFoundation, convert to mono 16 kHz PCM, show recent levels and selected system input, and reopen capture after a default input change. Mute and pause must release capture and discard obsolete audio.
- [x] In voice/worker.py separate capture state from harness readiness and send each finalized utterance once. Use codex_voice.py for managed Codex turns and approval events. Use cli_voice.py to invoke other installed harnesses directly with session continuation. Keep inputs as data, outside shell command strings.
- [x] In speech.py discover compatible local weights, keep the selected Parakeet model resident, expose source-labeled reference ratings, and handle endpoint and interruption events. Preserve the system voice and optional offline Kokoro playback path.
- [x] Keep Codex model selection consistent in text and voice launches. Exercise a roster whose scheduled model differs from the local Codex CLI default.
- [x] Provide replay fixtures, physical test procedure, CPU/accelerator reference metadata and a signed app build. Keep physical results distinct from synthetic replay.

## Release checks

1. Run the add-on Python suite and Swift suite. Confirm normal vault directories are accepted, both launch modes honor explicit model selection, interruption invalidates queued playback, and shortcut state follows microphone state.
2. Build the release bundle and verify its signature. Run its packaged doctor and decode a known spoken fixture on the target machine. Record frame count, text and actual harness model.
3. Exercise a real managed voice turn through microphone or injected speech. Record recognition, assistant reply and synthesized output. Measure acoustic latency separately on calibrated physical input/output. Record which harnesses and devices were actually tested.
4. Submit the head with CI and evidence to the registered reviewer. Release only on an independently accepted revision. Verify merge, server revision and health; build and verify the installed Mac app from the accepted tree. A signed preview and a passing CI run do not establish deployment.

## Verification on Apple silicon

- M4, macOS 26.7.2. The 47 Agent Dock Python checks and five Swift tests passed. The signed release bundle passed strict, deep codesign verification.
- The packaged doctor used the real vault, loaded cached Parakeet, decoded the bundled sample, synthesized 23,480 frames and opened a managed Codex thread using the local CLI default.
- In a disposable workspace, injected 16 kHz audio produced the transcript “Please reply with the single word violet.” The managed Codex thread returned “violet” using gpt-6.1-terra. System speech rendered the reply to 8,265 frames. This measures the software path. Acoustic latency, microphone routing after unplug, and visible waveform behavior require a physical test.
- A direct Zen voice-adapter turn with an installed Ollama model returned the expected reply and session ID. Claude's configured provider rejected its test request. Model availability and provider access are checked per harness.
- Independent review, physical acceptance, installation from the merged revision and deployed revision verification are open release checks.
