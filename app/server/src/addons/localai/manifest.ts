import { defineFeature } from '../../features/types.js';
export default defineFeature({
  name: 'localai', core: false,
  summary: 'Copies local model gateway calls into the local usage ledger',
  nav: [],
  cli: [{ command: 'local-ai-pull', entry: 'cli-localai-pull.js', summary: 'copy a local model gateway call log' }],
  timers: [{ unit: 'secondbrain-localai-pull', calendar: '*-*-* *:0/5:00', command: 'local-ai-pull',
    summary: 'Copy local model calls every five minutes', description: 'Second Brain local model usage pull',
    service: { after: ['network-online.target', 'postgresql.service'], requires: ['postgresql.service'], directives: ['SuccessExitStatus=2'] } }],
  wrappers: [], env: ['LOCAL_AI_EXPORT_URL', 'LOCAL_AI_HOST'], docs: 'docs/modules.md#localai',
});
