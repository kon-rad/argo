import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: { entry: 'web/src/Desk.tsx', formats: ['es'], fileName: 'Desk' },
    outDir: 'dist/web',
    emptyOutDir: false,
    rollupOptions: { external: ['react', 'react/jsx-runtime', 'react-markdown', 'remark-gfm', '@secondbrain/desk-contracts/desk'] },
  },
});
