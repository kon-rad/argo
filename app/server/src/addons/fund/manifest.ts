import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'fund',
  core: false,
  summary: 'A read-only view of an agentic fund: wallet balances, transactions, pending approvals, committee and run health',
  nav: [{ section: 'Work', label: 'Fund', path: '/fund' }],
  cli: [],
  timers: [],
  wrappers: [],
  env: ['BASE_RPC_URL'],
  settings: 'fund',
  docs: 'docs/modules.md#fund',
});
