import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { runBacklinks } from './backlinks.js';

/**
 * secondbrain backlinks [--write] [--path <prefix>] [--list]
 * Dry run by default: prints what would change. Runs on the checkout (no
 * database), so the diff can be reviewed in git before it's committed.
 */
const argv = process.argv.slice(2);
const write = argv.includes('--write');
const pi = argv.indexOf('--path');
const prefix = pi >= 0 ? argv[pi + 1] : undefined;

// Files with uncommitted changes belong to whoever is editing them; leave them
// for the next run so a backlink commit never carries someone else's edit.
let dirty = new Set<string>();
try {
  const out = execFileSync('git', ['-C', config.vaultRoot, 'status', '--porcelain', '-uall'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  dirty = new Set(out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '')));
} catch { /* not a git checkout: nothing to protect */ }

const s = await runBacklinks(config.vaultRoot, { write, prefix, skip: dirty });
if (dirty.size > 0) console.log(`skipping files with uncommitted changes (${dirty.size} in git status)`);
if (argv.includes('--list')) for (const p of s.changedPaths) console.log(p);
console.log(
  `${write ? 'wrote' : 'dry run:'} ${s.changed} of ${s.writable} writable notes ` +
  `(${s.notes} read), ${s.linksAdded} links in changed blocks; ` +
  `orphans ${s.orphansBefore} -> ${s.orphansAfter} of ${s.notes}`,
);
if (!write && s.changed > 0) console.log('rerun with --write to apply');
