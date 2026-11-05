/**
 * `secondbrain org-compile`: the org compiler, in the engine (engine-core-v2 proposal,
 * phase 2 and decision 3). Reads a vault's `.agents/org/` tree and writes the files the
 * engine consumes: `.agents/org/org.json` (the import document `cli-org plan|apply` read),
 * `.agents/org/org-agents.json` and `.claude/agents/<name>.md`.
 *
 * The routing.json and graphs.json outputs of the old Python compiler are not produced
 * (they belong to the routing addon). Cli-org also reaches this as `secondbrain org compile`
 * (cli-org forwards the `compile` subcommand here).
 */
import { exitFlushed } from './cli-exit.js';
import { resolve } from 'node:path';
import { config } from './config.js';
import { compileOrg, legacyRefusal, type CompileResult } from './org-compile.js';

const USAGE = `cli-org-compile: compile a vault's org config (.agents/org/) into what the engine reads.

  org-compile [--vault DIR] [--check] [--out FILE]

  (default)   validate and write .agents/org/org.json, .agents/org/org-agents.json and
              .claude/agents/<name>.md (only the files that changed)
  --check     validate only; print the summary and every error; write nothing; exit 1 on errors
  --out FILE  write the import document to FILE instead of .agents/org/org.json
  --vault DIR the vault root (default: config.vaultRoot)

Dropped from the Python compiler: routing.json, graphs.json and the generated overview page.
The routing pilot's model-floor check (routing_config.py: a bot pinned to a local model that lacks the capability its cards need) is NOT part of this port, because it reads the routing addon's models/providers/machines/routing config. The engine's --check reports every other error and warning the Python one did; the model floors belong with the routing addon when it is built, and until then a vault that has them goes on running its own compile.py check for that one class.

Edit the files in .agents/org/config/, never the compiled output.`;

type Args = { pos: string[]; opts: Record<string, string | true> };

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else {
      opts[key] = next;
      i++;
    }
  }
  return { pos, opts };
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const { pos, opts } = parseArgs(argv);
  if (pos[0] === 'help' || opts['help'] === true) {
    console.log(USAGE);
    return 0;
  }
  const vaultRoot = resolve(str(opts['vault']) ?? config.vaultRoot);
  const check = opts['check'] === true;

  const refusal = legacyRefusal(vaultRoot);
  if (refusal) {
    console.error(`error: ${refusal}`);
    return 2;
  }

  let r: CompileResult;
  try {
    r = compileOrg(vaultRoot, { check, ...(str(opts['out']) ? { out: str(opts['out'])! } : {}) });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  if (check) {
    console.log(r.summary);
    console.log(`errors: ${r.errors.length}`);
    for (const e of r.errors) console.log(`  - ${e}`);
    if (r.warnings.length) {
      console.log(`warnings (paths missing on this machine): ${r.warnings.length}`);
      for (const w of r.warnings) console.log(`  - ${w}`);
    }
    return r.errors.length ? 1 : 0;
  }

  for (const w of r.warnings) console.error(`warning: ${w}`);
  if (r.errors.length) {
    console.error(r.errors.map((e) => `error: ${e}`).join('\n'));
    return 1;
  }
  console.log(r.changed.length ? r.changed.join('\n') : 'org up to date');
  console.log(r.summary);
  console.log(`version ${r.version}`);
  return 0;
}

if (process.argv[1]?.endsWith('cli-org-compile.js') || process.argv[1]?.endsWith('cli-org-compile.ts')) {
  let code = 1;
  try {
    code = await main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
  } finally {
    await exitFlushed(code);
  }
}
