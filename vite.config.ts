/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` is relative so the static build works from any sub-path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  plugins: [react()],
  optimizeDeps: { exclude: ['web-ifc'] },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
