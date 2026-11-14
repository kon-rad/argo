import { createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DeskSchema, idempotencyHash, recordAuthor, recordHash, sdkRecordValues } from './codec.mjs';
import { LiveArkivDeskClient } from './reader.mjs';

const PRIVATE_KEY = /^0x[0-9a-f]{64}$/i;

/**
 * Server-only Arkiv writer. It never returns the account or key and the SDK is
 * allowed to sign only records whose frozen desk/v1 authority equals the account.
 */
export class ServerArkivDeskClient extends LiveArkivDeskClient {
  #account;
  #wallet;
  #lifetimeBlocks;
  #audit;
  constructor(options) {
    super(options);
    if (!PRIVATE_KEY.test(options.privateKey ?? '') || !Number.isSafeInteger(options.lifetimeBlocks) || options.lifetimeBlocks < 1 || options.lifetimeBlocks > 1_296_000) {
      throw new Error('Invalid server Arkiv signer or lifetime configuration');
    }
    this.#account = privateKeyToAccount(options.privateKey);
    this.#lifetimeBlocks = options.lifetimeBlocks;
    this.#audit = typeof options.audit === 'function' ? options.audit : () => {};
    const chain = defineChain({
      id: options.chainId,
      name: 'Configured Arkiv network',
      nativeCurrency: { name: 'Arkiv gas', symbol: 'GAS', decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl] } },
    });
    this.#wallet = (options.walletFactory ?? createWalletClient)({
      chain, account: this.#account, transport: http(options.rpcUrl, { timeout: options.timeoutMs, retryCount: 0 }),
    });
  }

  signerAddress() { return this.#account.address; }

  async create(record, idempotencyKey) {
    const author = recordAuthor(record);
    if (author.toLowerCase() !== this.#account.address.toLowerCase()) throw new Error('Server signer is not the record authority');
    const context = { domain: this.domain, chainId: this.chainId, signer: this.#account.address, idempotencyKey };
    const prior = await this.findByIdempotencyKey(idempotencyKey);
    if (prior) {
      if (recordHash(prior.record) !== recordHash(record)) throw new Error('Idempotency key is bound to different canonical record bytes');
      return prior;
    }
    const latest = await this.block('latest');
    const expiresAt = BigInt(latest.number) + BigInt(this.#lifetimeBlocks);
    this.#audit({ event: 'arkiv-write-attempt', recordType: record.type, idempotencyHash: idempotencyHash(idempotencyKey) });
    try {
      await this.#wallet.createEntity(DeskSchema, sdkRecordValues(record, context), {
        expiration: ExpirationTime.atBlock(expiresAt), flags: { readonly: true },
        salt: BigInt('0x' + idempotencyHash(idempotencyKey).slice(2, 34)),
      });
    } catch {
      this.#audit({ event: 'arkiv-write-uncertain', recordType: record.type, idempotencyHash: idempotencyHash(idempotencyKey) });
      throw new Error('Arkiv write outcome is uncertain; retry with the same idempotency key');
    }
    const confirmed = await this.findByIdempotencyKey(idempotencyKey);
    if (!confirmed) throw new Error('Arkiv write is pending; retry with the same idempotency key');
    this.#audit({ event: 'arkiv-write-confirmed', recordType: record.type, idempotencyHash: idempotencyHash(idempotencyKey), entityKey: confirmed.key });
    return confirmed;
  }
}
