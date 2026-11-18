import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { routes } from './routes.js';

describe('desk addon routes', () => {
  it('returns an explicit unavailable response when the operator service is not configured', async () => {
    const app = express();
    const featureRoutes = routes({
      app,
      vaultRoot: '/tmp/synthetic-vault',
      remote: false,
      opts: {},
    });
    const operator = featureRoutes.find((route) => route.path === '/api/desk');

    expect(operator).toBeDefined();
    app.use(operator!.path, operator!.router);

    const response = await request(app).get('/api/desk/inbox');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: { code: 'unavailable', message: 'Hiring desk operator service is not configured' },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
