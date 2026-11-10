import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runConfig, type ConfigIo } from '../src/deploy/config-commands.js';
import { ALL_GENERATED_UNITS, BASE_UNITS, applyDeploy, envKeys, planDeploy, renderGeneratedUnit, unitStems } from '../src/deploy/generate.js';
import { parseSettings, type ServerSettings } from '../src/settings.js';

/**
 * Phase 4's acceptance (card t_3d4ce863): on a fixture vault, `plan` shows the generated
 * env file and units without writing, `apply` writes them, `upgrade` is a dry run unless
 * `--yes`. Everything here runs against an in-memory filesystem, so the tests never touch
 * /etc and never spawn a process.
 */
const here = dirname(fileURLToPath(import.meta.url));
/** app/deploy: the real systemd templates the generator renders. */
const templateDir = resolve(here, '..', '..', 'deploy');
const unitDir = '/etc/systemd/system';
const envPath = '/etc/secondbrain/env';

function server(overrides: Record<string, unknown> = {}): ServerSettings {
  return parseSettings({
    server: { generate: true, host: 'sb.example.com', user: 'sb', dir: '/opt/sb', vaultDir: '/srv/vault', ...overrides },
  }).server;
}

/** An in-memory filesystem: templates come from disk, everything else from the map. */
function memFs() {
  const files = new Map<string, string>();
  const writes: string[] = [];
  return {
    files,
    writes,
    read: (p: string): string | undefined => (files.has(p) ? files.get(p) : existsSync(p) ? readFileSync(p, 'utf8') : undefined),
    write: (p: string, c: string): void => {
      files.set(p, c);
      writes.push(p);
    },
    listInstalled: () => [] as string[],
  };
}

function io(fs: ReturnType<typeof memFs>, overrides: Partial<ConfigIo> = {}): ConfigIo {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    server: server(),
    modules: new Set(['board']),
    templateDir,
    unitDir,
    envPath,
    values: { DATABASE_URL: 'postgres:///secondbrain', OWNER_NAME: 'owner' },
    read: fs.read,
    write: fs.write,
    listInstalled: fs.listInstalled,
    log: (l) => lines.push(l),
    error: (l) => errs.push(l),
    ...overrides,
  } as ConfigIo;
}

