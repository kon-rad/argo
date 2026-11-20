import { describe, expect, it } from 'vitest';
import { BASE_USDC_ADDRESS, baseTransferData, createBaseRpc, verifyBaseTransfer, type BaseRpc } from './base-payment.js';
const payer = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`, hash = `0x${'a'.repeat(64)}`, blockHash = `0x${'b'.repeat(64)}`;
const terms = { chainId: 8453, tokenAddress: BASE_USDC_ADDRESS, payer, recipient, amountAtomic: '1000000' };
function fixture() {
 const tx = { hash, from:payer, to:BASE_USDC_ADDRESS, chainId:'0x2105', input:baseTransferData(terms), value:'0x0', blockHash, blockNumber:'0x64' };
 const log = { address:BASE_USDC_ADDRESS, topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',`0x${payer.slice(2).padStart(64,'0')}`,`0x${recipient.slice(2).padStart(64,'0')}`],data:`0x${BigInt(terms.amountAtomic).toString(16).padStart(64,'0')}`,blockHash,blockNumber:'0x64',transactionHash:hash,logIndex:'0x0',removed:false };
 const receipt={transactionHash:hash,from:payer,to:BASE_USDC_ADDRESS,status:'0x1',blockHash,blockNumber:'0x64',logs:[log]};
 const values:Record<string,unknown>={eth_chainId:'0x2105',eth_getTransactionByHash:tx,eth_getTransactionReceipt:receipt,eth_blockNumber:'0x65',eth_getBlockByNumber:{hash:blockHash,number:'0x64'}};
 const rpc:BaseRpc={async request(method){if(!(method in values))throw Error('Unexpected method');return values[method];}};
 return {tx,log,receipt,values,rpc};
}
describe('independent Base transfer verification',()=>{
 it('confirms an exact canonical transfer',async()=>{const f=fixture();expect(await verifyBaseTransfer(terms,hash,f.rpc)).toEqual({status:'confirmed',txHash:hash,blockNumber:'100',confirmations:2});});
 it.each([
 ['wrong RPC chain',(f:ReturnType<typeof fixture>)=>{f.values.eth_chainId='0x1';}],
 ['wrong transaction chain',f=>{f.tx.chainId='0x1';}],['wrong payer',f=>{f.tx.from=recipient;}],['wrong token',f=>{f.tx.to=payer;}],['wrong receipt token',f=>{f.receipt.to=payer;}],['failed receipt',f=>{f.receipt.status='0x0';}],['native transfer',f=>{f.tx.value='0x1';}],['wrong recipient',f=>{f.tx.input=baseTransferData({...terms,recipient:payer});}],['wrong amount',f=>{f.tx.input=baseTransferData({...terms,amountAtomic:'999999'});}],['duplicate event',f=>{f.receipt.logs.push(f.log);}],['wrong event amount',f=>{f.log.data=`0x${'0'.repeat(64)}`;}],['removed event',f=>{f.log.removed=true;}],['substituted receipt',f=>{f.receipt.transactionHash=blockHash;}],['wrong event receipt',f=>{f.log.transactionHash=blockHash;}],['noncanonical block',f=>{f.values.eth_getBlockByNumber={hash,number:'0x64'};}],
 ] as [string,(f:ReturnType<typeof fixture>)=>void][])('rejects %s',async(_name,mutate)=>{const f=fixture();mutate(f);expect((await verifyBaseTransfer(terms,hash,f.rpc)).status).not.toBe('confirmed');});
 it('rejects unsupported terms and extra calldata',async()=>{const f=fixture();expect((await verifyBaseTransfer({...terms,tokenAddress:payer},hash,f.rpc)).status).toBe('invalid');f.tx.input+='00';expect((await verifyBaseTransfer(terms,hash,f.rpc)).status).toBe('invalid');});
 it('keeps missing and underconfirmed receipts pending',async()=>{const f=fixture();f.values.eth_blockNumber='0x64';expect((await verifyBaseTransfer(terms,hash,f.rpc)).status).toBe('pending');f.values.eth_getTransactionReceipt=null;expect((await verifyBaseTransfer(terms,hash,f.rpc)).status).toBe('pending');});
 it('keeps outages and malformed observations unavailable',async()=>{expect((await verifyBaseTransfer(terms,hash,{async request(){throw Error('offline');}})).status).toBe('unavailable');const f=fixture();f.log.logIndex='missing';expect((await verifyBaseTransfer(terms,hash,f.rpc)).status).toBe('unavailable');});
});
describe('bounded read-only Base RPC',()=>{
 it('rejects unsafe endpoints and timeout',()=>{expect(()=>createBaseRpc('http://rpc.example.test')).toThrow();expect(()=>createBaseRpc('https://rpc.example.test',{timeoutMs:1})).toThrow();});
 it('refuses signing and excessive responses',async()=>{const rpc=createBaseRpc('https://rpc.example.test',{maxResponseBytes:10,fetcher:async()=>new Response('x'.repeat(11))});await expect(rpc.request('eth_sendTransaction',[])).rejects.toThrow('Unsupported');await expect(rpc.request('eth_chainId',[])).rejects.toThrow('bounds');});
 it('binds response ids and rejects redirects',async()=>{let init:RequestInit|undefined;const rpc=createBaseRpc('https://rpc.example.test',{fetcher:async(_url,options)=>{init=options;return Response.json({jsonrpc:'2.0',id:999,result:'0x2105'});}});await expect(rpc.request('eth_chainId',[])).rejects.toThrow('Invalid');expect(init?.redirect).toBe('error');});
});
