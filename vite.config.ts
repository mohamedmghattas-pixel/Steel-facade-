/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * rhino3dm's Emscripten glue requires the Node-only "ws" package on a Node code
 * path (sockets, never used here): the browser build and the dev pre-bundle get
 * an empty module instead.
 */
export const noNodeWs = {
  name: 'facadesteel:no-node-ws',
  resolveId: (id: string) => (id === 'ws' ? '\0no-node-ws' : null),
  load: (id: string) => (id === '\0no-node-ws' ? 'export default {};' : null),
};

// `base` is relative so the static build works from any sub-path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  plugins: [react(), noNodeWs],
  optimizeDeps: { exclude: ['web-ifc'], rolldownOptions: { plugins: [noNodeWs] } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
