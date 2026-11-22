import { vi } from 'vitest';
import type { MarketBoardAdapter, MarketCard } from '../market/board.js';

/** In-memory board with the host's semantics: create is ready+unassigned, assign keeps status, ids are unique. */
export function memoryBoard() {
  const cards = new Map<string, MarketCard & { title: string; body: string }>();
  const board = {
    get: vi.fn(async (id: string) => { const card = cards.get(id); return card ? { ...card } : null; }),
    create: vi.fn(async (input: Parameters<MarketBoardAdapter['create']>[0]) => {
      const existing = cards.get(input.id);
      if (existing) return { ...existing };
      const card = { id: input.id, title: input.title, body: input.body, contract: { ...input.contract }, assignee: null, status: 'ready' };
      cards.set(input.id, card);
      return { ...card };
    }),
    move: vi.fn(async (id: string, status: string) => { const card = cards.get(id)!; card.status = status; return { ...card }; }),
    assign: vi.fn(async (id: string, agent: string) => { const card = cards.get(id)!; card.assignee = agent; return { ...card }; }),
  };
  return { board, cards };
}

/** A fake Cybazaar API. Routes are matched by method and path; unknown routes answer 404 like an older build. */
export function fakeCybazaar(routes: Record<string, (body: unknown, url: URL) => unknown>) {
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const fetcher = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body, auth: new Headers(init?.headers).get('authorization') });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response('{}', { status: 404 });
    const value = route(body, url);
    if (value instanceof Response) return value;
    return Response.json(value);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
