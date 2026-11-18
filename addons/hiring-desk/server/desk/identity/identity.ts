import type { Adapter, DeskIdentity, IdentityBinding, Provider, Result } from '@secondbrain/desk-contracts/desk';
import type { Erc8004Reader, EnsResolver, IdentityResolution, ProviderProfileConfig } from './types.js';
import { compilePublicProfile } from './profile.js';

export interface IdentityDependencies {
  mode: Adapter['mode'];
  providers: readonly ProviderProfileConfig[];
  ens?: EnsResolver;
  erc8004?: Erc8004Reader;
}

/** Read-only identity adapter. It never signs, writes registry state, or guesses a deployment. */
export class ConfiguredDeskIdentity implements DeskIdentity {
  readonly mode: Adapter['mode'];
  private readonly providers: ReadonlyMap<string, ProviderProfileConfig>;

  constructor(private readonly dependencies: IdentityDependencies) {
    this.mode = dependencies.mode;
    this.providers = new Map(dependencies.providers.map(config => [config.provider.providerId, config]));
  }

  async publicProfile(providerId: string) {
    const config = this.providers.get(providerId);
    if (!config) return {kind:'unavailable', message:'Provider is not configured'} as const;
    return compilePublicProfile(config);
  }

  async profile(providerId: string): Promise<Result<Provider>> {
    const config = this.providers.get(providerId);
    if (!config) return {kind:'unavailable', message:'Provider is not configured'};
    const compiled = compilePublicProfile(config);
    if (compiled.kind !== 'ok') return compiled;
    // Return a fresh allowlisted record, not the original config object.
    return {kind:'ok', value:publicProvider(config.provider)};
  }

  async resolve(providerId: string): Promise<Result<IdentityBinding>> {
    const result = await this.resolveDetails(providerId);
    if (result.kind !== 'ok') return result;
    return {kind:'ok', value:{provider:result.value.provider, verified:result.value.status === 'verified', evidence:result.value.evidence}};
  }

  async resolveDetails(providerId: string): Promise<Result<IdentityResolution>> {
    const config = this.providers.get(providerId);
    if (!config) return {kind:'unavailable', message:'Provider is not configured'};
    const profile = compilePublicProfile(config);
    if (profile.kind !== 'ok') return profile;
    const evidence: string[] = [];
    const unresolved: string[] = [];
    const contradictions: string[] = [];
    const hasErc = config.provider.identityRefs.length > 0;
    if (!config.ensName || !this.dependencies.ens) unresolved.push('ENS name or resolver is not configured');
    else {
      try {
        const ensName = this.dependencies.ens.normalizeName(config.ensName);
        const address = await this.dependencies.ens.resolveAddress(ensName);
        if (!address) unresolved.push(`ENS name ${config.ensName} has no resolved address`);
        else if (!sameAddress(address, config.provider.owner)) contradictions.push('ENS address does not match configured provider owner');
        else evidence.push('ENS forward address matches provider owner');
      } catch { unresolved.push('ENS resolution is unavailable'); }
    }
    if (!hasErc || !this.dependencies.erc8004) unresolved.push('ERC-8004 identity reference or reader is not configured');
    else {
      let found = false;
      for (const identityRef of config.provider.identityRefs) {
        try {
          const registration = await this.dependencies.erc8004.readRegistration(identityRef);
          if (!registration) continue;
          found = true;
          if (!matchesRef(identityRef, registration.agentRegistry, registration.agentId)) contradictions.push(`ERC-8004 registration does not match identity reference ${identityRef}`);
          if (!sameAddress(registration.owner, config.provider.owner)) contradictions.push(`ERC-8004 owner mismatch for ${identityRef}`);
          if (!registration.paymentWallet) unresolved.push(`ERC-8004 payment wallet unavailable for ${identityRef}`);
          else if (!sameAddress(registration.paymentWallet, config.provider.paymentAddress)) contradictions.push(`ERC-8004 payment wallet mismatch for ${identityRef}`);
          const ensService = registration.services.find(service => service.name === 'ENS');
          let serviceMatches = false;
          if (config.ensName && ensService && this.dependencies.ens) {
            try { serviceMatches = this.dependencies.ens.normalizeName(ensService.endpoint) === this.dependencies.ens.normalizeName(config.ensName); }
            catch { unresolved.push(`ERC-8004 ENS service name could not be normalized for ${identityRef}`); }
          }
          if (config.ensName && !ensService) unresolved.push(`ERC-8004 registration has no ENS service for ${identityRef}`);
          else if (config.ensName && ensService && !this.dependencies.ens) unresolved.push(`ENS resolver unavailable to check registration for ${identityRef}`);
          else if (config.ensName && ensService && !serviceMatches && !unresolved.some(item => item.includes(`could not be normalized for ${identityRef}`))) contradictions.push(`ERC-8004 ENS service mismatch for ${identityRef}`);
          else if (config.ensName) evidence.push(`ERC-8004 registration advertises ${config.ensName}`);
          evidence.push(`ERC-8004 registration ${identityRef} owner and payment binding read`);
        } catch { unresolved.push(`ERC-8004 registry read unavailable for ${identityRef}`); }
      }
      if (!found) unresolved.push('No configured ERC-8004 identity reference resolved');
    }
    const status = contradictions.length ? 'contradictory' : unresolved.length ? 'unresolved' : 'verified';
    evidence.push(...contradictions, ...unresolved);
    return {kind:'ok', value:{status, provider:publicProvider(config.provider), evidence}};
  }
}

function publicProvider(provider: Provider): Provider {
  return {
    version:provider.version, domain:provider.domain, chainId:provider.chainId, type:'provider',
    providerId:provider.providerId, profileRef:provider.profileRef, owner:provider.owner,
    skill:provider.skill, skillVersion:provider.skillVersion,
    identityRefs:[...provider.identityRefs], paymentAddress:provider.paymentAddress,
  };
}

function sameAddress(a: string, b: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(a) && /^0x[0-9a-f]{40}$/i.test(b) && a.toLowerCase() === b.toLowerCase();
}

/** ERC-8004's agentRegistry is namespace:chainId:registryAddress; agentId is separate. */
function matchesRef(ref: string, registry: string, agentId: string): boolean {
  const slash = ref.lastIndexOf('/');
  return slash > 0 && ref.slice(0, slash) === registry && ref.slice(slash + 1) === agentId;
}
