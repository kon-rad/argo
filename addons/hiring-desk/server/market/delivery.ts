import { createHash } from 'node:crypto';
import type { SwarmGateway } from '../desk/publishing/swarm.js';
import { TrustedMp4Artifacts } from './artifacts.js';
import { CybaBoardBridge } from './board.js';
import { verifyBaseTransfer, type BaseRpc } from './base-payment.js';
import { publishCybaEvent, type CybaEvent, type CybaPublicationLedger, type CybaPublicationTransport } from './publication.js';
import { CybaError, type CybaJob, type CybaStore } from './types.js';

export interface MarketDeliveryOptions {
  store: CybaStore; board: CybaBoardBridge; artifacts: TrustedMp4Artifacts; rpc: BaseRpc;
  swarm: SwarmGateway; ledger: CybaPublicationLedger; transport: CybaPublicationTransport;
  requiredConfirmations?: number;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** All external effects follow durable approval/payment/outbox checkpoints. */
export class MarketDelivery {
  constructor(private readonly o: MarketDeliveryOptions) {}
  async audit(job: CybaJob, kind: CybaEvent['kind']): Promise<void> {
    const termsDigest = digest(Buffer.from(JSON.stringify([job.id, job.providerId, job.clientWallet, job.chainId, job.tokenAddress, job.recipient, job.priceAtomic, job.title, job.brief])));
    const event: CybaEvent = {
      version: 'cybazaar/v1', kind, jobId: job.id, attestor: this.o.transport.signerAddress(),
      clientWallet: job.clientWallet, providerId: job.providerId, termsDigest,
      ...(['released-hash', 'verified-payment', 'paid-delivery'].includes(kind) && job.artifactSha256 ? { artifactSha256: job.artifactSha256 } : {}),
      ...(['verified-payment', 'paid-delivery'].includes(kind) && job.paymentTx ? { paymentTx: job.paymentTx } : {}),
      ...(kind === 'paid-delivery' && job.paymentTx && job.swarmRef ? { swarmRef: job.swarmRef } : {}),
    };
    await this.o.store.enqueuePublication(job.id, kind, event as unknown as Record<string, unknown>);
  }
  async flush(jobId: string): Promise<boolean> {
    for (const item of await this.o.store.pendingPublications(jobId)) {
      const result = await publishCybaEvent(item.payload as unknown as CybaEvent, { ledger: this.o.ledger, transport: this.o.transport });
      if (result.status !== 'published') return false;
      await this.o.store.confirmPublication(item.id, result.ref);
    }
    return true;
  }
  async stage(job: CybaJob, artifactRef: string, summary: string): Promise<void> {
    await this.o.board.assertCompleted(job);
    const artifact = await this.o.artifacts.read(artifactRef);
    await this.o.store.stageArtifact(job.id, { path: artifact.path, sha256: artifact.sha256, summary });
  }
  async release(job: CybaJob, sha256: string, expectedSummary: string): Promise<void> {
    if (!job.artifactPath || job.artifactSha256 !== sha256 || job.summary !== expectedSummary) throw new CybaError(409, 'Review the current artifact and summary before Release.');
    await this.o.artifacts.readBound(job.artifactPath, sha256);
    const released = await this.o.store.releaseJob(job.id, sha256, expectedSummary);
    await this.audit(released, 'released-hash');
    // Arkiv availability never changes the private Release decision. Its outbox
    // remains retryable and contains only the summary's artifact hash.
    await this.flush(job.id);
  }
  async pay(job: CybaJob, txHash: string): Promise<void> {
    if (!['released', 'paid'].includes(job.status)) throw new CybaError(409, 'The owner has not released this job.');
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new CybaError(400, 'Invalid payment transaction hash.');
    txHash = txHash.toLowerCase();
    if (job.paymentTx && job.paymentTx !== txHash) throw new CybaError(409, 'A different payment is already bound to this job.');
    if (!job.paymentTx) {
      await this.o.store.rememberPendingPayment(job.id, txHash);
      const check = await verifyBaseTransfer({ chainId: job.chainId, tokenAddress: job.tokenAddress, payer: job.clientWallet, recipient: job.recipient, amountAtomic: job.priceAtomic }, txHash, this.o.rpc, this.o.requiredConfirmations);
      if (check.status === 'invalid') { await this.o.store.clearPendingPayment(job.id, txHash); throw new CybaError(409, check.reason); }
      if (check.status !== 'confirmed') return;
      job = await this.o.store.reservePayment(job.id, txHash);
    }
    await this.audit(job, 'verified-payment');
    await this.deliver(job);
  }
  private async deliver(job: CybaJob): Promise<void> {
    if (!job.paymentTx || !job.artifactPath || !job.artifactSha256) throw new CybaError(409, 'Delivery has no verified paid artifact.');
    if (!job.swarmRef) {
      const bytes = await this.o.artifacts.readBound(job.artifactPath, job.artifactSha256);
      const attempt = await this.o.store.beginUpload(job.id);
      job = attempt.job;
      if (!job.swarmRef) {
        // An interrupted upload may have succeeded. Do not spend postage again
        // without its reference. The owner can reconcile it using exact bytes.
        if (!attempt.started) return;
        try {
          const ref = await this.o.swarm.upload(bytes, 'video/mp4');
          job = await this.o.store.checkpointSwarm(job.id, `swarm://${ref}`);
        } catch { return; }
      }
    }
    if (!job.swarmRef) return;
    try {
      const readback = await this.o.swarm.download(job.swarmRef.replace(/^swarm:\/\//, ''), 'video/mp4');
      if (digest(readback) !== job.artifactSha256) throw new CybaError(409, 'Swarm delivery bytes do not match the reviewed artifact.');
    } catch (error) { if (error instanceof CybaError) throw error; return; }
    await this.audit(job, 'paid-delivery');
    if (await this.flush(job.id)) await this.o.store.completeDelivery(job.id, job.swarmRef);
  }
  /** Owner-only recovery for an upload whose response was lost, with no re-upload. */
  async reconcileDelivery(job: CybaJob, reference: string): Promise<void> {
    if (!job.paymentTx || !job.artifactSha256 || !/^swarm:\/\/[0-9a-f]{64}$/.test(reference)) throw new CybaError(409, 'No verified payment or valid recovery reference.');
    const bytes = await this.o.swarm.download(reference.slice('swarm://'.length), 'video/mp4');
    if (digest(bytes) !== job.artifactSha256) throw new CybaError(409, 'Recovery reference does not match the released artifact.');
    await this.deliver(await this.o.store.checkpointSwarm(job.id, reference));
  }
}
