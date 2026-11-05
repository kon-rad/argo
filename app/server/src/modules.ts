/**
 * The module model, with no environment or database dependency. `config.ts` re-exports it
 * (so `ModuleName`, `MODULE_NAMES` and `parseModules` still resolve from there), and the
 * launcher and the deploy step (`cli-features`) read it directly, so a machine's module
 * list is computed one way and the same way everywhere.
 */

/** The five core features: always on, in every vault, and the only ones a fresh `init` shows. */
export const CORE_MODULES = ['projects', 'org', 'board', 'usage', 'summaries'] as const;

/** Non-core modules. Each has a manifest under `server/src/addons/<name>/` and is off until the vault lists it. */
export const ADDON_MODULES = [
  'ring',
  'agents',
  'map',
  'tv',
  'voice',
  'livestream',
  'media',
  'social',
  'fund',
  'chat',
  'uploads',
  'garden',
  // Pilots and proposals: each has a manifest and a docs-only Status line. Off unless listed.
  'routing',
  'classify',
  'dispatch',
  'improve',
] as const;

export const MODULE_NAMES = [...CORE_MODULES, ...ADDON_MODULES] as const;
export type CoreModuleName = (typeof CORE_MODULES)[number];
export type AddonModuleName = (typeof ADDON_MODULES)[number];
export type ModuleName = (typeof MODULE_NAMES)[number];

/** True for a name the engine treats as core (a feature manifest under `features/`). */
export function isCoreModule(name: string): name is CoreModuleName {
  return (CORE_MODULES as readonly string[]).includes(name);
}

/** `"ring, agents"` → {'ring', 'agents'}; unknown names are ignored. */
export function parseModules(raw: string): ReadonlySet<ModuleName> {
  const wanted = raw.split(',').map((m) => m.trim());
  return new Set(MODULE_NAMES.filter((m) => wanted.includes(m)));
}

/**
 * The module set for a machine: the core five are always on, and `MODULES` plus the
 * vault's `secondbrain.json` `addons` add to them. A fresh vault lists nothing and gets
 * exactly the core features.
 */
export function moduleSet(raw: string, addons: readonly string[] = []): ReadonlySet<ModuleName> {
  const modules = new Set<ModuleName>(CORE_MODULES);
  for (const m of [...parseModules(raw), ...parseModules(addons.join(','))]) modules.add(m);
  return modules;
}

/**
 * `moduleSet`, plus `summaries` when the old `SUMMARIES=on` flag asks for it
 * (deprecated, one release).
 */
export function modulesFromEnv(
  raw: string,
  summariesFlag: string | undefined,
  addons: readonly string[] = [],
): ReadonlySet<ModuleName> {
  const modules = new Set<ModuleName>(moduleSet(raw, addons));
  if (summariesFlag === 'on' && !modules.has('summaries')) {
    modules.add('summaries');
    console.warn('SUMMARIES=on is deprecated: add "summaries" to MODULES instead. It still works this release.');
  }
  return modules;
}
