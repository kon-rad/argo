import { reducePublicState } from '@secondbrain/desk-contracts/desk';
import { canonicalJson, parseRecord } from '@secondbrain/desk-contracts/desk';
import type { DeskPublicStore, DeskRecord, EntityRef, Observation, Result } from '@secondbrain/desk-contracts/desk';
import type { DeskSnapshots } from '../orchestration/service.js';

/** One stable Arkiv keyset page, already decoded by the selected SDK/schema adapter. */
export interface ArkivRow {
  key: string;
  creator: string;
  createdAt: number;
  expiresAt: number;
  finalized: boolean;
  record: unknown;
}
export interface ArkivPage { rows: readonly ArkivRow[]; blockNumber: bigint; finalized: boolean }
export interface ArkivWrite { key: string; transactionHash: string; confirmed: boolean; record: unknown }

/**
 * Narrow seam around the Arkiv SDK. Its implementation must use a schema-tagged query,
 * `createdBy` where appropriate, `$key ASC` plus `$key > cursor`, and translate SDK
 * block timestamps/expiry from blocks to Unix seconds. It must pin every page to a
 * consistent snapshot or report `finalized: false`; offset pagination is unsafe here.
 */
export interface ArkivDeskClient {
  page(input: { afterKey?: string; limit: number; atBlock?: bigint }): Promise<ArkivPage>;
  get(key: string): Promise<ArkivRow | null>;
  create(record: DeskRecord, idempotencyKey: string): Promise<ArkivWrite>;
  findByIdempotencyKey(idempotencyKey: string): Promise<ArkivWrite | null>;
  confirmation(key: string): Promise<ArkivWrite | null>;
}

export interface ArkivStoreOptions {
  domain: string;
  chainId: string;
  client: ArkivDeskClient;
  pageSize?: number;
  maxPages?: number;
  now?: () => number;
}

const refFor = (chainId: string, key: string) => `${chainId.includes(':') ? chainId : `arkiv:${chainId}`}/${key}`;
const failure = (kind: 'invalid-input' | 'denied' | 'pending' | 'unavailable' | 'failed', message: string): Result<never> => ({ kind, message });

function expectedCreator(record: DeskRecord): string {
  switch (record.type) {
    case 'provider': return record.owner;
    case 'job': return record.client;
    case 'offer': case 'claim': case 'delivery': return record.provider;
    case 'acceptance': return record.client;
    case 'payment': return record.payer;
  }
}

function observation(row: ArkivRow, domain: string, chainId: string, now: number): Observation {
  if (!row || !row.finalized || typeof row.key !== 'string' || !row.key || typeof row.creator !== 'string' || !row.creator ||
      !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !Number.isSafeInteger(row.expiresAt) || row.expiresAt < 0) {
    throw new Error('Arkiv row lacks trusted key, creator, timestamp, or expiry');
  }
  if (row.expiresAt <= now) throw new Error('Arkiv record is expired');
  const record = parseRecord(row.record);
  if (record.domain !== domain || record.chainId !== chainId) throw new Error('Arkiv record domain or chain mismatch');
  if (row.creator !== expectedCreator(record)) throw new Error('Arkiv immutable creator does not match the record authority');
  return { ref: refFor(chainId, row.key), creator: row.creator, observedAt: row.createdAt, finalized: true, record };
}

export class ArkivDeskPublicStore implements DeskPublicStore {
  readonly mode = 'live' as const;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly now: () => number;
  constructor(private readonly options: ArkivStoreOptions) {
    this.pageSize = options.pageSize ?? 100;
    this.maxPages = options.maxPages ?? 100;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    if (!options.domain || !options.chainId || this.pageSize < 1 || this.pageSize > 100 || this.maxPages < 1) throw new Error('Invalid Arkiv store configuration');
  }

  async listJobs(): Promise<Result<Observation[]>> {
    const listed = await this.all();
    return listed.kind === 'ok'
      ? { kind: 'ok', value: listed.value.filter(value => (value.record as DeskRecord).type === 'job') }
      : listed;
  }

  /** One bounded finalized view used by snapshots and job discovery. */
  async all(): Promise<Result<Observation[]>> {
    try {
      const observations: Observation[] = [];
      let afterKey: string | undefined;
      let snapshot: bigint | undefined;
      for (let pageNo = 0; pageNo < this.maxPages; pageNo++) {
        const page = await this.options.client.page({ afterKey, limit: this.pageSize, ...(snapshot === undefined ? {} : { atBlock: snapshot }) });
        if (!page.finalized) return failure('unavailable', 'Arkiv snapshot has not reached configured finality');
        if (snapshot === undefined) snapshot = page.blockNumber;
        if (page.blockNumber !== snapshot) return failure('unavailable', 'Arkiv pagination did not hold a stable block snapshot');
        if (page.rows.length > this.pageSize) return failure('failed', 'Arkiv source exceeded requested page size');
        if (page.rows.length === 0) return { kind: 'ok', value: observations };
        for (const row of page.rows) {
          if (afterKey !== undefined && row.key <= afterKey) return failure('failed', 'Arkiv keyset page was not strictly ordered');
          observations.push(observation(row, this.options.domain, this.options.chainId, this.now()));
          afterKey = row.key;
        }
        if (page.rows.length < this.pageSize) return { kind: 'ok', value: observations };
      }
      return failure('unavailable', 'Arkiv listing exceeded the configured page bound');
    } catch (error) {
      return failure('unavailable', error instanceof Error ? error.message : 'Arkiv read failed');
    }
  }

