import type { ProviderWalletIntent } from '@secondbrain/desk-contracts/desk';
import type { Approval, OperatorJob, PublicState, ReleaseBinding, WorkerResult, WorkerSpec } from '@secondbrain/desk-contracts/desk';
import { withTransaction, query as appQuery, type TxClient } from '../../../db.js';

export interface AssignmentRecord {
  id: string;
  revision: number;
  publicState: PublicState;
  execution: OperatorJob['execution'];
  approval?: Approval;
  result?: WorkerResult;
  activeAttemptId?: string;
  dispatchIdempotencyKey?: string;
  workerSpec?: WorkerSpec;
  pendingDeliveryIntent?: { chainId: string; transaction: unknown; idempotencyKey: string; release: ReleaseBinding };
  walletIntents?: Partial<Record<'claim' | 'delivery', { intent: ProviderWalletIntent; txHash?: string }>>;
  paymentReceiptId?: string;
}
export interface AssignmentMutation {
  action: string;
  idempotencyKey: string;
  expectedRevision: number;
  actor: string;
  apply(current: AssignmentRecord): AssignmentRecord;
}
export interface DeskPersistence {
  seed(record: AssignmentRecord): Promise<void>;
  updatePublicState(id: string, state: PublicState): Promise<AssignmentRecord>;
  list(): Promise<AssignmentRecord[]>;
  get(id: string): Promise<AssignmentRecord | null>;
  /** Serializes a revision-checked operation and persists its response before returning. */
  mutate(id: string, mutation: AssignmentMutation): Promise<{ record: AssignmentRecord; replayed: boolean }>;
  /** Atomically reserves a verified receipt for a single assignment. */
  reservePayment(id: string, receiptId: string): Promise<boolean>;
}

type Query = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
const decode = (row: { job_ref: string; revision: number; aggregate: AssignmentRecord }): AssignmentRecord => ({ ...row.aggregate, id: row.job_ref, revision: row.revision });

/** Postgres implementation. Each mutation locks one assignment and writes its idempotency record and audit event in the same transaction. */
export class PgDeskPersistence implements DeskPersistence {
  constructor(private readonly transact: <T>(fn: (query: Query) => Promise<T>) => Promise<T> = fn => withTransaction(c => fn(c.query as Query)), private readonly readQuery: Query = appQuery as Query) {}

  async list(): Promise<AssignmentRecord[]> {
    const { rows } = await this.readQuery<{ job_ref: string; revision: number; aggregate: AssignmentRecord }>('SELECT job_ref, revision, aggregate FROM desk_assignments ORDER BY updated_at DESC');
    return rows.map(decode);
  }
  async seed(record: AssignmentRecord): Promise<void> {
    await this.readQuery('INSERT INTO desk_assignments(job_ref, revision, aggregate) VALUES ($1,$2,$3::jsonb) ON CONFLICT (job_ref) DO NOTHING', [record.id, record.revision, JSON.stringify(record)]);
  }
  async updatePublicState(id: string, state: PublicState): Promise<AssignmentRecord> {
    return this.transact(async q => {
      const selected = await q<{ job_ref: string; revision: number; aggregate: AssignmentRecord }>('SELECT job_ref, revision, aggregate FROM desk_assignments WHERE job_ref=$1 FOR UPDATE', [id]);
      if (!selected.rows[0]) throw new DeskStoreError('not-found');
      const current = decode(selected.rows[0]);
      if (current.publicState.acceptanceDigest && state.acceptanceDigest && current.publicState.acceptanceDigest !== state.acceptanceDigest) throw new DeskStoreError('conflict');
      if (JSON.stringify(current.publicState) === JSON.stringify(state)) return current;
      current.publicState = state;
      if (current.execution === 'review' && state.stage === 'delivered' && current.pendingDeliveryIntent && state.delivery && state.claim && state.delivery.provider === state.claim.provider && state.claim.executionId === current.activeAttemptId && state.delivery.artifactHash === current.pendingDeliveryIntent.release.artifactHash && state.delivery.mediaType === current.pendingDeliveryIntent.release.mediaType && state.delivery.publicRef === current.pendingDeliveryIntent.release.publicDestination) current.execution = 'released';
      current.revision += 1;
      await q('UPDATE desk_assignments SET revision=$2, aggregate=$3::jsonb, updated_at=now() WHERE job_ref=$1', [id, current.revision, JSON.stringify(current)]);
      await q('INSERT INTO desk_audit_events(job_ref, revision, actor, action, details) VALUES ($1,$2,$3,$4,$5::jsonb)', [id, current.revision, 'public-store', 'public-state-observed', JSON.stringify({ stage: state.stage })]);
      return current;
    });
  }
  async get(id: string): Promise<AssignmentRecord | null> {
    const { rows } = await this.readQuery<{ job_ref: string; revision: number; aggregate: AssignmentRecord }>('SELECT job_ref, revision, aggregate FROM desk_assignments WHERE job_ref = $1', [id]);
    return rows[0] ? decode(rows[0]) : null;
  }
  async mutate(id: string, mutation: AssignmentMutation): Promise<{ record: AssignmentRecord; replayed: boolean }> {
    return this.transact(async q => {
      const replay = await q<{ response: AssignmentRecord }>('SELECT response FROM desk_idempotency WHERE job_ref=$1 AND action=$2 AND idempotency_key=$3', [id, mutation.action, mutation.idempotencyKey]);
      if (replay.rows[0]) return { record: replay.rows[0].response, replayed: true };
      const selected = await q<{ job_ref: string; revision: number; aggregate: AssignmentRecord }>('SELECT job_ref, revision, aggregate FROM desk_assignments WHERE job_ref=$1 FOR UPDATE', [id]);
      if (!selected.rows[0]) throw new DeskStoreError('not-found');
      const current = decode(selected.rows[0]);
      if (current.revision !== mutation.expectedRevision) throw new DeskStoreError('stale-revision');
      const next = mutation.apply(current);
      next.revision = current.revision + 1;
      await q('UPDATE desk_assignments SET revision=$2, aggregate=$3::jsonb, updated_at=now() WHERE job_ref=$1', [id, next.revision, JSON.stringify(next)]);
      await q('INSERT INTO desk_idempotency(job_ref, action, idempotency_key, response) VALUES ($1,$2,$3,$4::jsonb)', [id, mutation.action, mutation.idempotencyKey, JSON.stringify(next)]);
      await q('INSERT INTO desk_audit_events(job_ref, revision, actor, action, details) VALUES ($1,$2,$3,$4,$5::jsonb)', [id, next.revision, mutation.actor, mutation.action, JSON.stringify({ execution: next.execution })]);
      return { record: next, replayed: false };
    });
  }
  async reservePayment(id: string, receiptId: string): Promise<boolean> {
    return this.transact(async q => {
      const result = await q('INSERT INTO desk_payment_allocations(receipt_id, job_ref) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING receipt_id', [receiptId, id]);
      if (result.rows.length === 1) return true;
      const existing = await q<{ job_ref: string }>('SELECT job_ref FROM desk_payment_allocations WHERE receipt_id=$1', [receiptId]);
      return existing.rows[0]?.job_ref === id;
    });
  }
}

