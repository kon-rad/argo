export type CybaEventKind = 'job-accepted'|'owner-approved'|'released-hash'|'verified-payment'|'paid-delivery';
export interface CybaEvent {version:'cybazaar/v1';kind:CybaEventKind;jobId:string;attestor:string;clientWallet:string;providerId:string;termsDigest:string;artifactSha256?:string;paymentTx?:string;swarmRef?:string}
export const CYBA_SCHEMA_TAG: string;
export const CYBA_EVENT_KINDS: readonly CybaEventKind[];
export const CybaSchema: unknown;
export function parseCybaEvent(input:unknown):CybaEvent;
export function encodeCybaEvent(input:unknown,context:{signer:string}):{event:CybaEvent;payload:Uint8Array;digest:string};
export function decodeCybaEvent(payload:Uint8Array,context:{creator:string}):{event:CybaEvent;digest:string};
export function sdkCybaEventValues(event:CybaEvent,context:{signer:string;domain:string;idempotencyKey:string}):unknown;
export function decodeCybaAttributes(attributes:unknown,context:{creator:string;domain:string}):{event:CybaEvent;digest:string};
export interface CybaArkivOptions {rpcUrl:string;domain:string;chainId:number;privateKey:string;lifetimeBlocks:number;timeoutMs?:number;maxResponseBytes?:number;fetchImpl?:typeof fetch;walletFactory?:(options:unknown)=>{createEntity(...args:unknown[]):Promise<unknown>}}
export class ServerCybaArkivTransport {
 constructor(options:CybaArkivOptions);
 signerAddress():string;
 find(key:string):Promise<{ref:string;event:CybaEvent;attestor:string}|null>;
 publish(event:CybaEvent,key:string):Promise<string>;
 read(ref:string):Promise<{event:CybaEvent;attestor:string}|null>;
}
