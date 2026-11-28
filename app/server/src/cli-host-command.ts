import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { ownerSession, runOwnerCommand, usage } from './hosts/owner-client.js';

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || ['--help', '-h', 'help'].includes(args[0]!)) {
    console.log(usage);
    return;
  }
  const path = process.env.SECONDBRAIN_OWNER_SESSION_FILE;
  if (!path) throw new Error('Set SECONDBRAIN_OWNER_SESSION_FILE to a private session file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let session;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 4096)
      throw new Error('Expected a private session file owned by the current user');
    session = ownerSession.parse(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }

  const result = await runOwnerCommand(args, session, async () => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 4 * 65536) throw new Error('Inline text exceeds the pilot limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error instanceof SyntaxError ? 'Invalid owner session or response JSON' :
    error instanceof Error ? error.message : 'Host command failed');
  process.exitCode = 1;
});
