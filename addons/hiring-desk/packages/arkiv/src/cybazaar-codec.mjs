import { createHash } from 'node:crypto';
import { defineSchema, str, bytes } from '@arkiv-network/sdk/schema';
import { createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { defineChain, http, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalJson } from '@secondbrain/desk-contracts/desk';
import { idempotencyHash } from './codec.mjs';
import { LiveArkivDeskClient } from './reader.mjs';

export const CYBA_SCHEMA_TAG = 'cybazaar.v1';
export const CYBA_EVENT_KINDS = ['job-accepted','owner-approved','released-hash','verified-payment','paid-delivery'];
/** @type {import('@arkiv-network/sdk/schema').Schema} */
export const CybaSchema = defineSchema(CYBA_SCHEMA_TAG, { domain:str().indexed(), eventKind:str().indexed(), jobId:str().indexed(), event:bytes(), idem:str().indexed(), eventDigest:str().indexed() });
const ADDRESS=/^0x[0-9a-f]{40}$/i,HASH=/^(?:0x)?[0-9a-f]{64}$/i,KEY=/^0x[0-9a-f]{64}$/i;
const string = (value,max=200) => typeof value==='string' && value.length>0 && value.length<=max && !/[\x00-\x1f]/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const keys = ['version','kind','jobId','attestor','clientWallet','providerId','termsDigest','artifactSha256','paymentTx','swarmRef'];
export function parseCybaEvent(input) {
 if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!keys.includes(k)))throw Error('Invalid Cybazaar event fields');
 const e=input;
 if(e.version!=='cybazaar/v1' || !CYBA_EVENT_KINDS.includes(e.kind) || !string(e.jobId) || !string(e.providerId) || !ADDRESS.test(e.attestor??'') || !ADDRESS.test(e.clientWallet??'') || !/^[0-9a-f]{64}$/.test(e.termsDigest??''))throw Error('Invalid Cybazaar event');
 if(e.artifactSha256!==undefined && !/^[0-9a-f]{64}$/.test(e.artifactSha256))throw Error('Invalid artifact digest');
 if(e.paymentTx!==undefined && !KEY.test(e.paymentTx))throw Error('Invalid payment transaction');
 if(e.swarmRef!==undefined && (e.kind!=='paid-delivery' || !/^swarm:\/\/[0-9a-f]{64}$/.test(e.swarmRef)))throw Error('Premature or invalid Swarm reference');
 if(['released-hash','paid-delivery'].includes(e.kind) && !e.artifactSha256)throw Error('Artifact digest required');
 if(['verified-payment','paid-delivery'].includes(e.kind) && !e.paymentTx)throw Error('Payment transaction required');
 if(e.kind==='paid-delivery' && !e.swarmRef)throw Error('Paid delivery reference required');
 if(!['verified-payment','paid-delivery'].includes(e.kind) && e.paymentTx!==undefined)throw Error('Premature payment evidence');
 return Object.fromEntries(keys.filter(k=>e[k]!==undefined).map(k=>[k,e[k]]));
}
export function encodeCybaEvent(input,{signer}) {
 const event=parseCybaEvent(input);
 if(!ADDRESS.test(signer??'') || signer.toLowerCase()!==event.attestor.toLowerCase())throw Error('Cybazaar attestor mismatch');
 const payload=encoder.encode(canonicalJson(event));
 if(payload.length>16_384)throw Error('Cybazaar event too large');
 return {event,payload,digest:digest(payload)};
}
export function decodeCybaEvent(payload,{creator}) {
 if(!(payload instanceof Uint8Array) || !payload.length || payload.length>16_384)throw Error('Invalid event bytes');
 const raw=decoder.decode(payload), event=parseCybaEvent(JSON.parse(raw));
 const encoded=encodeCybaEvent(event,{signer:creator});
 if(canonicalJson(event)!==raw)throw Error('Noncanonical event bytes');
 return {event,digest:encoded.digest};
}
export function sdkCybaEventValues(event,{signer,domain,idempotencyKey}) {
 if(!string(domain,128))throw Error('Invalid Cybazaar domain');
 const encoded=encodeCybaEvent(event,{signer});
 if(idempotencyKey!==`${encoded.event.kind}:${encoded.event.jobId}`)throw Error('Invalid Cybazaar outbox key');
 return {domain,eventKind:encoded.event.kind,jobId:encoded.event.jobId,event:bytes(toHex(encoded.payload)),idem:idempotencyHash(idempotencyKey),eventDigest:encoded.digest};
}
export function decodeCybaAttributes(attributes,{creator,domain}) {
 if(!Array.isArray(attributes)||attributes.length!==7)throw Error('Invalid Cybazaar attributes');
 const map=new Map();for(const a of attributes){if(!a||map.has(a.name))throw Error('Duplicate attribute');map.set(a.name,a);}
 const field=(name,type)=>{const a=map.get(name);if(!a||a.type!==type)throw Error('Invalid event attribute');return a.value;};
 if(field('arkiv.schema','str')!==CYBA_SCHEMA_TAG||field('domain','str')!==domain)throw Error('Cybazaar schema/domain mismatch');
 const hex=field('event','bytes');if(typeof hex!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(hex)||hex.length>32770)throw Error('Invalid event bytes');
 const decoded=decodeCybaEvent(Uint8Array.from(Buffer.from(hex.slice(2),'hex')),{creator});
 if(field('eventKind','str')!==decoded.event.kind||field('jobId','str')!==decoded.event.jobId||field('eventDigest','str')!==decoded.digest||field('idem','str')!==idempotencyHash(`${decoded.event.kind}:${decoded.event.jobId}`))throw Error('Cybazaar attribute binding mismatch');
 return decoded;
}

