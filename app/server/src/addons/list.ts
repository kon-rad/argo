import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  const file = resolve(vaultRoot, 'secondbrain.json');
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { addons?: unknown }).addons)) {
      return (parsed as { addons: unknown[] }).addons.filter((a): a is string => typeof a === 'string');
    }
    return [];
  } catch {
    return [];
  }
}
