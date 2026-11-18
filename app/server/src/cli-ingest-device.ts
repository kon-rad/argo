import { exitFlushed } from './cli-exit.js';
import { pool } from './db.js';
import { addDevice, listDevices, revokeDevice } from './ingest/devices.js';

// `secondbrain ingest-device`: the tokens machines' agent ledgers sync with.
//   add <host> [--label <text>] [--display "<name>" --kind laptop|server|pi]   prints the token once
//   list
//   revoke <id>
const [cmd, ...rest] = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

let code = 0;
try {
  if (cmd === 'add' && rest[0] && !rest[0].startsWith('--')) {
    const { id, token } = await addDevice(rest[0], { label: value('label'), display: value('display'), kind: value('kind') });
    console.log(`device ${id} for host ${rest[0]}. Token (shown once; give it to \`ledger install --token\`):\n${token}`);
  } else if (cmd === 'list') {
    for (const d of await listDevices()) {
      console.log([d.id, d.host, d.label ?? '-', d.createdAt.toISOString(), d.lastSeenAt?.toISOString() ?? 'never',
        d.revokedAt ? `revoked ${d.revokedAt.toISOString()}` : 'live'].join('\t'));
    }
  } else if (cmd === 'revoke' && rest[0]) {
    console.log((await revokeDevice(Number(rest[0]))) ? `revoked device ${rest[0]}` : `no live device ${rest[0]}`);
  } else {
    console.error('usage: secondbrain ingest-device add <host> [--label x] [--display "Name" --kind laptop|server|pi] | list | revoke <id>');
    code = 1;
  }
} catch (err) {
  console.error(`ingest-device: ${(err as Error).message}`);
  code = 1;
} finally {
  await pool.end();
}
await exitFlushed(code);
