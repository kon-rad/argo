import { artifactDigest, isHash } from '@secondbrain/desk-contracts/desk';
import type { Confirmation, DeskPublisher, DeskPublicStore, EntityRef, ReleaseBinding, Result } from '@secondbrain/desk-contracts/desk';

export interface SwarmGateway {
  upload(bytes: Uint8Array, contentType: 'text/markdown; charset=utf-8'): Promise<string>;
  download(reference: string): Promise<Uint8Array>;
}
/** Bee's documented `/bzz` upload/download endpoints; configuration is supplied by the host. */
export class BeeHttpSwarmGateway implements SwarmGateway {
  private readonly base: URL;
  constructor(baseUrl: string, private readonly postageBatchId: string, private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 20_000, private readonly maxBytes = 1_000_000) {
    this.base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || !postageBatchId || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || maxBytes < 1) {
      throw new Error('Invalid Bee gateway configuration');
    }
    this.base.pathname = this.base.pathname.replace(/\/$/, '');
  }
  async upload(bytes: Uint8Array, contentType: 'text/markdown; charset=utf-8'): Promise<string> {
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxBytes) throw new Error('Artifact is empty or exceeds the public-upload size limit');
    const response = await this.request('/bzz', { method: 'POST', headers: { 'Swarm-Postage-Batch-Id': this.postageBatchId, 'Content-Type': contentType }, body: Uint8Array.from(bytes) });
    if (!response.ok) throw new Error(`Bee upload failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    const reference = body && typeof body === 'object' ? (body as { reference?: unknown }).reference : undefined;
    if (typeof reference !== 'string' || !/^[0-9a-f]{64}$/.test(reference)) throw new Error('Bee returned an invalid content reference');
    return reference;
  }
  async download(reference: string): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/.test(reference)) throw new Error('Unsupported or encrypted Swarm reference');
    const response = await this.request(`/bzz/${reference}`, { method: 'GET' });
    if (!response.ok) throw new Error(`Bee download failed with HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxBytes) throw new Error('Downloaded artifact exceeds the public-download size limit');
    return bytes;
  }
  private request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    return this.fetcher(new URL(`${this.base.toString().replace(/\/$/, '')}${path}`), { ...init, redirect: 'error', signal: controller.signal }).finally(() => clearTimeout(timer));
  }
}
export interface PublicationEntry { key: string; binding: ReleaseBinding; claimRef: EntityRef; publicRef?: string; deliveryRef?: EntityRef; status: 'reserved' | 'uploaded' | 'delivered' }
export type ReserveResult = { kind: 'reserved' | 'existing'; entry: PublicationEntry } | { kind: 'conflict' } | { kind: 'in-flight' };
/** Backed by P3's durable transactional store in production; never use an in-memory map. */
export interface PublicationLedger {
  reserve(input: { key: string; claimRef: EntityRef; binding: ReleaseBinding }): Promise<ReserveResult>;
  recordUpload(key: string, publicRef: string): Promise<PublicationEntry>;
  recordDelivery(key: string, deliveryRef: EntityRef): Promise<PublicationEntry>;
  get(key: string): Promise<PublicationEntry | null>;
}
export interface ReleaseAuthorization {
  /** Must check trusted operator approval and bind immutable claim, exact hash/media/destination, and key. */
  verify(claimRef: EntityRef, binding: ReleaseBinding, idempotencyKey: string): Promise<boolean>;
}
export interface ApprovedArtifactSource { read(binding: ReleaseBinding): Promise<Uint8Array> }
export interface TrustedClaimResolver { provider(claimRef: EntityRef): Promise<string> }

const fail = (kind: 'invalid-input' | 'denied' | 'pending' | 'unavailable' | 'failed', message: string): Result<never> => ({ kind, message });
const validSwarmRef = (ref: string): boolean => /^[0-9a-f]{64}$/.test(ref);

/** Hash-checked broker publisher. It accepts only markdown bytes, never an encrypted/key-bearing Swarm URL. */
export class ReviewedSwarmPublisher implements DeskPublisher {
  readonly mode = 'live' as const;
  constructor(private readonly deps: { swarm: SwarmGateway; ledger: PublicationLedger; store: DeskPublicStore; authorization: ReleaseAuthorization; artifacts: ApprovedArtifactSource; claims: TrustedClaimResolver; domain: string; chainId: string; destination: string }) {}

