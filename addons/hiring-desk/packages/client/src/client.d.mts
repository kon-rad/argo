import type { Acceptance, DeskClient, EntityRef, Job, Observation, PaymentIntent, Result } from '@secondbrain/desk-contracts/desk';
export declare function publicMutation(record: unknown, idempotencyKey: string): string;
export declare function publicPath(path: string): string;
export interface AuthorizedWallet { address(): Promise<string>; publishRecord(record: unknown, idempotencyKey: string): Promise<import('@secondbrain/desk-contracts/desk').Confirmation>; submit(chainId: string, transaction: unknown): Promise<{hash:string}> }
export declare function postWithWallet(wallet: AuthorizedWallet, job: Job, idempotencyKey: string): Promise<Result<import('@secondbrain/desk-contracts/desk').Confirmation>>;
export declare function acceptWithWallet(wallet: AuthorizedWallet, acceptance: Acceptance, idempotencyKey: string): Promise<Result<import('@secondbrain/desk-contracts/desk').Confirmation>>;
export declare function publishAuthorizedRecord(wallet: AuthorizedWallet, record: unknown, authorField: string, idempotencyKey: string): Promise<Result<import('@secondbrain/desk-contracts/desk').Confirmation>>;
export declare class PublicHttpDeskClient implements DeskClient {
  readonly mode: 'live';
  constructor(baseUrl: string, fetcher?: typeof fetch);
  discover(): Promise<Result<Observation[]>>;
  post(job: Job, idempotencyKey: string): Promise<Result<import('@secondbrain/desk-contracts/desk').Confirmation>>;
  offers(jobRef: EntityRef): Promise<Result<Observation[]>>;
  accept(acceptance: Acceptance, idempotencyKey: string): Promise<Result<import('@secondbrain/desk-contracts/desk').Confirmation>>;
  inspect(jobRef: EntityRef): Promise<Result<import('@secondbrain/desk-contracts/desk').PublicState>>;
  preparePayment(intent: PaymentIntent): Promise<Result<{chainId:string; transaction:unknown}>>;
  independentRead(jobRef: EntityRef): Promise<Result<Observation[]>>;
  reduce(jobRef: EntityRef, observations: Observation[], now?: number): Promise<import('@secondbrain/desk-contracts/desk').PublicState>;
}
export declare function submitPreparedPayment(client: DeskClient, wallet: AuthorizedWallet, intent: PaymentIntent): Promise<Result<{hash:string}>>;
export declare function submitPreparedTransaction(wallet: AuthorizedWallet, intent: PaymentIntent, prepared: {chainId:string; transaction:unknown}): Promise<Result<{hash:string}>>;
