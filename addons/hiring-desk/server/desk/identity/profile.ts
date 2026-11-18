import type { Provider } from '@secondbrain/desk-contracts/desk';
import type { ProfileResult, ProviderProfileConfig, PublicProviderProfile, PublicService, PublicServiceInput } from './types.js';

const serviceNames = new Set<PublicServiceInput['name']>(['web', 'A2A', 'MCP', 'OASF', 'ENS', 'DID']);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= 4096 && !/[\u0000-\u001f]/.test(value);
const isPublicUri = (value: unknown): value is string => isText(value) && /^(https?:\/\/[^\s]+|ipfs:\/\/[^\s]+|did:[^\s]+)$/.test(value);
function isServiceEndpoint(name: unknown, endpoint: unknown): endpoint is string {
  if (name === 'ENS') return isText(endpoint) && /^(?=.{1,253}$)[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+\.?$/.test(endpoint);
  if (name === 'DID') return isText(endpoint) && /^did:[a-z0-9]+:.+$/.test(endpoint);
  if (name === 'OASF') return isText(endpoint) && /^(https?:\/\/[^\s]+|ipfs:\/\/[^\s]+)$/.test(endpoint);
  return isText(endpoint) && /^https:\/\/[^\s]+$/.test(endpoint);
}
const isProvider = (value: unknown): value is Provider => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return p.type === 'provider' && p.version === 'desk/v1' && ['domain','chainId','providerId','profileRef','owner','skill','skillVersion','paymentAddress'].every(k => isText(p[k])) && Array.isArray(p.identityRefs) && p.identityRefs.length <= 64 && p.identityRefs.every(isText);
};

/** Project a config through an explicit allowlist. Unknown keys, including secrets, are dropped. */
export function compilePublicProfile(input: unknown): ProfileResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {kind:'invalid-input', message:'Provider profile must be an object'};
  const config = input as Record<string, unknown>;
  if (!isProvider(config.provider) || !isText(config.name) || !isText(config.description)) return {kind:'invalid-input', message:'Provider, name and description are required'};
  if (config.image !== undefined && !isPublicUri(config.image)) return {kind:'invalid-input', message:'Image must be a public URL or content URI'};
  if (config.ensName !== undefined && !isText(config.ensName)) return {kind:'invalid-input', message:'ENS name must be non-empty text'};
  if (config.services !== undefined && (!Array.isArray(config.services) || config.services.length > 32)) return {kind:'invalid-input', message:'Services must be a bounded list'};
  const services: PublicService[] = [];
  for (const raw of (config.services ?? []) as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {kind:'invalid-input', message:'Invalid public service'};
    const service = raw as Record<string, unknown>;
    if (!serviceNames.has(service.name as PublicServiceInput['name']) || !isServiceEndpoint(service.name, service.endpoint) || (service.version !== undefined && !isText(service.version))) return {kind:'invalid-input', message:'Invalid public service'};
    const projection: PublicService = {name: service.name as PublicServiceInput['name'], endpoint: service.endpoint};
    if (service.version !== undefined) projection.version = service.version;
    services.push(projection);
  }
  const provider = config.provider;
  const profile: PublicProviderProfile = {
    providerId: provider.providerId,
    name: config.name,
    description: config.description,
    owner: provider.owner,
    paymentAddress: provider.paymentAddress,
    skill: provider.skill,
    skillVersion: provider.skillVersion,
    identityRefs: [...provider.identityRefs],
    services,
  };
  if (config.image !== undefined) profile.image = config.image;
  if (config.ensName !== undefined) profile.ensName = config.ensName;
  return {kind:'ok', value:profile};
}
