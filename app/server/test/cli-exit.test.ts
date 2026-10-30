import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

/** A CLI's JSON reaches a dispatcher through a pipe; nothing past the 64 KiB pipe buffer may be lost on exit. */

const EXIT = resolve(import.meta.dirname, '..', 'src', 'cli-exit.ts');

describe('exitFlushed', () => {
  it('writes 200 KiB through a pipe before the process exits, with the exit code kept', () => {
    // Bundled to plain JS and run on node, the way the compiled CLIs run.
    const dir = mkdtempSync(join(tmpdir(), 'cli-exit-'));
    writeFileSync(join(dir, 'big.ts'), `import { exitFlushed } from ${JSON.stringify(EXIT)};\nprocess.stdout.write(JSON.stringify('x'.repeat(200 * 1024)));\nawait exitFlushed(3);\n`);
    const script = join(dir, 'big.mjs');
    buildSync({ entryPoints: [join(dir, 'big.ts')], bundle: true, format: 'esm', platform: 'node', outfile: script, logLevel: 'silent' });
    let out = '';
    let status: number | null = null;
    try {
      out = execFileSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 1 << 22 });
      status = 0;
    } catch (err) {
      const e = err as { stdout: string; status: number };
      out = e.stdout;
      status = e.status;
    }
    expect(status).toBe(3);
    expect(JSON.parse(out)).toHaveLength(200 * 1024);
  });
});
