import type { EmbeddingProvider } from '../src/embeddings/provider.js';

export const DIMS = 1024;

/**
 * A deterministic stand-in for a real encoder. Each axis is a topic; a text's
 * vector is its normalised term counts on those axes. That makes similarity
 * genuinely meaningful — "sourdough starter" really is nearer "bread baking"
 * than "postgres index" — so the retrieval tests assert ranking, not just that
 * some rows came back.
 */
const AXES: readonly (readonly string[])[] = [
  ['bread', 'dough', 'baking', 'sourdough', 'oven', 'flour'],
  ['postgres', 'database', 'index', 'query', 'sql', 'schema'],
  ['guitar', 'chord', 'song', 'music', 'melody'],
];

export function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  const v = new Array<number>(DIMS).fill(0);
  AXES.forEach((terms, axis) => {
    for (const t of terms) {
      const hits = lower.split(t).length - 1;
      v[axis] = (v[axis] ?? 0) + hits;
    }
  });
  const norm = Math.hypot(...v.slice(0, AXES.length));
  // pgvector's cosine distance is undefined for a zero vector; park anything
  // with no topical signal on its own axis instead.
  if (norm === 0) {
    v[AXES.length] = 1;
    return v;
  }
  for (let i = 0; i < AXES.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

export function fakeProvider(model = 'fake-test-model'): EmbeddingProvider & { calls: number; batches: number[] } {
  const p = {
    id: 'together' as const,
    model,
    dimensions: DIMS,
    calls: 0,
    batches: [] as number[],
    async embed(texts: readonly string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      p.calls++;
      p.batches.push(texts.length);
      return texts.map(fakeVector);
    },
  };
  return p;
}