describe('env and unit generation (pure)', () => {
  it('names the app service plus each enabled feature timer, and no addon', () => {
    expect(unitStems(new Set(['board']))).toEqual(['secondbrain', 'secondbrain-board-reclaim']);
  });

  it('renders every former deploy unit pair from manifests or the base table', () => {
    expect(ALL_GENERATED_UNITS.map((u) => u.unit)).toEqual([
      'secondbrain-projects-render',
      'secondbrain-memory-capture',
      'secondbrain-board-reclaim',
      'secondbrain-usage-sync',
      'secondbrain-credits-sync',
      'secondbrain-summarize',
      'secondbrain-agents-sync',
      'secondbrain-map-build',
      'secondbrain-metrics',
      'secondbrain-livestream',
      'secondbrain-social',
      'secondbrain-garden',
      'secondbrain-routing-report',
      'secondbrain-dispatch',
      'secondbrain-db-backup',
      'secondbrain-vault-sync',
      'secondbrain-embed',
    ]);
    expect(BASE_UNITS.map((u) => u.unit)).toEqual(['secondbrain-db-backup', 'secondbrain-vault-sync', 'secondbrain-embed']);
    for (const unit of ALL_GENERATED_UNITS) {
      const service = renderGeneratedUnit(unit, 'service');
      const timer = renderGeneratedUnit(unit, 'timer');
      expect(service, unit.unit).toContain('ExecStart=');
      expect(service, unit.unit).toContain('User=@APP_USER@');
      expect(service, unit.unit).toContain('EnvironmentFile=/etc/secondbrain/env');
      expect(timer, unit.unit).toContain('OnCalendar=');
    }
  });

  it.each(['secondbrain-board-reclaim', 'secondbrain-map-build', 'secondbrain-garden'])('%s stays byte-compatible with its former files', (stem) => {
    const unit = ALL_GENERATED_UNITS.find((candidate) => candidate.unit === stem)!;
    for (const ext of ['service', 'timer'] as const) {
      const golden = readFileSync(resolve(here, 'fixtures/deploy-units', `${stem}.${ext}`), 'utf8');
      expect(renderGeneratedUnit(unit, ext)).toBe(golden);
    }
  });

  it('lists the server keys and the enabled feature env keys, each once', () => {
    const keys = envKeys(new Set(['board']));
    for (const k of ['DEPLOYMENT', 'PUBLIC_ORIGIN', 'VAULT_ROOT', 'MODULES', 'AUTH_PASSWORD_HASH', 'BOARD_URL']) {
      expect(keys).toContain(k);
    }
    expect(new Set(keys).size).toBe(keys.length);
    // An addon that is not on contributes nothing.
    expect(keys).not.toContain('LINKEDIN_CLIENT_ID');
  });

  it('plans the env file and units as creates without writing anything', () => {
    const fs = memFs();
    const plan = planDeploy({ ...io(fs), installed: [] });
    expect(plan.files.map((f) => f.kind)).toEqual(['env', 'unit', 'unit', 'unit']);
    expect(plan.files.every((f) => f.status === 'create')).toBe(true);
    expect(plan.changed.length).toBe(plan.files.length);
    expect(fs.writes).toEqual([]);
  });

  it('selects base jobs explicitly and can leave an existing env file alone', () => {
    const fs = memFs();
    const plan = planDeploy({
      ...io(fs),
      installed: [],
      baseUnits: new Set(['secondbrain-embed']),
      unitsOnly: true,
    });
    expect(plan.files.some((file) => file.path === envPath)).toBe(false);
    expect(plan.files.map((file) => file.path)).toContain('/etc/systemd/system/secondbrain-embed.service');
    expect(plan.files.map((file) => file.path)).toContain('/etc/systemd/system/secondbrain-embed.timer');
    expect(plan.files.map((file) => file.path)).not.toContain('/etc/systemd/system/secondbrain-db-backup.timer');
  });

  it('renders the server block into the units, leaving no @placeholder@', () => {
    const fs = memFs();
    const plan = planDeploy({ ...io(fs), installed: [] });
    const svc = plan.files.find((f) => f.path.endsWith('secondbrain-board-reclaim.service'));
    expect(svc?.after).toContain('User=sb');
    expect(svc?.after).toContain('WorkingDirectory=/opt/sb');
    expect(svc?.after).not.toContain('@APP_USER@');
  });

  it('apply writes the plan, then a second plan is all unchanged', () => {
    const fs = memFs();
    const first = planDeploy({ ...io(fs), installed: [] });
    const result = applyDeploy(first, fs.write);
    expect(result.written.length).toBe(first.changed.length);
    const second = planDeploy({ ...io(fs), installed: [] });
    expect(second.changed).toEqual([]);
    expect(second.files.every((f) => f.status === 'unchanged')).toBe(true);
  });

  it('reports installed units it does not own as stale, without removing them', () => {
    const fs = memFs();
    const plan = planDeploy({ ...io(fs), installed: ['secondbrain.service', 'secondbrain-legacy.timer', 'other.service'] });
    expect(plan.stale).toEqual(['secondbrain-legacy.timer']);
  });
});

describe('secondbrain plan|apply|upgrade', () => {
  it('plan writes nothing even when generate is on, and notes when it is off', () => {
    const fs = memFs();
    expect(runConfig('plan', false, io(fs))).toBe(0);
    expect(fs.writes).toEqual([]);
    const off = runConfig('plan', false, io(fs, { server: server({ generate: false }) }));
    expect(off).toBe(0);
    expect(fs.writes).toEqual([]);
  });

  it('apply refuses when server.generate is off', () => {
    const fs = memFs();
    expect(runConfig('apply', false, io(fs, { server: server({ generate: false }) }))).toBe(1);
    expect(fs.writes).toEqual([]);
  });

  it('apply writes the plan when server.generate is on', () => {
    const fs = memFs();
    expect(runConfig('apply', false, io(fs))).toBe(0);
    expect(fs.writes).toContain(envPath);
    expect(fs.files.get(envPath)).toContain('DEPLOYMENT=server');
    expect(fs.files.get(envPath)).toContain('PUBLIC_ORIGIN=https://sb.example.com');
    expect(fs.files.get(envPath)).toContain('MODULES=board');
  });

  it('upgrade is a dry run unless --yes', () => {
    const fs = memFs();
    expect(runConfig('upgrade', false, io(fs))).toBe(0);
    expect(fs.writes).toEqual([]);
    expect(runConfig('upgrade', true, io(fs))).toBe(0);
    expect(fs.writes).toContain(envPath);
  });

  it('rejects an unknown subcommand', () => {
    const fs = memFs();
    expect(runConfig('frobnicate', false, io(fs))).toBe(64);
    expect(fs.writes).toEqual([]);
  });
});
