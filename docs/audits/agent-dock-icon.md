# Agent Dock icon verification

Card: `t_09fed46d`, 2026-11-21. Status: blocked by local verification tooling.

This branch is stacked on `feat/agent-dock-icon`. The complete PR #228 change
is present as the original `2fa4265` and `cd4c89d` commits. The diff against
`origin/feat/agent-dock-icon` was empty before this verification record.
No artwork, packaging code, or inherited commits were changed.

Review confirmed that the packager selects the bundled gold aperture-and-dock
PNG by default, quotes the `--icon` override, always writes
`CFBundleIconFile=AppIcon`, and uses `set -e` with an unconditional `codesign`
command. Signing failure therefore exits before the success message or install
step. This signing behavior was reviewed in source, not exercised end to end.
The committed 1024 px PNG was visually inspected.

## Results

| Check | Observed result |
| --- | --- |
| Required `uv run --with pytest python -m pytest addons/agent-dock -q` | Exit 2: default uv cache access denied. Writable-cache and offline attempts exited 101 with `Attempted to create a NULL object` in uv's macOS system-configuration library. |
| Same suite with an existing local Python environment containing pytest 9.2.0 | `2 failed, 28 passed in 2.50s`. Both failures raise `PermissionError: [Errno 1] Operation not permitted: 'ps'`. |
| `swift build --disable-sandbox -c release --package-path addons/agent-dock/app` | Exit 0, `Build complete! (9.90s)`. |
| `addons/agent-dock/app/build.sh` | Swift build passed, then `iconutil` exited 1 with `Invalid Iconset`. |
| `addons/agent-dock/app/build.sh --icon '/tmp/t_09fed46d-verification/Custom Icon.png'` | Swift build passed, then the same `Invalid Iconset` error. |
| Generated default iconset PNGs | 10/10 exact expected filenames and dimensions, checked with PNG headers, `sips`, and `file`. This does not verify ICNS encoding. |
| `git diff origin/main...HEAD --name-only -z \| xargs -0 scripts/check-public.sh` | Exit 0, no output, for all seven inherited changed paths. |
| `git diff --check origin/main...HEAD` and `bash -n addons/agent-dock/app/build.sh` | Exit 0, no output. |

For both packaging attempts, a temporary PATH wrapper added the explicitly
granted `--disable-sandbox` option to real `/usr/bin/swift build` invocations.
All other packaging tools were the real local tools. No packaging command was
replaced with a successful stub. The packager itself remains unchanged.

## Remaining acceptance

The process inspection denial was independently reproduced with
`/bin/ps -o lstart= -p $$`. The two affected tests are
`test_run_records_start_and_end_and_returns_the_exit_code` and
`test_run_sets_the_local_machine_for_zen_agent`. Do not weaken runtime behavior
or tests to conceal this environment restriction.

The cause of `iconutil` rejecting correctly sized PNG inputs is unresolved.
A signed app, emitted Info.plist, ten encoded ICNS members, successful custom
icon packaging, and actual signing failure behavior remain unverified in this
run. The packager stops before writing Info.plist or invoking codesign.

Relaunch with process inspection, a working uv/pytest environment, and native
icon packaging support. Repeat the required 30-test suite and both builds,
then verify `codesign --verify --deep --strict`, `Signature=adhoc`, the plist
icon key, all ten ICNS members, and failure propagation from codesign.
Finder installation, GUI launch, deployment, and health checks were not run.
Unrelated app, zen-agent, and full repository suites were not run for this
verification-only card. Runner-owned push, PR creation, and exact-revision
review handoff remain pending.
