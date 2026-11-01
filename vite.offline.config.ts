/**
 * Offline single-file build: `npm run build:offline` → dist-offline/FacadeSteel.html.
 * Everything (code, styles, the web-ifc and rhino3dm WebAssembly and the PDF worker) is
 * embedded so the file runs by double-clicking it — no server, no install.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { noNodeWs } from './vite.config';

export default defineConfig({
  base: './',
  plugins: [react(), noNodeWs],
  build: {
    outDir: 'dist-offline',
    emptyOutDir: true,
    // Inline every asset (wasm, pdf worker, fonts, images) as a data: URL.
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 20000,
    rolldownOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
