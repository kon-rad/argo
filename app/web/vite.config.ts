import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Resolve the optional addon at build time: browsers cannot resolve npm package names.
const virtualDesk = 'virtual:hiring-desk';
const resolvedDesk = '\0' + virtualDesk;
const deskPlugin = {
  name: 'hiring-desk',
  resolveId(id: string) { if (id === virtualDesk) return resolvedDesk; },
  load(id: string) {
    if (id !== resolvedDesk) return;
    try {
      const entry = fileURLToPath(import.meta.resolve('@secondbrain/hiring-desk/web'));
      return `export { default } from ${JSON.stringify(entry)};`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return `export default function DeskUnavailable() { return 'Hiring Desk is not installed in this build.'; }`;
    }
  },
};

export default defineConfig({
  plugins: [deskPlugin, react(), tailwindcss()],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:5123', changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
