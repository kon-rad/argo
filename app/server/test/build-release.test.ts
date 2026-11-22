import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// deploy/build-release.sh: the deploy's install and build happen beside the live tree, so a shared-memory CLI started
// meanwhile never meets a half-installed node_modules. That was `cli-org recall` failing on the droplet with
// "Cannot find package '<app>/node_modules/zod/index.js'": deploy.sh ran npm ci in place, and npm ci empties it first.
const APP_ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(APP_ROOT, 'deploy', 'build-release.sh');

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A fake package `dep` at `version`, and the two CLIs the script checks, importing it the way cli-org imports zod. */
const depFiles = (root: string, version: string) => {
  write(join(root, 'node_modules/dep/package.json'), JSON.stringify({ name: 'dep', version, type: 'module', exports: './index.js' }));
  write(join(root, 'node_modules/dep/index.js'), `export const version = '${version}';\n`);
};
const cliFiles = (root: string, imports: string) => {
  for (const cli of ['cli-org.js', 'cli-memory.js']) {
    write(join(root, 'server/dist', cli), `import { version } from '${imports}';\nconsole.log('${cli} ' + version + ' ' + process.argv.slice(2).join(' '));\n`);
  }
};

/** A live app tree on v1, as a deploy finds it. */
function liveApp(): string {
  const app = mkdtempSync(join(tmpdir(), 'sb-release-'));
  write(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, type: 'module' }));
  write(join(app, 'server/src/cli-org.ts'), '// source\n');
  write(join(app, 'data/keep.txt'), 'not shipped\n');
  depFiles(app, '1');
  cliFiles(app, 'dep');
  return app;
}

const run = (app: string, install: string, build: string) => spawnSync('bash', [SCRIPT, app], {
  encoding: 'utf8', env: { ...process.env, SB_RELEASE_INSTALL: install, SB_RELEASE_BUILD: build }, timeout: 60_000,
});
const cli = (app: string, name: string, ...args: string[]) =>
  spawnSync('node', [join(app, 'server/dist', name), ...args], { encoding: 'utf8', cwd: app });

describe('deploy/build-release.sh', () => {
  it('preserves the separately installed Desk addon during the build and after the swap', () => {
    const app = liveApp();
    const addon = mkdtempSync(join(tmpdir(), 'sb-desk-addon-'));
    write(join(addon, 'package.json'), '{"name":"@secondbrain/hiring-desk","type":"module","exports":{"./server":"./dist/server/index.js"}}');
    write(join(addon, 'dist/server/index.js'), 'export {};');
    mkdirSync(join(app, 'node_modules/@secondbrain'), { recursive: true });
    symlinkSync(addon, join(app, 'node_modules/@secondbrain/hiring-desk'));
    const build = `test -f node_modules/@secondbrain/hiring-desk/package.json && mkdir -p server/dist && for c in cli-org.js cli-memory.js; do printf "import { version } from 'dep';\\nconsole.log(version);\\n" > server/dist/$c; done`;
    const r = run(app, `mkdir -p node_modules/dep && cp '${join(app, 'node_modules/dep/package.json')}' node_modules/dep/ && cp '${join(app, 'node_modules/dep/index.js')}' node_modules/dep/`, build);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(existsSync(join(app, 'node_modules/@secondbrain/hiring-desk/package.json'))).toBe(true);
  });
  it('installs and builds in a stage while the live tree keeps working, then swaps the new build in', () => {
    const app = liveApp();
    // The install runs in data/release, and fails the release unless the live CLI still loads v1 at that moment.
    const install = [
      `node ${join(app, 'server/dist/cli-org.js')} recall | grep -qx 'cli-org.js 1 recall'`,
      `mkdir -p node_modules/dep && printf '{"name":"dep","version":"2","type":"module","exports":"./index.js"}' > node_modules/dep/package.json`,
      `printf "export const version = '2';\\n" > node_modules/dep/index.js`,
    ].join(' && ');
    const build = `mkdir -p server/dist && for c in cli-org.js cli-memory.js; do printf "import { version } from 'dep';\\nconsole.log('%s ' + version + ' ' + process.argv.slice(2).join(' '));\\n" "$c" > server/dist/$c; done`;
    const r = run(app, install, build);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('the shared-memory CLIs load from the new build');
    expect(cli(app, 'cli-org.js', 'recall', 'zod').stdout.trim()).toBe('cli-org.js 2 recall zod');
    expect(cli(app, 'cli-memory.js', 'recall', 'zod').stdout.trim()).toBe('cli-memory.js 2 recall zod');
    expect(existsSync(join(app, 'data/release'))).toBe(false);
    expect(readFileSync(join(app, 'data/keep.txt'), 'utf8')).toBe('not shipped\n');
  });

  it('a build whose CLI cannot load its dependencies is refused and the live tree is left as it was', () => {
    const app = liveApp();
    const build = `mkdir -p server/dist && for c in cli-org.js cli-memory.js; do printf "import 'zod-that-is-not-installed';\\n" > server/dist/$c; done`;
    const r = run(app, 'mkdir -p node_modules', build);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('server/dist/cli-org.js does not load from the new build; the live tree is unchanged');
    expect(cli(app, 'cli-org.js', 'recall', 'zod').stdout.trim()).toBe('cli-org.js 1 recall zod');
    expect(JSON.parse(readFileSync(join(app, 'node_modules/dep/package.json'), 'utf8')).version).toBe('1');
  });

  it('a failed install changes nothing live', () => {
    const app = liveApp();
    const r = run(app, 'exit 7', 'true');
    expect(r.status).not.toBe(0);
    expect(cli(app, 'cli-org.js', 'help').stdout.trim()).toBe('cli-org.js 1 help');
  });
});

// The real artifact (CI builds before it tests): from its documented place, app/server/dist, each shared-memory CLI
// loads zod and the rest of its graph and gets into recall. With no database it must stop at the connection, not at
// a module it cannot find.
describe.skipIf(!existsSync(join(APP_ROOT, 'server/dist/cli-org.js')))('the built shared-memory CLIs', () => {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir(), VAULT_ROOT: mkdtempSync(join(tmpdir(), 'sb-vault-')),
    DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nothing', MODULES: 'org',
  };
  for (const [name, args] of [['cli-org.js', ['recall', 'zod']], ['cli-memory.js', ['recall', 'zod']]] as const) {
    it(`server/dist/${name} ${args.join(' ')} resolves its runtime dependencies and reaches the database`, () => {
      const r = spawnSync('node', ['--no-warnings', join(APP_ROOT, 'server/dist', name), ...args], { encoding: 'utf8', env, timeout: 30_000 });
      const out = r.stdout + r.stderr;
      expect(out).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (package|module)/);
      expect(out).toMatch(/ECONNREFUSED/);
      expect(r.status).toBe(1);
    });
  }
});
