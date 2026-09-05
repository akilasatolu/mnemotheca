import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SPA(src/web)専用のビルド設定。設計 §1-2: build.outDir = dist/web。
// Hono が dist/web の静的ファイルを serveStatic で配信する。
const rootDir = import.meta.dirname;

export default defineConfig({
  root: resolve(rootDir, 'src/web'),
  plugins: [react()],
  build: {
    outDir: resolve(rootDir, 'dist/web'),
    emptyOutDir: true,
  },
});
