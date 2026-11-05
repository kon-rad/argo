import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'chat',
  core: false,
  summary: 'Ask your second brain: conversations answered from retrieved passages, with citations. Planned to become base',
  nav: [],
  cli: [],
  timers: [],
  wrappers: [],
  env: ['RERANK_URL', 'RERANK_API_KEY', 'RERANK_MODEL'],
  settings: 'chat',
  docs: 'docs/modules.md#chat',
});
