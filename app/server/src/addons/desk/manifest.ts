import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'desk',
  core: false,
  summary: 'External hiring desk addon',
  nav: [{ section: 'Work', label: 'Hiring desk', path: '/desk' }],
  cli: [], timers: [], wrappers: [],
  env: ['DESK_DOMAIN', 'DESK_CHAIN_ID', 'DESK_PUBLIC_ORIGIN', 'DESK_PAYMENT_INTERFACE', 'DESK_USDC_ADDRESS', 'DESK_RPC_URL', 'DESK_RUNTIME_MODULE'],
  settings: 'desk',
  docs: 'docs/modules.md#desk',
});
