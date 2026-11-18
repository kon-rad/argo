/** A wallet interface must be explicitly injected by the embedding wallet integration. */
/** @param {{address():Promise<string>,publishRecord(record:unknown,key:string):Promise<import('@secondbrain/desk-contracts/desk').Confirmation>}} wallet @param {{client:string}} record @param {'client'} authorField @param {string} idempotencyKey */
export async function publishAuthorizedRecord(wallet, record, authorField, idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) return { kind: 'invalid-input', message: 'A unique idempotency key is required' };
  try {
    if (await wallet.address() !== record[authorField]) return { kind: 'denied', message: 'Connected wallet does not match record author' };
    return { kind: 'ok', value: await wallet.publishRecord(record, idempotencyKey) };
  } catch (error) { return { kind: 'denied', message: error instanceof Error ? error.message : 'Wallet publication rejected' }; }
}
/** @param {import('@secondbrain/desk-contracts/desk').DeskClient} client @param {{address():Promise<string>,submit(chainId:string,transaction:unknown):Promise<{hash:string}>}} wallet @param {import('@secondbrain/desk-contracts/desk').PaymentIntent} intent */
export async function submitPreparedPayment(client, wallet, intent) {
  const prepared = await client.preparePayment(intent);
  if (prepared.kind !== 'ok') return prepared;
  return submitPreparedTransaction(wallet, intent, prepared.value);
}
/** @param {{address():Promise<string>,submit(chainId:string,transaction:unknown):Promise<{hash:string}>}} wallet @param {import('@secondbrain/desk-contracts/desk').PaymentIntent} intent @param {{chainId:string,transaction:unknown}} prepared */
export async function submitPreparedTransaction(wallet, intent, prepared) {
  if (prepared.chainId !== intent.chainId) return { kind: 'failed', message: 'Prepared payment chain does not match accepted intent' };
  try {
    if (await wallet.address() !== intent.payer) return { kind: 'denied', message: 'Connected wallet does not match accepted payer' };
    return { kind: 'ok', value: await wallet.submit(prepared.chainId, prepared.transaction) };
  } catch (error) { return { kind: 'denied', message: error instanceof Error ? error.message : 'Wallet request rejected' }; }
}
