import { encodeCybaEvent, type CybaEvent } from '@secondbrain/desk-arkiv/cybazaar';
export type { CybaEvent } from '@secondbrain/desk-arkiv/cybazaar';
export interface CybaPublicationTransport {
 signerAddress(): string;
 find(key:string):Promise<{ref:string;event:CybaEvent;attestor:string}|null>;
 publish(event:CybaEvent,key:string):Promise<string>;
 read(ref:string):Promise<{event:CybaEvent;attestor:string}|null>;
}
/** Implemented with PostgreSQL outbox rows in production, including an exclusive bounded lease. */
export interface CybaPublicationLedger {
 reservePublication(key:string,digest:string,event:CybaEvent):Promise<{kind:'acquired'}|{kind:'busy'}|{kind:'uncertain'}|{kind:'existing';ref?:string}>;
 recordPublication(key:string,digest:string,ref:string):Promise<void>;
 retryPublication(key:string,digest:string):Promise<void>;
 abortBeforeWrite(key:string,digest:string):Promise<void>;
}
export type CybaPublicationResult={status:'published';ref:string}|{status:'pending';reason:string};
/** Read-before-retry makes an uncertain write reconcilable; caller retains event/payment checkpoints. */
export async function publishCybaEvent(event:CybaEvent,deps:{ledger:CybaPublicationLedger;transport:CybaPublicationTransport}):Promise<CybaPublicationResult> {
 const {transport,ledger}=deps;
 const encoded=encodeCybaEvent(event,{signer:transport.signerAddress()}),key=`${event.kind}:${event.jobId}`;
 const reservation=await ledger.reservePublication(key,encoded.digest,event);
 if(reservation.kind==='busy')return {status:'pending',reason:'Attestation already in progress'};
 let effectAttempted=false;
 const check=async(ref:string)=>{
  if(!/^arkiv:[1-9][0-9]*\/0x[0-9a-f]{64}$/i.test(ref))throw Error('Invalid attestation reference');
  const row=await transport.read(ref);
  if(!row||row.attestor.toLowerCase()!==transport.signerAddress().toLowerCase()||encodeCybaEvent(row.event,{signer:row.attestor}).digest!==encoded.digest)throw Error('Finalized attestation bytes or author mismatch');
 };
 try{
  if(reservation.kind==='existing'&&reservation.ref){await check(reservation.ref);return {status:'published',ref:reservation.ref};}
  const prior=await transport.find(key);
  if(prior){
   if(prior.attestor.toLowerCase()!==transport.signerAddress().toLowerCase()||encodeCybaEvent(prior.event,{signer:prior.attestor}).digest!==encoded.digest)throw Error('Outbox key bound to conflicting attestation');
   await check(prior.ref);await ledger.recordPublication(key,encoded.digest,prior.ref);return {status:'published',ref:prior.ref};
  }
  if(reservation.kind==='uncertain'||reservation.kind==='existing')return {status:'pending',reason:'Previous attestation write is uncertain; await finalized evidence or trusted reconciliation'};
  effectAttempted=true;
  const ref=await transport.publish(event,key);await check(ref);await ledger.recordPublication(key,encoded.digest,ref);return {status:'published',ref};
 }catch{
  // Never erase the event/digest or return a begun effect to fresh/acquired. A future call is find-only.
  if(reservation.kind==='acquired'&&!effectAttempted)await ledger.abortBeforeWrite(key,encoded.digest).catch(()=>{});
  else await ledger.retryPublication(key,encoded.digest).catch(()=>{});
  return {status:'pending',reason:'Attestation outcome pending; reconcile the same event key'};
 }
}
