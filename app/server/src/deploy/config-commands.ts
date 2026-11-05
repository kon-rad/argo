/**
 * The pure half of `secondbrain plan | apply | upgrade`: given an injected view of the
 * filesystem and the settings, decide what to print and what to write. `cli-config.ts`
 * is the thin entry that builds the real io from `config` and the vault's settings.
 *
 * Kept free of top-level side effects so the behaviour ("plan writes nothing, apply
 * writes the plan, upgrade is a dry run unless told otherwise") is unit-tested without
 * spawning a process or touching `/etc`.
 */
import { join } from 'node:path';
import { applyDeploy, planDeploy, type DeployPlan } from './generate.js';
import type { ServerSettings } from '../settings.js';

export interface ConfigIo {
  server: ServerSettings;
  modules: ReadonlySet<string>;
  /** Where the unit templates live (`app/deploy`). */
  templateDir: string;
  /** Where the units are installed (`/etc/systemd/system`). */
  unitDir: string;
  /** The env file's path (`/etc/secondbrain/env`). */
  envPath: string;
  /** Values for the non-base env keys, from the vault's `.env` or the environment. */
  values: Record<string, string | undefined>;
  read: (path: string) => string | undefined;
  write: (path: string, content: string) => void;
  /** The unit files already installed in `unitDir`. */
  listInstalled: () => string[];
  log: (line: string) => void;
  error: (line: string) => void;
}

export function planFor(io: ConfigIo): DeployPlan {
  return planDeploy({
    server: io.server,
    modules: io.modules,
    templateDir: io.templateDir,
    unitDir: io.unitDir,
    envPath: io.envPath,
    values: io.values,
    read: io.read,
    installed: io.listInstalled(),
  });
}

export function describe(p: DeployPlan, io: ConfigIo): void {
  for (const f of p.files) io.log(`${f.status.padEnd(9)} ${f.path}`);
  for (const s of p.stale) io.log(`${'stale'.padEnd(9)} ${join(io.unitDir, s)} (installed here, not owned by this server)`);
  io.log(p.changed.length ? `${p.changed.length} file(s) would change.` : 'everything matches; nothing to write.');
}

export function runConfig(sub: string, yes: boolean, io: ConfigIo): number {
  const plan = planFor(io);

  if (sub === 'plan') {
    describe(plan, io);
    if (!io.server.generate) io.log('server.generate is off: run apply only after setting it true in secondbrain.json.');
    return 0;
  }

  if (sub !== 'apply' && sub !== 'upgrade') {
    io.error(`secondbrain: unknown command "${sub}" (plan | apply | upgrade)`);
    return 64;
  }

  if (sub === 'upgrade' && !yes) {
    io.log('upgrade (dry run; pass --yes to write):');
    describe(plan, io);
    return 0;
  }

  if (!io.server.generate) {
    io.error('server.generate is off in secondbrain.json; set it true to write the env file and units.');
    return 1;
  }

  const result = applyDeploy(plan, io.write);
  describe(plan, io);
  io.log(`wrote ${result.written.length} file(s), ${result.unchanged.length} already current.`);
  return 0;
}
