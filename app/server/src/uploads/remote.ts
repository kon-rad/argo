import { spawn, spawnSync } from 'node:child_process';

/** The vault side of the bucket (`vault/<path>`, encrypted when a crypt password is set), as the ingest step needs it. */
export interface VaultRemote {
  /** Names and sizes of the files directly in `vault/<dir>`; empty when the folder doesn't exist yet. */
  listFiles(dir: string): Promise<Map<string, number>>;
  /** Streams `inbox/...` (plain) into `vault/<dest>` (encrypted), without touching the local disk. */
  copyFromInbox(inboxKey: string, destPath: string): Promise<void>;
}

export interface RcloneConfig {
  keyId: string;
  appKey: string;
  bucket: string;
  cryptPassword?: string;
  cryptPassword2?: string;
  bin?: string;
}

const TAIL = 1500;

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-TAIL);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

function obscure(bin: string, secret: string): string {
  const r = spawnSync(bin, ['obscure', '-'], { input: secret, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('rclone obscure failed');
  return r.stdout.trim();
}

/** rclone with the remotes defined in its environment, the way `b2store` sets them up. Secrets never reach argv or logs. */
export function rcloneRemote(cfg: RcloneConfig): VaultRemote {
  const bin = cfg.bin ?? 'rclone';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The remotes below live in the environment; no config file is read, so an unreadable $HOME can't break it.
    RCLONE_CONFIG: '/dev/null',
    RCLONE_CONFIG_SBRAW_TYPE: 'b2',
    RCLONE_CONFIG_SBRAW_ACCOUNT: cfg.keyId,
    RCLONE_CONFIG_SBRAW_KEY: cfg.appKey,
  };
  let vaultBase = `sbraw:${cfg.bucket}`;
  if (cfg.cryptPassword) {
    env['RCLONE_CONFIG_SBCRYPT_TYPE'] = 'crypt';
    env['RCLONE_CONFIG_SBCRYPT_REMOTE'] = `sbraw:${cfg.bucket}`;
    env['RCLONE_CONFIG_SBCRYPT_PASSWORD'] = obscure(bin, cfg.cryptPassword);
    if (cfg.cryptPassword2) env['RCLONE_CONFIG_SBCRYPT_PASSWORD2'] = obscure(bin, cfg.cryptPassword2);
    vaultBase = 'sbcrypt:';
  }
  const vault = (p: string): string => (vaultBase.endsWith(':') ? `${vaultBase}vault/${p}` : `${vaultBase}/vault/${p}`);

  return {
    async listFiles(dir) {
      const r = await run(bin, ['lsjson', '--files-only', vault(dir)], env);
      if (r.code === 3) return new Map(); // directory not found
      if (r.code !== 0) throw new Error(`rclone lsjson failed: ${r.err.trim().split('\n').pop()}`);
      const rows = JSON.parse(r.out || '[]') as { Name: string; Size: number }[];
      return new Map(rows.map((row) => [row.Name, row.Size]));
    },
    async copyFromInbox(inboxKey, destPath) {
      const r = await run(
        bin,
        [
          'copyto',
          `sbraw:${cfg.bucket}/${inboxKey}`,
          vault(destPath),
          '--b2-chunk-size',
          '32M',
          '--transfers',
          '1',
          '--retries',
          '5',
          '--low-level-retries',
          '10',
          '--buffer-size',
          '16M',
          '-q',
        ],
        env,
      );
      if (r.code !== 0) throw new Error(`rclone copyto failed: ${r.err.trim().split('\n').pop()}`);
    },
  };
}
