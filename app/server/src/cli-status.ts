/**
 * The numbers `secondbrain status` prints: the index size, the vectors and the last
 * scan, read from a running server's /api/system and /api/runs. Its own entry so the
 * launcher holds no inline JSON parsing. `--url` names the server (default
 * http://127.0.0.1:$PORT).
 */
import { config } from './config.js';

const argv = process.argv.slice(2);
const urlArg = argv.indexOf('--url');
const url = (urlArg >= 0 ? argv[urlArg + 1] : undefined) ?? `http://127.0.0.1:${config.env.PORT ?? 5123}`;

async function get(path: string): Promise<unknown> {
  try {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const system = (await get('/api/system')) as
  | { counts: { files: number; markdown: number; links: number }; embeddings?: { chunks: number; files_embedded: number; files_embeddable: number; model: string } }
  | null;
const runs = (await get('/api/runs?limit=1')) as { runs: { status: string; started_at: string }[] } | null;

if (system) {
  const c = system.counts;
  console.log(`index     ${c.files} files, ${c.markdown} notes, ${c.links} links`);
  const e = system.embeddings;
  console.log(`vectors   ${!e || !e.chunks ? 'none - run: secondbrain embed' : `${e.chunks} chunks over ${e.files_embedded}/${e.files_embeddable} notes (${e.model})`}`);
}
if (runs) {
  const r = runs.runs[0];
  console.log(`last scan ${r ? `${r.status} at ${new Date(r.started_at).toLocaleString()}` : 'never'}`);
}
