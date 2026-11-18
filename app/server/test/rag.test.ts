import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { embedVault } from '../src/embeddings/embed.js';
import type { ChatEvent, ChatProvider, ChatRequest } from '../src/llm/types.js';
import { buildSystemPrompt } from '../src/rag/prompt.js';
import type { Reranker } from '../src/rag/rerank.js';
import { condensePrompt, keywordQuery, parseCondensed, retrieve } from '../src/rag/retrieve.js';
import { fakeProvider } from './embedProvider.js';
import { truncateAll } from './helpers.js';

const NOTES: [string, string, string][] = [
  ['baking.md', 'Weekend Baking', [
    '## Starter', 'Feed the sourdough starter with flour before baking bread in the oven.',
    '## Timing', 'Bulk ferment the dough four hours, then shape and proof overnight.',
    '## Oven', 'Bake at 250 with steam for twenty minutes, then without.',
  ].join('\n\n')],
  ['pg.md', 'Postgres Notes', '## Indexes\n\nA postgres index makes a sql query fast; the schema matters. The database plans it.'],
  ['music.md', 'Practice Log', '## Chords\n\nThe song needs one more chord; the melody carries the music.'],
  ['heater.md', 'Garage Heater', '## Decision\n\nWe picked the electric unit over diesel: cheaper to run and no fumes. Model ZX-900.'],
];

/** A chat model that answers every call with the same text, and records what it was asked. */
function fakeLlm(answer: string): ChatProvider & { asked: ChatRequest[] } {
  const p = {
    id: 'fake',
    model: 'fake-chat',
    asked: [] as ChatRequest[],
    async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      p.asked.push(req);
      yield { type: 'delta', text: answer };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'stop' };
    },
  };
  return p;
}

const embedding = fakeProvider();

beforeEach(async () => {
  await truncateAll();
  for (const [path, title, body] of NOTES) {
    await query(
      `INSERT INTO vault_files (path,parent_path,name,title,ext,is_markdown,size_bytes,mtime,content_hash,body)
       VALUES ($1,'',$2,$3,'.md',true,$4,now(),$5,$6)`,
      [path, path, title, body.length, `h-${path}`, body],
    );
  }
  await embedVault({ provider: fakeProvider(), maxChunkTokens: 60, overlapTokens: 0, batchSize: 8 });
});

describe('keywordQuery', () => {
  it('ORs the words so a question still matches a note missing some of them, and keeps phrases', () => {
    expect(keywordQuery('what did I decide about the garage heater')).toBe('what OR did OR decide OR about OR the OR garage OR heater');
    expect(keywordQuery('"electric unit" fumes')).toBe('"electric unit" OR fumes');
    expect(keywordQuery('')).toBe('');
  });
});

describe('parseCondensed', () => {
  it('reads the JSON, drops an alternate equal to the query, and falls back to the question', () => {
    expect(parseCondensed('```json\n{"query":"garage heater decision","alternates":["Garage Heater decision","diesel vs electric heater"]}\n```', 'x'))
      .toEqual({ query: 'garage heater decision', alternates: ['diesel vs electric heater'] });
    expect(parseCondensed('not json', 'the question')).toEqual({ query: 'the question', alternates: [] });
    expect(parseCondensed('{"query": ""}', 'q')).toEqual({ query: 'q', alternates: [] });
  });

  it('the condense prompt carries the history and the latest message', () => {
    const p = condensePrompt([{ role: 'user', content: 'tell me about the heater' }, { role: 'assistant', content: 'You chose electric.' }], 'why?', true);
    expect(p).toContain('User: tell me about the heater');
    expect(p).toContain('Assistant: You chose electric.');
    expect(p).toContain('why?');
    expect(p).toContain('alternate');
  });
});