  async publish(claimRef: EntityRef, binding: ReleaseBinding, idempotencyKey: string): Promise<Result<Confirmation>> {
    if (!claimRef || !idempotencyKey || idempotencyKey.length > 200 || !isHash(binding.artifactHash) ||
        binding.mediaType !== 'text/markdown' || binding.publicDestination !== this.deps.destination) {
      return fail('invalid-input', 'Invalid reviewed publication binding');
    }
    try {
      if (!await this.deps.authorization.verify(claimRef, binding, idempotencyKey)) return fail('denied', 'No trusted release authorization for these exact terms');
      const existing = await this.deps.ledger.get(idempotencyKey);
      if (existing && (existing.claimRef !== claimRef || existing.binding.artifactHash !== binding.artifactHash || existing.binding.mediaType !== binding.mediaType || existing.binding.publicDestination !== binding.publicDestination)) {
        return fail('denied', 'Idempotency key is already bound to different publication terms');
      }
      if (existing?.status === 'delivered' && existing.deliveryRef) return this.deps.store.confirmation(existing.deliveryRef);
      const bytes = await this.deps.artifacts.read(binding);
      return this.publishApprovedBytes({ claimRef, binding, idempotencyKey, bytes });
    } catch (error) {
      return fail('unavailable', error instanceof Error ? error.message : 'Publication outcome is uncertain; reconcile with the same idempotency key');
    }
  }

  async reconcile(idempotencyKey: string): Promise<Result<Confirmation>> {
    try {
      const entry = await this.deps.ledger.get(idempotencyKey);
      if (!entry) return { kind: 'ok', value: { status: 'failed' } };
      if (!entry.deliveryRef) return { kind: 'ok', value: { status: 'pending' } };
      return this.deps.store.confirmation(entry.deliveryRef);
    } catch (error) { return fail('unavailable', error instanceof Error ? error.message : 'Publication reconciliation unavailable'); }
  }

  /** Called only by the trusted broker after its exact-payload authorization check. */
  async publishApprovedBytes(input: { claimRef: EntityRef; binding: ReleaseBinding; idempotencyKey: string; bytes: Uint8Array }): Promise<Result<Confirmation>> {
    if (!isHash(input.binding.artifactHash) || await artifactDigest(input.bytes) !== input.binding.artifactHash) return fail('denied', 'Artifact bytes differ from the approved hash');
    try {
      if (!await this.deps.authorization.verify(input.claimRef, input.binding, input.idempotencyKey)) return fail('denied', 'No trusted release authorization for these exact terms');
      const reserved = await this.deps.ledger.reserve({ key: input.idempotencyKey, claimRef: input.claimRef, binding: input.binding });
      if (reserved.kind === 'conflict') return fail('denied', 'Idempotency key was already bound to different publication terms');
      if (reserved.kind === 'in-flight') return fail('pending', 'Publication with this key is already in progress');
      let entry = reserved.entry;
      if (entry.status === 'delivered' && entry.deliveryRef) return this.deps.store.confirmation(entry.deliveryRef);
      if (!entry.publicRef) {
        const reference = await this.deps.swarm.upload(input.bytes, 'text/markdown; charset=utf-8');
        if (!validSwarmRef(reference)) return fail('failed', 'Swarm returned an unsupported or encrypted reference');
        const downloaded = await this.deps.swarm.download(reference);
        if (await artifactDigest(downloaded) !== input.binding.artifactHash) return fail('failed', 'Swarm readback did not match the approved artifact bytes');
        entry = await this.deps.ledger.recordUpload(input.idempotencyKey, reference);
      } else {
        const downloaded = await this.deps.swarm.download(entry.publicRef);
        if (await artifactDigest(downloaded) !== input.binding.artifactHash) return fail('denied', 'Previously uploaded Swarm bytes differ from the approved hash');
      }
      const record = {
        version: 'desk/v1', domain: this.deps.domain, chainId: this.deps.chainId, type: 'delivery',
        claimRef: input.claimRef, provider: await this.deps.claims.provider(input.claimRef), artifactHash: input.binding.artifactHash,
        mediaType: input.binding.mediaType, publicRef: `swarm://${entry.publicRef}`,
      } as const;
      const published = await this.deps.store.publish(record, `desk-delivery:${input.idempotencyKey}`);
      if (published.kind !== 'ok') return published;
      if (!published.value.ref) return { kind: 'ok', value: { status: published.value.status === 'confirmed' ? 'confirmed' : 'pending' } };
      entry = await this.deps.ledger.recordDelivery(input.idempotencyKey, published.value.ref);
      return this.deps.store.confirmation(entry.deliveryRef!);
    } catch (error) { return fail('unavailable', error instanceof Error ? error.message : 'Publication outcome is uncertain; retry with the same idempotency key'); }
  }

}
