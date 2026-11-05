/**
 * The addon manifests: the non-core modules, each off until the vault lists it in
 * `secondbrain.json`'s `addons`. Same shape as a core feature manifest
 * (features/types.ts), so every reader - `secondbrain features`, the launcher,
 * deploy.sh, doctor, `secondbrain plan|apply` - treats an addon exactly like a core
 * feature. Order matches `ADDON_MODULES` in config.ts.
 *
 * In-process addons live here under the server tree, because `app.ts` and the TypeScript
 * build import them. The external addons (`tv-kiosk`, `telegram-bridge`) keep their
 * `manifest.json` at the repo-root `addons/` and are read by deploy and the docs.
 */
import type { FeatureManifest } from '../features/types.js';
import agents from './agents/manifest.js';
import chat from './chat/manifest.js';
import fund from './fund/manifest.js';
import garden from './garden/manifest.js';
import livestream from './livestream/manifest.js';
import map from './map/manifest.js';
import media from './media/manifest.js';
import ring from './ring/manifest.js';
import social from './social/manifest.js';
import tv from './tv/manifest.js';
import uploads from './uploads/manifest.js';
import voice from './voice/manifest.js';

export const ADDON_MANIFESTS: readonly FeatureManifest[] = [
  ring,
  agents,
  map,
  tv,
  voice,
  livestream,
  media,
  social,
  fund,
  chat,
  uploads,
  garden,
];
