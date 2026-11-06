import { describe, expect, it } from 'vitest';
import { ConfiguredDeskIdentity, compilePublicProfile, prepareRegistration, type Erc8004Registration, type ProviderProfileConfig } from './index.js';

const owner = '0x' + '1'.repeat(40);
const recipient = '0x' + '2'.repeat(40);
const registry = 'eip155:1:0x' + '3'.repeat(40);
const provider: ProviderProfileConfig = {
  provider: {
    version:'desk/v1', domain:'eip155:1', chainId:'1', type:'provider', providerId:'researcher',
    profileRef:'arkiv:test/provider', owner, skill:'public-research', skillVersion:'1.0.0',
    identityRefs:[`${registry}/7`], paymentAddress:recipient,
  },
  name:'Research Desk', description:'Compares a bounded set of public documents.', ensName:'research.example.eth',
  services:[{name:'web', endpoint:'https://example.invalid/desk'}, {name:'ENS', endpoint:'research.example.eth', version:'v1'}],
};

const registration: Erc8004Registration = {
  agentRegistry:registry, agentId:'7', owner, paymentWallet:recipient,
  services:[{name:'ENS', endpoint:'research.example.eth', version:'v1'}],
};

describe('desk identity profile projection', () => {
  it('exports only explicit public fields and drops unknown/private configuration', () => {
    const result = compilePublicProfile({...provider, privatePrompt:'secret', runtimeCredential:'secret', teamMessages:['secret']});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value).toEqual({
      providerId:'researcher', name:'Research Desk', description:'Compares a bounded set of public documents.',
      owner, paymentAddress:recipient, skill:'public-research', skillVersion:'1.0.0',
      identityRefs:[`${registry}/7`], ensName:'research.example.eth',
      services:[{name:'web',endpoint:'https://example.invalid/desk'}, {name:'ENS',endpoint:'research.example.eth',version:'v1'}],
    });
    expect(JSON.stringify(result.value)).not.toContain('secret');
  });

  it('rejects invalid service records instead of silently publishing them', () => {
    expect(compilePublicProfile({...provider, services:[{name:'unsupported' as never, endpoint:'https://example.invalid/'}]}).kind).toBe('invalid-input');
    expect(compilePublicProfile({...provider, services:[{name:'web', endpoint:'javascript:alert(1)'}]}).kind).toBe('invalid-input');
  });
});

describe('explicit identity resolution', () => {
  it('returns unresolved evidence when names or identity references are absent', async () => {
    const adapter = new ConfiguredDeskIdentity({mode:'fixture', providers:[{...provider, ensName:undefined, provider:{...provider.provider,identityRefs:[]}}]});
    const result = await adapter.resolveDetails('researcher');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.status).toBe('unresolved');
    expect(await adapter.resolve('missing')).toEqual({kind:'unavailable', message:'Provider is not configured'});
  });

  it('verifies owner, payment wallet, registry reference and advertised ENS service together', async () => {
    const adapter = new ConfiguredDeskIdentity({
      mode:'fixture', providers:[provider],
      ens:{normalizeName:name => name.toLowerCase(), resolveAddress:async name => name === 'research.example.eth' ? owner : null},
      erc8004:{readRegistration:async ref => ref === `${registry}/7` ? registration : null},
    });
    const result = await adapter.resolveDetails('researcher');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.status).toBe('verified');
    const binding = await adapter.resolve('researcher');
    expect(binding.kind).toBe('ok');
    if (binding.kind === 'ok') expect(binding.value.verified).toBe(true);
  });

  it('makes a wallet or payment contradiction visible and does not mark it verified', async () => {
    const adapter = new ConfiguredDeskIdentity({
      mode:'fixture', providers:[provider], ens:{normalizeName:name => name.toLowerCase(), resolveAddress:async () => owner},
      erc8004:{readRegistration:async () => ({...registration, paymentWallet:owner})},
    });
    const result = await adapter.resolveDetails('researcher');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.status).toBe('contradictory');
      expect(result.value.evidence.some(item => item.includes('payment wallet mismatch'))).toBe(true);
    }
  });

  it('keeps registry preparation unsigned and unavailable until a verified target is injected', () => {
    expect(prepareRegistration('https://example.invalid/agent.json').kind).toBe('unavailable');
    const prepared = prepareRegistration('ipfs://bafybeigdyrzt', {
      chainId:'1', registryAddress:'0x' + '4'.repeat(40), encodeRegister:() => '0x1234',
    });
    expect(prepared).toEqual({kind:'ok', value:{chainId:'1', to:'0x'+'4'.repeat(40), data:'0x1234', value:'0'}});
  });
});