describe('retrieve', () => {
  it('finds the right note by meaning, numbers the passages and reports which arms ran', async () => {
    const r = await retrieve('dough oven flour', { embedding });
    expect(r.vector).toBe(true);
    expect(r.keyword).toBe(true);
    expect(r.passages[0]!.path).toBe('baking.md');
    expect(r.passages.map((p) => p.n)).toEqual(r.passages.map((_, i) => i + 1));
    expect(r.queries).toEqual(['dough oven flour']);
  });

  it('finds a note by an identifier the embedder knows nothing about, through the keyword arm', async () => {
    const r = await retrieve('ZX-900', { embedding });
    expect(r.passages[0]!.path).toBe('heater.md');
  });

  it('works without an embedding provider, keyword only', async () => {
    const r = await retrieve('diesel fumes', { embedding: null });
    expect(r.vector).toBe(false);
    expect(r.passages[0]!.path).toBe('heater.md');
  });

  it('widens a hit with its neighbouring chunks and merges them into one passage', async () => {
    const { rows } = await query<{ n: number }>(`SELECT count(*)::int n FROM vault_chunks c JOIN vault_files f ON f.id=c.file_id WHERE f.path='baking.md'`);
    expect(rows[0]!.n).toBeGreaterThanOrEqual(3);
    const r = await retrieve('bulk ferment the dough', { embedding, topK: 1 });
    const p = r.passages[0]!;
    expect(p.path).toBe('baking.md');
    expect(p.chunk_to - p.chunk_from).toBeGreaterThanOrEqual(1);
    expect(p.content).toContain('ferment');
    // The prefix line appears once, not once per merged chunk.
    expect(p.content.split('Weekend Baking >').length - 1).toBe(1);
  });

  it('caps passages per note and honours the token budget', async () => {
    const r = await retrieve('bread sourdough dough oven flour baking', { embedding, perFile: 1, topK: 5 });
    expect(r.passages.filter((p) => p.path === 'baking.md')).toHaveLength(1);
    const tight = await retrieve('bread sourdough dough oven flour baking', { embedding, maxTokens: 1, topK: 5 });
    expect(tight.passages).toHaveLength(1); // the budget never drops the best hit
  });

  it('condenses a follow-up against the history and fuses the alternates it suggests', async () => {
    const llm = fakeLlm('{"query":"garage heater decision electric diesel","alternates":["ZX-900"]}');
    const r = await retrieve('and why that one?', {
      embedding,
      llm,
      multiQuery: true,
      history: [{ role: 'user', content: 'which heater did I pick' }, { role: 'assistant', content: 'The electric one [1].' }],
    });
    expect(llm.asked).toHaveLength(1);
    expect(llm.asked[0]!.messages[0]!.content).toContain('which heater did I pick');
    expect(r.queries).toEqual(['garage heater decision electric diesel', 'ZX-900']);
    expect(r.passages[0]!.path).toBe('heater.md');
  });

  it('does not call the model on a first question when no alternates are wanted', async () => {
    const llm = fakeLlm('{"query":"ignored"}');
    const r = await retrieve('sourdough starter', { embedding, llm, multiQuery: false });
    expect(llm.asked).toHaveLength(0);
    expect(r.passages[0]!.path).toBe('baking.md');
  });

  it('lets a reranker reorder the fused candidates and says so', async () => {
    const reranker: Reranker = {
      model: 'fake-rerank',
      // Whatever came in, the postgres chunk wins.
      rerank: async (_q, docs) => docs.map((d, index) => ({ index, score: d.includes('postgres') ? 1 : 0 })).sort((a, b) => b.score - a.score),
    };
    const r = await retrieve('sourdough bread postgres', { embedding, reranker });
    expect(r.reranked).toBe(true);
    expect(r.passages[0]!.path).toBe('pg.md');
  });

  it('returns nothing for an empty question without touching the database', async () => {
    expect(await retrieve('   ', { embedding })).toMatchObject({ passages: [], vector: false, keyword: false });
  });
});

describe('buildSystemPrompt', () => {
  it('puts the base prompt first, the persona next, and the numbered passages last', () => {
    const s = buildSystemPrompt({
      base: 'BASE',
      persona: { name: 'ada', role: 'researcher', prompt: 'Be precise.' },
      passages: [{ n: 1, file_id: 1, path: 'a.md', title: 'A', heading_path: 'H', chunk_from: 0, chunk_to: 1, content: 'A > H\n\nbody', score: 1, tokens: 3 }],
      today: '2026-10-24',
    });
    expect(s.indexOf('BASE')).toBeLessThan(s.indexOf('ada'));
    expect(s.indexOf('ada')).toBeLessThan(s.indexOf('<passages>'));
    expect(s).toContain('[1] A (a.md › H)');
    expect(s).toContain('Today is 2026-10-24');
  });

  it('tells the model when nothing was retrieved', () => {
    expect(buildSystemPrompt({ base: 'B', passages: [] })).toContain('No passages were retrieved');
  });
});
