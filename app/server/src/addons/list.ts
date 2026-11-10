import { loadSettingsFile } from '../settings-file.js';

/**
 * The vault's `secondbrain.json` `addons` list, e.g. `["map", "voice"]`, read without
 * loading the settings schema: config.ts imports this file and cannot import settings.ts
 * (which imports config.ts back). Unknown names are dropped by `parseModules`, so a typo
 * degrades to "that addon is off", and one `secondbrain doctor` check names it.
 *
 * A missing or malformed file is an empty list, never a throw: a fresh vault has no
 * `secondbrain.json` at all and must still boot.
 */
export function readAddonList(vaultRoot: string): string[] {
  const { raw, error } = loadSettingsFile(vaultRoot);
  if (error || !raw || typeof raw !== 'object' || !Array.isArray((raw as { addons?: unknown }).addons)) {
    return [];
  }
  return (raw as { addons: unknown[] }).addons.filter((addon): addon is string => typeof addon === 'string');
}
