import type { Provider, Result } from '@secondbrain/desk-contracts/desk';

/** Provider configuration is untrusted input. Only fields declared here can leave the server. */
export interface ProviderProfileConfig {
  provider: Provider;
  name: string;
  description: string;
  image?: string;
  ensName?: string;
  services?: readonly PublicServiceInput[];
}

export interface PublicServiceInput {
  name: 'web' | 'A2A' | 'MCP' | 'OASF' | 'ENS' | 'DID';
  endpoint: string;
  version?: string;
}

export interface PublicService {
  name: PublicServiceInput['name'];
  endpoint: string;
  version?: string;
}

/** Deliberately small public projection; never serialize the input configuration object. */
export interface PublicProviderProfile {
  providerId: string;
  name: string;
  description: string;
  image?: string;
  owner: string;
  paymentAddress: string;
  skill: string;
  skillVersion: string;
  identityRefs: readonly string[];
  ensName?: string;
  services: readonly PublicService[];
}

export type IdentityStatus = 'verified' | 'unresolved' | 'contradictory';

export interface IdentityResolution {
  status: IdentityStatus;
  provider: Provider;
  evidence: readonly string[];
}

export type ProfileResult = { kind: 'ok'; value: PublicProviderProfile } | Exclude<Result<never>, { kind: 'ok' }>;

export interface EnsResolver {
  /** Must apply ENSIP-15 normalization and Universal Resolver resolution (ENS docs, read 2026-11-06). */
  normalizeName(name: string): string;
  resolveAddress(name: string): Promise<string | null>;
}

export interface Erc8004Registration {
  /** ERC-8004 agentRegistry tuple: namespace:chainId:registryAddress. */
  agentRegistry: string;
  agentId: string;
  owner: string;
  /** getAgentWallet() value; zero/unavailable is not silently replaced with owner. */
  paymentWallet: string | null;
  services: readonly { name: string; endpoint: string; version?: string }[];
}

export interface Erc8004Reader {
  /**
   * Resolve only against an explicitly configured, verified registry deployment and current ERC-8004
   * interface. Read token owner, agentURI registration data and getAgentWallet independently; reject
   * malformed/oversized metadata. Return null for a missing token and throw for unavailable reads.
   */
  readRegistration(identityRef: string): Promise<Erc8004Registration | null>;
}
