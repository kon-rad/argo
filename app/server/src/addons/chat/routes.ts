import type { FeatureRoutes } from '../../features/types.js';
import { defaultEmbeddingProvider } from '../../embeddings/factory.js';
import { chatRouter } from '../../routes/chat.js';

// Ask your second brain: retrieval over the same index the search uses, answered by a chat model.
export const routes: FeatureRoutes = ({ vaultRoot, opts }) => [
  {
    path: '/api/chat',
    router: chatRouter({
      vaultRoot,
      embeddingProvider: opts.embeddingProvider ?? defaultEmbeddingProvider,
      ...opts.chat,
    }),
  },
];
