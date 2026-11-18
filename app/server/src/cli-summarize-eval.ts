import { exitFlushed } from './cli-exit.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool, query } from './db.js';
import { summaryConfig } from './summaries/config.js';
import { loadGolden } from './summaries/eval/golden.js';
import { grade, gradeReferences, report, runGolden, combine, type Graded } from './summaries/eval/run.js';
import { loadParts } from './summaries/input.js';
import { PROMPT_VERSION } from './summaries/schema.js';

// secondbrain summarize-eval --golden [DIR]   write a summary for each golden transcript with the real provider chain, grade it
//                            --references     grade the hand-written reference summaries (proves the checks; no model)
//                            --sample N       grade the N most recent stored summaries against their archived transcripts
//   --judge   add the model judge   --min 0.8   exit 1 if the mean is lower   --out FILE   also write the markdown report
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const arg = (f: string): string | undefined => { const i = argv.indexOf(f); const v = i >= 0 ? argv[i + 1] : undefined; return v && !v.startsWith('--') ? v : undefined; };
const log = (m: string) => console.error(`${new Date().toISOString()} ${m}`);
const defaultGolden = resolve(import.meta.dirname, '..', 'test', 'fixtures', 'summaries');

let code = 1;
try {
  const cfg = summaryConfig();
  const min = Number(arg('--min') ?? '0.8');
  let graded: Graded[] = [];
  let title = 'Summary evaluation';
  if (has('--references')) {
    graded = await gradeReferences(loadGolden(arg('--golden') ?? defaultGolden), cfg);
    title = 'Reference summaries graded against their own transcripts';
  } else if (has('--golden')) {
    graded = await runGolden(loadGolden(arg('--golden') ?? defaultGolden), cfg, { judge: has('--judge') });
    title = `Golden set, written by ${cfg.chain[0]!.provider}/${cfg.chain[0]!.model} (first in the chain)`;
  } else if (arg('--sample')) {
    const { rows } = await query<{ session_id: number; request: string; done: string; learned: string; open_items: string; outcome: string; writer_provider: string; writer_model: string }>(
      `SELECT s.session_id, s.request, s.done, s.learned, s.open_items, s.outcome, s.writer_provider, s.writer_model
         FROM agent_summaries s WHERE s.status = 'ok' AND s.prompt_version = $1 ORDER BY s.updated_at DESC LIMIT $2`,
      [PROMPT_VERSION, Number(arg('--sample'))]);
    for (const r of rows) {
      const facts = (await query<{ subject: string; claim: string }>(`SELECT subject, claim FROM agent_summary_facts WHERE summary_id = (SELECT id FROM agent_summaries WHERE session_id = $1 AND prompt_version = $2)`, [r.session_id, PROMPT_VERSION])).rows;
      graded.push(await grade(`session ${r.session_id}`, { request: r.request, done: r.done, learned: r.learned, open_items: r.open_items, outcome: r.outcome as 'unknown', facts },
        await loadParts(r.session_id), cfg, { judge: has('--judge'), writer: `${r.writer_provider}/${r.writer_model}` }));
    }
    title = `Last ${rows.length} stored summaries graded against their transcripts`;
  } else {
    throw new Error('choose --golden, --references or --sample N');
  }
  const md = report(graded, title);
  console.log(md);
  if (arg('--out')) writeFileSync(arg('--out')!, md);
  const mean = combine(graded.map((g) => g.score));
  log(`mean ${mean} (gate ${min})`);
  code = graded.length && mean >= min ? 0 : 1;
} catch (err) {
  log(`summarize-eval failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
await exitFlushed(code);
