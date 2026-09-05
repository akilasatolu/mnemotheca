import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SPA(src/web)専用のビルド設定。設計 §1-2: build.outDir = dist/web。
// Hono が dist/web の静的ファイルを serveStatic で配信する。
const rootDir = import.meta.dirname;

// `npm run dev` 用。実サーバー(`node dist/server/boot.js` 等)を別途起動しておき、
// そのポートを MNEMO_DEV_API_PORT で指定する(既定は起動レンジの先頭 7777)。
// `/api/*` と `/api/events`(SSE)を実サーバーへプロキシし、SPA だけ HMR で編集できるようにする。
const apiPort = process.env['MNEMO_DEV_API_PORT'] ?? '7777';
const apiTarget = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  root: resolve(rootDir, 'src/web'),
  plugins: [react()],
  build: {
    outDir: resolve(rootDir, 'dist/web'),
    emptyOutDir: true,
  },
  server: {
    // 既定の `host: 'localhost'` は環境によって ::1 にしか bind されないことがあり、
    // 127.0.0.1 に明示 bind する実サーバー(boot.ts)と食い違ってアクセスできなくなる。
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
