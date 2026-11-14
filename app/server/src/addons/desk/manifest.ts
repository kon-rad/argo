import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'desk',
  core: false,
  summary: 'External hiring desk addon',
  nav: [{ section: 'Work', label: 'Hiring desk', path: '/desk' }],
  cli: [], timers: [], wrappers: [],
  env: ['DESK_DOMAIN', 'DESK_CHAIN_ID', 'DESK_PUBLIC_ORIGIN', 'DESK_PAYMENT_INTERFACE', 'DESK_USDC_ADDRESS', 'DESK_RPC_URL', 'DESK_RUNTIME_MODULE', 'DESK_ARKIV_RPC_URL', 'DESK_ARKIV_CHAIN_ID', 'DESK_ARKIV_PRIVATE_KEY', 'DESK_ARKIV_LIFETIME_BLOCKS', 'DESK_BEE_URL', 'DESK_BEE_POSTAGE_BATCH_ID', 'DESK_IDENTITY_RPC_URL', 'DESK_IDENTITY_CHAIN_ID', 'DESK_ENS_RPC_URL', 'DESK_ENS_CHAIN_ID', 'DESK_ERC8004_REGISTRY_ADDRESS', 'DESK_IDENTITY_METADATA_HOSTS', 'DESK_TRANSPORT_TIMEOUT_MS', 'DESK_MAX_RESPONSE_BYTES', 'DESK_MAX_ARTIFACT_BYTES', 'DESK_PUBLICATION_DESTINATION'],
  settings: 'desk',
  docs: 'docs/modules.md#desk',
});
