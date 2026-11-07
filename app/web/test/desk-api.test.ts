import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpDeskOperatorApi } from '../src/routes/desk/api.js';

afterEach(() => vi.unstubAllGlobals());

describe('desk HTTP API', () => {
  it('shows the server error message for an unavailable operator service', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'unavailable', message: 'Hiring desk operator service is not configured' },
    }), { status: 503, headers: { 'content-type': 'application/json' } })));

    await expect(createHttpDeskOperatorApi().inbox()).resolves.toEqual({
      kind: 'unavailable',
      message: 'Hiring desk operator service is not configured',
    });
  });
});