  async get(ref: EntityRef): Promise<Result<Observation>> {
    const key = this.keyFromRef(ref);
    if (!key) return failure('invalid-input', 'Invalid Arkiv entity reference');
    try {
      const row = await this.options.client.get(key);
      if (!row) return failure('unavailable', 'Arkiv entity was not found or has expired');
      return { kind: 'ok', value: observation(row, this.options.domain, this.options.chainId, this.now()) };
    } catch (error) { return failure('unavailable', error instanceof Error ? error.message : 'Arkiv read failed'); }
  }

  async publish(recordInput: DeskRecord, idempotencyKey: string): Promise<Result<{ status: 'pending' | 'confirmed'; ref?: EntityRef; transactionHash?: string }>> {
    let record: DeskRecord;
    try { record = parseRecord(recordInput); } catch (error) { return failure('invalid-input', error instanceof Error ? error.message : 'Invalid record'); }
    if (record.domain !== this.options.domain || record.chainId !== this.options.chainId) return failure('invalid-input', 'Record domain or chain mismatch');
    if (!idempotencyKey || idempotencyKey.length > 200) return failure('invalid-input', 'Invalid idempotency key');
    try {
      const prior = await this.options.client.findByIdempotencyKey(idempotencyKey);
      if (prior && canonicalJson(prior.record) !== canonicalJson(record)) return failure('denied', 'Idempotency key is already bound to different record bytes');
      const write = prior ?? await this.options.client.create(record, idempotencyKey);
      const ref = refFor(this.options.chainId, write.key);
      // A write timeout can leave an entity included but not confirmed to this caller.
      // Retry finds the same idempotency key instead of creating another entity.
      return { kind: 'ok', value: { status: write.confirmed ? 'confirmed' : 'pending', ref, transactionHash: write.transactionHash } };
    } catch (error) { return failure('unavailable', error instanceof Error ? error.message : 'Arkiv write outcome is uncertain; retry with the same key'); }
  }

  async confirmation(ref: string): Promise<Result<{ status: 'pending' | 'confirmed' | 'failed'; ref?: string; transactionHash?: string }>> {
    const key = this.keyFromRef(ref);
    if (!key) return failure('invalid-input', 'Invalid Arkiv entity reference');
    try {
      const write = await this.options.client.confirmation(key);
      if (!write) return { kind: 'ok', value: { status: 'pending', ref } };
      return { kind: 'ok', value: { status: write.confirmed ? 'confirmed' : 'pending', ref, transactionHash: write.transactionHash } };
    } catch (error) { return failure('unavailable', error instanceof Error ? error.message : 'Arkiv confirmation unavailable'); }
  }

  /** Apply the frozen reducer only to complete, finalized observations. */
  async state(jobRef: EntityRef) {
    const listed = await this.all();
    if (listed.kind !== 'ok') return listed;
    try { return { kind: 'ok' as const, value: await reducePublicState(listed.value, jobRef, this.now()) }; }
    catch (error) { return failure('failed', error instanceof Error ? error.message : 'Desk reduction failed'); }
  }

  private keyFromRef(ref: string): string | null {
    const prefix = `${this.options.chainId.includes(':') ? this.options.chainId : `arkiv:${this.options.chainId}`}/`;
    return ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : null;
  }
}

/** Builds a complete job graph from one verified Arkiv view; partial reads fail closed. */
export class ArkivDeskSnapshots implements DeskSnapshots {
  readonly mode = 'live' as const;
  constructor(private readonly store: ArkivDeskPublicStore) {}
  async snapshot(jobRef: EntityRef): Promise<Result<Observation[]>> {
    const listed = await this.store.all();
    if (listed.kind !== 'ok') return listed;
    const jobs = listed.value.filter(value => value.ref === jobRef && (value.record as DeskRecord).type === 'job');
    if (jobs.length !== 1) return failure('unavailable', 'Arkiv job snapshot is missing or ambiguous');
    const selected = new Set<string>([jobRef]);
    const output = [...jobs];
    for (const type of ['offer', 'acceptance'] as const) {
      for (const value of listed.value) {
        const record = value.record as DeskRecord;
        if (record.type === type && record.jobRef === jobRef) { output.push(value); selected.add(value.ref); }
      }
    }
    for (const value of listed.value) {
      const record = value.record as DeskRecord;
      if (record.type === 'claim' && selected.has(record.acceptanceRef)) { output.push(value); selected.add(value.ref); }
    }
    for (const value of listed.value) {
      const record = value.record as DeskRecord;
      if ((record.type === 'delivery' && selected.has(record.claimRef)) || (record.type === 'payment' && record.jobRef === jobRef)) output.push(value);
    }
    return { kind: 'ok', value: output };
  }
}