/** Real SDK writer plus independently finalized RPC readback. The server is an attestor, never the client author. */
export class ServerCybaArkivTransport extends LiveArkivDeskClient {
 #account;#wallet;#lifetime;
 constructor(options){
  super(options);
  if(!KEY.test(options.privateKey??'')||!Number.isSafeInteger(options.lifetimeBlocks)||options.lifetimeBlocks<1||options.lifetimeBlocks>1_296_000)throw Error('Invalid Cybazaar writer configuration');
  this.#account=privateKeyToAccount(options.privateKey);this.#lifetime=options.lifetimeBlocks;
  const chain=defineChain({id:options.chainId,name:'Configured Arkiv network',nativeCurrency:{name:'Arkiv gas',symbol:'GAS',decimals:18},rpcUrls:{default:{http:[options.rpcUrl]}}});
  this.#wallet=(options.walletFactory??createWalletClient)({chain,account:this.#account,transport:http(options.rpcUrl,{timeout:options.timeoutMs??10000,retryCount:0})});
 }
 signerAddress(){return this.#account.address;}
 async decode(entity,snapshot){
  if(!entity||!KEY.test(entity.key??'')||entity.creator?.toLowerCase()!==this.#account.address.toLowerCase()||entity.owner?.toLowerCase()!==entity.creator.toLowerCase()||entity.creationFlags?.readonly!==true)throw Error('Invalid immutable server attestation');
  const q=x=>{if(typeof x!=='string'||!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(x))throw Error('Invalid block quantity');return BigInt(x);};
  const created=q(entity.createdAt),updated=q(entity.updatedAt),expiry=q(entity.expiresAt),height=q(snapshot.number);
  if(created>updated||updated>height||expiry<=height||!await this.finality(snapshot))throw Error('Cybazaar entity not finalized or expired');
  const {event}=decodeCybaAttributes(entity.attributes,{creator:entity.creator,domain:this.domain});
  return {key:entity.key,creator:entity.creator,finalized:true,event};
 }
 async find(key){
  await this.checkChain();const hash=idempotencyHash(key),quote=x=>"str('"+x.replaceAll("'","''")+"')";
  const query=`arkiv.schema = ${quote(CYBA_SCHEMA_TAG)} AND domain = ${quote(this.domain)} AND idem = ${quote(hash)}`;
  const result=await this.rpc('arkiv_query',[query,{select:{key:true,creator:true,owner:true,createdAt:true,updatedAt:true,expiresAt:true,creationFlags:true,attributes:true},limit:'0x2'}]);
  if(!result||!Array.isArray(result.data)||result.data.length>1)throw Error('Conflicting Cybazaar outbox evidence');
  if(!result.data.length)return null;
  const snapshot=await this.block(result.blockNumber),row=await this.decode(result.data[0],snapshot);
  if(`${row.event.kind}:${row.event.jobId}`!==key)throw Error('Outbox evidence key mismatch');
  return {ref:`arkiv:${this.chainId}/${row.key}`,event:row.event,attestor:row.creator};
 }
 async publish(event,key){
  const values=sdkCybaEventValues(event,{signer:this.#account.address,domain:this.domain,idempotencyKey:key});
  const prior=await this.find(key);
  if(prior){if(encodeCybaEvent(prior.event,{signer:prior.attestor}).digest!==encodeCybaEvent(event,{signer:this.#account.address}).digest)throw Error('Conflicting Cybazaar outbox bytes');return prior.ref;}
  const head=await this.block('latest');
  try{await this.#wallet.createEntity(CybaSchema,values,{expiration:ExpirationTime.atBlock(BigInt(head.number)+BigInt(this.#lifetime)),flags:{readonly:true},salt:BigInt('0x'+idempotencyHash(key).slice(2,34))});}catch{throw Error('Cybazaar write outcome uncertain; reconcile the same outbox key');}
  const confirmed=await this.find(key);if(!confirmed)throw Error('Cybazaar attestation pending finality');return confirmed.ref;
 }
 async read(ref){
  const prefix=`arkiv:${this.chainId}/`;if(typeof ref!=='string'||!ref.startsWith(prefix)||!KEY.test(ref.slice(prefix.length)))throw Error('Invalid Cybazaar evidence reference');
  const row=await super.get(ref.slice(prefix.length));return row?{event:row.event,attestor:row.creator}:null;
 }
}
