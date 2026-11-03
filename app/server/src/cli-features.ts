/**
 * The launcher's and deploy script's window into the feature manifests. Reads no config
 * and opens no database, so it runs anywhere the build exists:
 *
 *   list [--modules a,b] [--json]   every feature, on or off for that module list
 *   units --modules a,b             systemd unit stems to install (one per line)
 *   wrappers --modules a,b          PATH wrappers to install (one per line)
 *   help                            the `secondbrain <command>` lines for the launcher's help
 *   run <command> [args...]         run a feature's CLI entry in this process
 *
 * `run` exits 64 for a command no manifest owns, so the launcher can tell "unknown command"
 * from the CLI's own failure.
 */
import { join } from 'node:path';
import { MANIFESTS, cliFor, unitsFor, wrappersFor } from './features/registry.js';

const EX_USAGE = 64;

function modulesArg(argv: string[]): ReadonlySet<string> {
  const i = argv.indexOf('--modules');
  const raw = i >= 0 ? (argv[i + 1] ?? '') : (process.env.MODULES ?? '');
  return new Set(raw.split(',').map((m) => m.trim()).filter(Boolean));
}

function list(argv: string[]): void {
  const modules = modulesArg(argv);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(MANIFESTS.map((m) => ({ ...m, on: modules.has(m.name) })), null, 2));
    return;
  }
  for (const m of MANIFESTS) {
    const state = modules.has(m.name) ? 'on ' : 'off';
    const parts = [
      m.nav.length ? `page ${m.nav.map((n) => n.path).join(', ')}` : 'no page',
      m.cli.length ? `cli ${m.cli.map((c) => c.command).join(', ')}` : 'no cli',
      m.timers.length ? `timers ${m.timers.map((t) => t.unit.replace(/^secondbrain-/, '')).join(', ')}` : 'no timers',
    ];
    console.log(`${state}  ${m.name.padEnd(10)} ${m.core ? 'core ' : 'addon'}  ${parts.join('; ')}  (${m.docs})`);
  }
}

function help(): void {
  for (const m of MANIFESTS) {
    for (const c of m.cli) console.log(`secondbrain ${c.command.padEnd(14)} ${c.summary}`);
  }
}

async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const found = command ? cliFor(command) : undefined;
  if (!found) {
    console.error(command ? `secondbrain: no feature owns the command "${command}"` : 'secondbrain features run <command> [args...]');
    process.exit(EX_USAGE);
  }
  const entry = join(import.meta.dirname, found.cli.entry);
  // The entries read process.argv themselves (and some check argv[1] to decide whether they are the
  // main module), so hand them the argv they would see when run directly.
  process.argv = [process.argv[0] ?? 'node', entry, ...rest];
  await import(entry);
}

const [sub = 'list', ...argv] = process.argv.slice(2);
switch (sub) {
  case 'list':
    list(argv);
    break;
  case 'units':
    for (const u of unitsFor(modulesArg(argv))) console.log(u);
    break;
  case 'wrappers':
    for (const w of wrappersFor(modulesArg(argv))) console.log(w);
    break;
  case 'help':
    help();
    break;
  case 'run':
    await run(argv);
    break;
  default:
    console.error(`secondbrain features: unknown subcommand "${sub}" (list | units | wrappers | help | run)`);
    process.exit(EX_USAGE);
}
