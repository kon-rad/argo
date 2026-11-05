import { describe, expect, it } from 'vitest';
import { ADDON_MANIFESTS } from '../src/addons/registry.js';
import { cliFor, enabledManifests, unitsFor, wrappersFor } from '../src/features/registry.js';
import { ADDON_MODULES, CORE_MODULES, MODULE_NAMES, isCoreModule, moduleSet } from '../src/modules.js';

/**
 * Phase 5 (card t_feec76b8): the non-core modules are addons. Each has a manifest under
 * `server/src/addons/<name>/`, the core five are always on, and an addon turns on only
 * when the vault lists it, taking its routes, timers and CLI with it.
 */
describe('addons', () => {
  it('every addon module has exactly one manifest, and no addon claims to be core', () => {
    const names = ADDON_MANIFESTS.map((m) => m.name);
    expect(new Set(names).size, 'one manifest per addon').toBe(names.length);
    expect([...names].sort()).toEqual([...ADDON_MODULES].sort());
    for (const m of ADDON_MANIFESTS) expect(m.core, `${m.name} is an addon`).toBe(false);
  });

  it('core and addon names are disjoint and together are every module', () => {
    const overlap = CORE_MODULES.filter((c) => (ADDON_MODULES as readonly string[]).includes(c));
    expect(overlap).toEqual([]);
    expect([...MODULE_NAMES]).toEqual([...CORE_MODULES, ...ADDON_MODULES]);
    expect(isCoreModule('board')).toBe(true);
    expect(isCoreModule('map')).toBe(false);
  });

  it('a fresh vault gets the core five and no addon timer or wrapper', () => {
    const fresh = moduleSet('');
    expect([...fresh]).toEqual([...CORE_MODULES]);
    expect(enabledManifests(fresh).every((m) => m.core)).toBe(true);
    // A fresh vault has no addon's timer or wrapper, whatever the static command table says.
    expect(unitsFor(fresh)).not.toContain('secondbrain-social');
    expect(unitsFor(fresh)).not.toContain('secondbrain-agents-sync');
    expect(wrappersFor(fresh)).not.toContain('cli-social');
    // The command table is static: the word resolves, but the wrapper is only written when the module is on.
    expect(cliFor('social')?.feature?.name).toBe('social');
  });

  it('listing an addon turns on its manifest, its timers and its wrappers, and nothing else', () => {
    const withSocial = moduleSet('', ['social']);
    expect(enabledManifests(withSocial).map((m) => m.name)).toContain('social');
    expect(unitsFor(withSocial)).toContain('secondbrain-social');
    expect(wrappersFor(withSocial)).toContain('cli-social');
    // An addon not listed stays dark.
    expect(unitsFor(withSocial)).not.toContain('secondbrain-agents-sync');

    const all = moduleSet('', [...ADDON_MODULES]);
    const on = enabledManifests(all).map((m) => m.name);
    for (const name of MODULE_NAMES) expect(on, `${name} is on when everything is listed`).toContain(name);
  });
});
