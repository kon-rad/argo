import { z } from 'zod';
import { commandDefinition, commandRequest } from '@secondbrain/contracts/hosts';

export const usage = 'secondbrain host-command list | describe <command> | submit <command> <request-key> | status <run-id> | result <run-id>';
export const ownerSession = z.strictObject({
  origin: z.string().url(),
  cookie: z.string().regex(/^(?:__Host-)?sb_session=[A-Za-z0-9_-]{43}$/),
});

export async function runOwnerCommand(args: string[], session: z.infer<typeof ownerSession>,
  readInput: () => Promise<string>, send: typeof fetch = fetch) {
  const {origin, cookie} = ownerSession.parse(session);
  const server = new URL(origin);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(server.hostname);
  if ((server.protocol !== 'https:' && !(server.protocol === 'http:' && local)) ||
      server.username || server.password || server.search || server.hash || server.pathname !== '/')
    throw new Error('Expected an HTTPS origin or loopback HTTP');
  const [action, id, key] = args;
  let path: string;
  let body: string | undefined;
  if (action === 'list' && args.length === 1) {
    path = 'commands';
  } else if (action === 'describe' && args.length === 2 && commandDefinition.shape.id.safeParse(id).success) {
    path = 'commands/' + id;
  } else if (action === 'submit' && args.length === 3 &&
      commandDefinition.shape.id.safeParse(id).success && commandRequest.shape.requestKey.safeParse(key).success) {
    path = 'requests';
    body = JSON.stringify(commandRequest.parse({command: id, requestKey: key, text: await readInput()}));
  } else if ((action === 'status' || action === 'result') && args.length === 2 && z.string().uuid().safeParse(id).success) {
    path = 'requests/' + id;
  } else {
    throw new Error(usage);
  }
  const response = await send(server.origin + '/api/host-pilot/' + path, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Cookie: cookie, Origin: server.origin, 'Content-Type': 'application/json' }, body,
  });
  if (!response.ok) throw new Error('Host command ' + action + ' returned HTTP ' + response.status);
  const data = await response.json();
  if (action !== 'result') return data;
  const run = z.object({state: z.string(), result: z.unknown()}).parse(data);
  if (run.state !== 'succeeded') throw new Error('Run is ' + run.state + '. Use status for details.');
  return run.result;
}
