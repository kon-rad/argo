import { beforeEach, describe, expect, it, vi } from 'vitest';

const bootDesk = vi.fn();
vi.mock('../src/addons/desk/boot.js', () => ({ bootDesk }));

describe('addon lifecycle', () => {
  beforeEach(() => bootDesk.mockReset());

  it('does not load or boot the hiring desk when its module is disabled', async () => {
    const { bootAddons } = await import('../src/addons/index.js');
    const { config } = await import('../src/config.js');

    await expect(bootAddons(new Set(), config)).resolves.toEqual({});
    expect(bootDesk).not.toHaveBeenCalled();
  });

  it('boots the hiring desk through the enabled addon composition', async () => {
    const desk = { public: {}, operator: {} };
    bootDesk.mockResolvedValue(desk);
    const { bootAddons } = await import('../src/addons/index.js');
    const { config } = await import('../src/config.js');
    const modules = new Set(['desk']);

    await expect(bootAddons(modules, config)).resolves.toEqual({ desk });
    expect(bootDesk).toHaveBeenCalledWith(modules, config.desk);
  });
});
