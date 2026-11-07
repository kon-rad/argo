import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfiguredDeskIdentity, RpcErc8004Reader, publicMetadataAddress, ERC8004_READ_SELECTORS, type IdentityRpc, type MetadataTransport, type ProviderProfileConfig } from './index.js';
const registry = `0x${'3'.repeat(40)}`, owner = `0x${'1'.repeat(40)}`, wallet = `0x${'2'.repeat(40)}`;
const ref = `eip155:1:${registry}/7`;
const payload = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'Test agent', description: 'Synthetic public service.', services: [], registrations: [{ agentId: 7, agentRegistry: `eip155:1:${registry}` }] };
const inline = (value: unknown) => `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString('base64')}`;
const word = (n: bigint) => n.toString(16).padStart(64,'0');
const encodeString = (value: string) => { const bytes = Buffer.from(value); return `0x${word(32n)}${word(BigInt(bytes.length))}${bytes.toString('hex').padEnd(Math.ceil(bytes.length/32)*64,'0')}`; };
const encodeAddress = (value: string) => `0x${'0'.repeat(24)}${value.slice(2)}`;
function setup(uri = inline(payload), patches: Record<string, unknown> = {}, metadata?: MetadataTransport) {
  const rpc = vi.fn<IdentityRpc>(async (method, params) => {
    if (method === 'eth_chainId') return patches.chain ?? '0x1';
    if (method === 'eth_getBlockByNumber') return patches.block ?? { number: '0x10', hash: `0x${'a'.repeat(64)}` };
    if (method === 'eth_getCode') return patches.code ?? '0x6001';
    if (method !== 'eth_call') throw new Error('Unexpected write or RPC method');
    const call = params[0] as {data:string};
    if (call.data.startsWith(`0x${ERC8004_READ_SELECTORS.ownerOf}`)) return patches.owner ?? encodeAddress(owner);
    if (call.data.startsWith(`0x${ERC8004_READ_SELECTORS.getAgentWallet}`)) return patches.wallet ?? encodeAddress(wallet);
    if (call.data.startsWith(`0x${ERC8004_READ_SELECTORS.tokenURI}`)) return patches.uri ?? encodeString(uri);
    throw new Error('Unexpected selector');
  });
  const reader = new RpcErc8004Reader({ chainId: '1', registryAddress: registry, rpcUrl: 'https://rpc.example.test', metadataHosts: ['metadata.example.test'] }, rpc, metadata);
  return { reader, rpc };
}
afterEach(() => vi.unstubAllGlobals());
describe('concrete ERC8004 registration RPC reader', () => {
  it('reads owner, payment wallet and URI independently at one canonical finalized block, with no ENS dependency', async () => {
    const { reader, rpc } = setup();
    expect(await reader.readRegistration(ref)).toEqual({ agentRegistry: `eip155:1:${registry}`, agentId: '7', owner, paymentWallet: wallet, services: [] });
    const reads = rpc.mock.calls.filter(([method]) => method === 'eth_call'); expect(reads).toHaveLength(3);
    for (const [, params] of reads) expect(params[1]).toEqual({ blockHash: `0x${'a'.repeat(64)}`, requireCanonical: true });
    expect(reads.map(([, params]) => (params[0] as {data:string}).data.slice(0,10))).toEqual(['0x6352211e','0x00339509','0xc87b56dd']);
  });
  it('refuses wrong chain, registry, malformed refs and noncanonical token IDs before RPC', async () => {
    const { reader, rpc } = setup();
    for (const bad of [ref.replace('eip155:1:', 'eip155:2:'), ref.replace(registry,wallet), ref.replace('/7','/07'), ref.replace('/7','/-1'), `${ref}extra`]) await expect(reader.readRegistration(bad)).rejects.toThrow('reference');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('checks RPC chain, contract code and finalized block before reading registry', async () => {
    for (const patch of [{ chain:'0x2' },{ chain:'1' },{ code:'0x' },{ block:{number:'0x10',hash:'bad'} }]) {
      const { reader, rpc } = setup(undefined, patch); await expect(reader.readRegistration(ref)).rejects.toThrow(); expect(rpc.mock.calls.some(([method]) => method === 'eth_call')).toBe(false);
    }
  });
  it('does not substitute owner for unset payment wallet', async () => {
    expect((await setup(undefined,{wallet:encodeAddress(`0x${'0'.repeat(40)}`)}).reader.readRegistration(ref))?.paymentWallet).toBeNull();
    await expect(setup(undefined,{owner:encodeAddress(`0x${'0'.repeat(40)}`)}).reader.readRegistration(ref)).rejects.toThrow('owner is zero');
  });
  it('requires canonical ABI address/string values and bounded metadata', async () => {
    for (const patch of [{owner:'0x1234'},{wallet:`0x${'1'.repeat(64)}`},{uri:'0x'},{uri:`0x${word(64n)}${word(0n)}`},{uri:`0x${word(32n)}${word(1_000_000n)}`}]) await expect(setup(undefined,patch).reader.readRegistration(ref)).rejects.toThrow();
    await expect(setup(inline({...payload, description:'x'.repeat(70_000)})).reader.readRegistration(ref)).rejects.toThrow();
  });
  it('rejects malformed JSON/schema, mismatched metadata registration and unsupported URI scheme', async () => {
    for (const value of [null, {...payload,type:'wrong'}, {...payload,services:[{name:'web',endpoint:7}]}, {...payload, registrations:[{agentId:8,agentRegistry:`eip155:1:${registry}`}]}]) await expect(setup(inline(value)).reader.readRegistration(ref)).rejects.toThrow();
    for (const uri of ['ipfs://unsupported-cid','data:application/json;base64,@@@@','data:application/json;base64,ey=','data:application/json;base64,eA==']) await expect(setup(uri).reader.readRegistration(ref)).rejects.toThrow();
  });
  it('projects only bounded service fields, excluding unknown metadata', async () => {
    const data = {...payload, secret:'not-exported', services:[{name:'ENS',endpoint:'agent.example.eth',version:'v1',private:'not-exported'}]};
    const result = await setup(inline(data)).reader.readRegistration(ref);
    expect(result?.services).toEqual([{name:'ENS',endpoint:'agent.example.eth',version:'v1'}]); expect(JSON.stringify(result)).not.toContain('not-exported');
  });
  it('disallows unsafe/private URLs, credentials, ports, fragments and unconfigured hosts before metadata transport', async () => {
    const transport = { read: vi.fn(async () => Buffer.from(JSON.stringify(payload))) };
    for (const uri of ['http://metadata.example.test/a','https://127.0.0.1/a','https://[::1]/a','https://user:pass@metadata.example.test/a','https://metadata.example.test:444/a','https://metadata.example.test/a#x','https://other.example.test/a','https://metadata.example.test./a']) await expect(setup(uri,{},transport).reader.readRegistration(ref)).rejects.toThrow(); // public-ok: synthetic public/private destination and credential rejection vectors
    expect(transport.read).not.toHaveBeenCalled();
  });
  it('fetches only an allowlisted HTTPS metadata path with configured bounds; redirects and outages fail', async () => {
    const transport = { read: vi.fn(async () => Buffer.from(JSON.stringify(payload))) };
    expect(await setup('https://metadata.example.test/agent.json',{},transport).reader.readRegistration(ref)).not.toBeNull();
    expect(transport.read).toHaveBeenCalledWith(new URL('https://metadata.example.test/agent.json'),65536,10000);
    transport.read.mockRejectedValueOnce(new Error('HTTP redirect denied'));
    await expect(setup('https://metadata.example.test/agent.json',{},transport).reader.readRegistration(ref)).rejects.toThrow('redirect');
    transport.read.mockResolvedValueOnce(Buffer.alloc(70_000));
    await expect(setup('https://metadata.example.test/agent.json',{},transport).reader.readRegistration(ref)).rejects.toThrow('byte limit');
  });
  it('distinguishes strict missing-token custom errors from RPC outages through the real HTTP envelope decoder', async () => {
    let missing = true;
    vi.stubGlobal('fetch',vi.fn(async (_url, init) => {
      const input = JSON.parse(init.body); let result: unknown = '0x1';
      if (input.method === 'eth_getBlockByNumber') result = {number:'0x10',hash:`0x${'a'.repeat(64)}`};
      if (input.method === 'eth_getCode') result = '0x6001';
      if (input.method === 'eth_call') return new Response(JSON.stringify({jsonrpc:'2.0',id:input.id,error:{code:3,data:missing ? `0x7e273289${word(7n)}`:'0xdeadbeef',message:'revert'}}));
      return new Response(JSON.stringify({jsonrpc:'2.0',id:input.id,result}));
    }));
    const reader = new RpcErc8004Reader({chainId:'1',registryAddress:registry,rpcUrl:'https://rpc.example.test'});
    expect(await reader.readRegistration(ref)).toBeNull();
    missing = false; await expect(reader.readRegistration(ref)).rejects.toThrow('RPC call failed');
    vi.stubGlobal('fetch',vi.fn(async () => { throw new Error('offline'); })); await expect(reader.readRegistration(ref)).rejects.toThrow('offline');
  });
  it('preserves separate configured owner and payment binding; absent ENS remains unresolved', async () => {
    const provider: ProviderProfileConfig = { name:'Test agent',description:'Synthetic',provider:{version:'desk/v1',domain:'desk-test',chainId:'1',type:'provider',providerId:'test',profileRef:'profile',owner,skill:'research',skillVersion:'1',identityRefs:[ref],paymentAddress:wallet} };
    const { reader } = setup();
    const identity = new ConfiguredDeskIdentity({mode:'live',providers:[provider],erc8004:reader});
    const details = await identity.resolveDetails('test'); expect(details.kind).toBe('ok'); if (details.kind !== 'ok') return;
    expect(details.value.status).toBe('unresolved'); expect(details.value.evidence.join(' ')).toContain('owner and payment binding read');
    const mismatch = new ConfiguredDeskIdentity({mode:'live',providers:[{...provider,provider:{...provider.provider,paymentAddress:owner}}],erc8004:reader});
    const wrong = await mismatch.resolveDetails('test'); expect(wrong.kind === 'ok' && wrong.value.status).toBe('contradictory');
  });
});
describe('metadata network destination filter', () => {
  it('rejects private, local, special, mapped and transition destinations', () => {
    for (const ip of ['0.0.0.0','10.0.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','198.18.0.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2002:7f00:1::1','2001:db8::1','3fff::1']) expect(publicMetadataAddress(ip),ip).toBe(false); // public-ok: synthetic public/private destination and credential rejection vectors
    for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) expect(publicMetadataAddress(ip),ip).toBe(true); // public-ok: synthetic public/private destination and credential rejection vectors
  });
});
