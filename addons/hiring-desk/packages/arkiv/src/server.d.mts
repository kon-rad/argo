import type { DeskRecord } from '@secondbrain/desk-contracts/desk';

export interface ServerArkivOptions {
  rpcUrl: string;
  domain: string;
  chainId: number;
  privateKey: string;
  lifetimeBlocks: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  audit?: (event: Readonly<Record<string, unknown>>) => void;
  walletFactory?: (options: unknown) => { createEntity(...args: unknown[]): Promise<unknown> };
}

export interface ServerArkivWrite { key: string; transactionHash: string; confirmed: boolean; record: unknown }
export interface ServerArkivRow { key: string; creator: string; createdAt: number; expiresAt: number; finalized: boolean; record: unknown }
export class ServerArkivDeskClient {
  constructor(options: ServerArkivOptions);
  signerAddress(): string;
  page(input: { afterKey?: string; limit: number; atBlock?: bigint }): Promise<{ rows: readonly ServerArkivRow[]; blockNumber: bigint; finalized: boolean }>;
  get(key: string): Promise<ServerArkivRow | null>;
  create(record: DeskRecord, idempotencyKey: string): Promise<ServerArkivWrite>;
  findByIdempotencyKey(idempotencyKey: string): Promise<ServerArkivWrite | null>;
  confirmation(key: string): Promise<ServerArkivWrite | null>;
}