export class DeskStoreError extends Error {
  constructor(readonly code: 'not-found' | 'stale-revision' | 'conflict' | 'invalid-state' | 'replayed') { super(code); }
}

/** Simple injectable store for focused service tests and local adapter development. */
export class MemoryDeskPersistence implements DeskPersistence {
  private records = new Map<string, AssignmentRecord>();
  private keys = new Map<string, AssignmentRecord>();
  private receipts = new Map<string, string>();
  private tails = new Map<string, Promise<void>>();
  async list(): Promise<AssignmentRecord[]> { return [...this.records.values()].map(v => structuredClone(v)); }
  async get(id: string): Promise<AssignmentRecord | null> { const row = this.records.get(id); return row ? structuredClone(row) : null; }
  async seed(record: AssignmentRecord): Promise<void> { this.records.set(record.id, structuredClone(record)); }
  async updatePublicState(id: string, state: PublicState): Promise<AssignmentRecord> {
    const current = this.records.get(id); if (!current) throw new DeskStoreError('not-found');
    if (current.publicState.acceptanceDigest && state.acceptanceDigest && current.publicState.acceptanceDigest !== state.acceptanceDigest) throw new DeskStoreError('conflict');
    if (JSON.stringify(current.publicState) !== JSON.stringify(state)) { current.publicState = structuredClone(state); if (current.execution === 'review' && state.stage === 'delivered' && current.pendingDeliveryIntent && state.delivery && state.claim && state.delivery.provider === state.claim.provider && state.claim.executionId === current.activeAttemptId && state.delivery.artifactHash === current.pendingDeliveryIntent.release.artifactHash && state.delivery.mediaType === current.pendingDeliveryIntent.release.mediaType && state.delivery.publicRef === current.pendingDeliveryIntent.release.publicDestination) current.execution = 'released'; current.revision += 1; }
    return structuredClone(current);
  }
  async mutate(id: string, mutation: AssignmentMutation): Promise<{ record: AssignmentRecord; replayed: boolean }> {
    const priorTail = this.tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(id, priorTail.then(() => tail));
    await priorTail;
    try {
      const k = `${id}\0${mutation.action}\0${mutation.idempotencyKey}`;
      const prior = this.keys.get(k); if (prior) return { record: structuredClone(prior), replayed: true };
      const row = this.records.get(id); if (!row) throw new DeskStoreError('not-found');
      if (row.revision !== mutation.expectedRevision) throw new DeskStoreError('stale-revision');
      const next = mutation.apply(structuredClone(row)); next.revision = row.revision + 1;
      this.records.set(id, structuredClone(next)); this.keys.set(k, structuredClone(next));
      return { record: structuredClone(next), replayed: false };
    } finally { release(); }
  }
  async reservePayment(id: string, receiptId: string): Promise<boolean> {
    if (this.receipts.has(receiptId)) return this.receipts.get(receiptId) === id;
    this.receipts.set(receiptId, id); return true;
  }
}
