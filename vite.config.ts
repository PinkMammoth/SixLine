import { defineConfig } from 'vite';
import { alphaTab } from '@coderline/alphatab-vite';

export default defineConfig({
  base: './',
  plugins: [alphaTab()],
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4000 },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'] },
} as any);
