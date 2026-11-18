import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { DeskOperatorApi } from '@secondbrain/desk-contracts/desk';
import { MemoryDeskPersistence, DeskStoreError, type AssignmentRecord } from './store.js';
import { deskOperatorRouter, type DeskPrivateControls } from '../operator/routes.js';

function assignment(): AssignmentRecord {
  return { id: 'arc-test:31337/job-1', revision: 0, publicState: { stage: 'posted', jobRef: 'arc-test:31337/job-1', conflict: false, rejected: [] }, execution: 'awaiting_operator' };
}

describe('desk private persistence', () => {
  it('serializes competing mutations and rejects the stale revision', async () => {
    const db = new MemoryDeskPersistence(); await db.seed(assignment());
    const mutate = (idempotencyKey: string) => db.mutate('arc-test:31337/job-1', { action: 'approve', idempotencyKey, expectedRevision: 0, actor: 'operator', apply: row => { row.execution = 'approved'; return row; } });
    const results = await Promise.allSettled([mutate('one'), mutate('two')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(DeskStoreError);
    expect((await db.get('arc-test:31337/job-1'))?.revision).toBe(1);
  });

  it('replays an idempotent response without advancing revision', async () => {
    const db = new MemoryDeskPersistence(); await db.seed(assignment());
    const mutation = { action: 'approve', idempotencyKey: 'same', expectedRevision: 0, actor: 'operator', apply: (row: AssignmentRecord) => { row.execution = 'approved'; return row; } };
    const first = await db.mutate('arc-test:31337/job-1', mutation);
    const retry = await db.mutate('arc-test:31337/job-1', mutation);
    expect(retry.replayed).toBe(true);
    expect(retry.record.revision).toBe(first.record.revision);
  });

  it('reserves each payment receipt for at most one assignment and permits same-job retries', async () => {
    const db = new MemoryDeskPersistence();
    expect(await db.reservePayment('arc-test:31337/job-1', 'receipt-1')).toBe(true);
    expect(await db.reservePayment('arc-test:31337/job-1', 'receipt-1')).toBe(true);
    expect(await db.reservePayment('arc-test:31337/job-2', 'receipt-1')).toBe(false);
  });

  it('requires the session gate on every private route', async () => {
    const unavailable = async () => ({ kind: 'unavailable' as const, message: 'test' });
    const api = Object.fromEntries(['inbox','jobs','job','providers','approve','decline','cancel','preview','release','dispatch','reconcileClaim','reconcileRunner','reconcilePayment'].map(name => [name, unavailable])) as unknown as DeskPrivateControls & DeskOperatorApi;
    const app = express(); app.use(express.json());
    app.use('/api/desk', deskOperatorRouter(api, (req, res, next) => req.headers.authorization ? next() : res.sendStatus(401)));
    expect((await request(app).get('/api/desk/inbox')).status).toBe(401);
    expect((await request(app).get('/api/desk/jobs').set('Authorization', 'session')).status).toBe(503);
  });
});
