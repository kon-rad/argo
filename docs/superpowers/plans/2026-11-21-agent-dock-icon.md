# Agent Dock Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a bundled Argo-inspired default macOS icon for Agent Dock while preserving custom icon overrides.

**Architecture:** Store an editable SVG and its 1024 px PNG render under the Agent Dock app resources. Update the shell packager to select the bundled PNG when `--icon` is absent, generate the complete ICNS set, and always declare the icon in `Info.plist`.

**Tech Stack:** SVG, PNG, Bash, `sips`, `iconutil`, Swift Package Manager, pytest

**Spec:** `docs/superpowers/specs/2026-11-21-agent-dock-icon-design.md`

## Global Constraints

- The application remains compatible with macOS 14.
- `--icon PNG` must remain a supported override.
- The default build must not depend on network access or image-generation services.
- No personal data, machine paths, or secrets may enter the public engine.

## Review Focus

- Default build with no arguments still finds the bundled PNG and generates ICNS.
- Custom icon paths still override the bundled PNG.
- Paths containing spaces remain correctly quoted.
- Every required 1x and 2x iconset member is generated.
- The app remains ad hoc signed after the icon is bundled.

---

### Task 1: Bundle and package the default icon

**Files:**
- Create: `addons/agent-dock/app/Resources/AgentDockIcon.svg`
- Create: `addons/agent-dock/app/Resources/AgentDockIcon.png`
- Modify: `addons/agent-dock/app/build.sh`
- Modify: `addons/agent-dock/README.md`
- Modify: `addons/agent-dock/tests/test_agent_dock.py`

**Interfaces:**
- Consumes: `build.sh [--vault DIR] [--icon PNG] [--install]`
- Produces: `build/AgentDock.app/Contents/Resources/AppIcon.icns` and `CFBundleIconFile=AppIcon`

- [x] **Step 1: Add a failing packaging test**

Assert that `build.sh` names `Resources/AgentDockIcon.png` as the default, retains the `--icon` assignment, always emits `CFBundleIconFile`, and generates all ten iconset filenames.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `python3 -m pytest addons/agent-dock/tests/test_agent_dock.py -q`

Expected: FAIL because no bundled default is referenced.

- [x] **Step 3: Add the artwork and packaging behavior**

Create the approved vector artwork, render it to a 1024 px RGBA PNG, and make `icon` default to that PNG before argument parsing so `--icon` remains authoritative.

- [x] **Step 4: Update user documentation**

Document that every normal build includes the default icon and `--icon` replaces it.

- [x] **Step 5: Verify the focused tests and build**

Run: `python3 -m pytest addons/agent-dock/tests/test_agent_dock.py -q`

Expected: all Agent Dock tests pass.

Run: `cd addons/agent-dock/app && ./build.sh`

Expected: the app builds and contains `Contents/Resources/AppIcon.icns` with the matching Info.plist key.

- [x] **Step 6: Run repository checks**

Run: `python3 -m pytest addons/agent-dock -q`

Run: `scripts/check-public.sh`

Expected: both pass.

- [x] **Step 7: Install and inspect**

Run: `cd addons/agent-dock/app && ./build.sh --install`

Expected: `/Applications/AgentDock.app` is replaced by the signed build and macOS reports `AppIcon.icns` as its icon.

- [x] **Step 8: Commit and push**

Commit the spec, plan, artwork, packaging, tests, and docs with `feat(agent-dock): add branded app icon`, then push `feat/agent-dock-icon` to `origin`.
