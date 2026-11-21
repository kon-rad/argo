# Agent Dock Icon Design

**Intent:** Give Agent Dock a distinctive default macOS application icon so it is recognizable in Finder, the Dock, and application menus.

## Design

The icon uses a dark rounded-square macOS tile, the six-blade gold Argo aperture, and a shallow gold dock holding three small agent lights. The aperture is the dominant silhouette. The dock is deliberately simple so the mark remains legible at 16 px. There is no text.

The source artwork is deterministic SVG, with a rendered 1024 px PNG committed beside it. The build script uses that PNG by default to create `AppIcon.icns`. An explicit `--icon` path continues to override the bundled artwork.

## Approaches considered

- **Aperture-cradle, selected:** The aperture sits above a small dock shelf. This is the clearest balance of Argo identity, Agent Dock meaning, and small-size legibility.
- **Literal macOS Dock:** More immediately literal, but too busy at application-menu sizes.
- **Agent tiles around the aperture:** Expressive at full size, but weakens the aperture silhouette and becomes noise when scaled down.

## Constraints

- Keep the public engine generic. The icon may use Argo's visual language but contains no personal data or configuration.
- Support macOS 14 and the current ad hoc signed `.app` build.
- Preserve the existing `--icon` override.
- Bundle all required artwork in `addons/agent-dock/app/Resources/`.
- Do not add a runtime dependency or require image-generation services during builds.

## Verification

- Build without `--icon` and confirm `AppIcon.icns` and `CFBundleIconFile=AppIcon` exist.
- Build with `--icon` and confirm the override path still succeeds.
- Inspect the 1024 px artwork and small rendered sizes for legibility.
- Install `/Applications/AgentDock.app` and confirm macOS displays the icon.
