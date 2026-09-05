import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SPA(src/web)専用のビルド設定。設計 §1-2: build.outDir = dist/web。
// Hono が dist/web の静的ファイルを serveStatic で配信する。
const rootDir = import.meta.dirname;

// `npm run dev` 用。実サーバー(`mnemo start` / `mnemo_show` が起動するプロセス)を
// 別途起動しておき、そのポートを MNEMO_DEV_API_PORT で指定する(既定は起動レンジの
// 先頭 7777)。`/api/*` を実サーバーへプロキシし、SPA だけ HMR で編集できるようにする。
const apiPort = process.env['MNEMO_DEV_API_PORT'] ?? '7777';
const apiTarget = `http://127.0.0.1:${apiPort}`;

/**
 * 開発用トークン自動注入(§10-1 認証)。
 *
 * `src/core/paths.ts` の `runtimeBase()` / `runtimePaths()` と同じ規則で
 * `MNEMO_PROJECT` の run.json を探し、そこから起動中サーバーのトークンを読む。
 * これにより毎回 `?t=<token>` を手でコピーしなくても `npm run dev` だけで
 * 認証が通る(実サーバー側は Authorization ヘッダーがあれば /api/events 含め
 * 常にそれを優先するため、ヘッダー注入だけで完結する。app.ts の認証ミドルウェア参照)。
 *
 * `src/core/paths.ts` 自体を import しない理由: vite.config.ts は tsc を通さず
 * Vite 自身が esbuild で読むため、NodeNext 前提の `./errors.js` 相対 import が
 * 解決できない。ロジックが変わったらここも合わせて直すこと。
 */
let warnedNoProject = false;
let warnedReadFailure: string | undefined;

function readDevToken(): string | undefined {
  const projectRoot = process.env['MNEMO_PROJECT'];
  if (projectRoot === undefined || projectRoot === '') {
    if (!warnedNoProject) {
      warnedNoProject = true;
      console.warn(
        '[vite] MNEMO_PROJECT が未設定です。`?t=<token>` を手動で付けない限り /api/* は 401 になります。',
      );
    }
    return undefined;
  }
  try {
    const real = fs.realpathSync.native(resolve(projectRoot));
    const hash = createHash('sha256').update(real).digest('hex').slice(0, 16);
    const runtimeBase = process.env['MNEMO_RUNTIME_DIR'] ?? os.tmpdir();
    const runJsonPath = resolve(runtimeBase, 'mnemotheca', hash, 'run.json');
    const run = JSON.parse(fs.readFileSync(runJsonPath, 'utf8')) as { token?: string };
    warnedReadFailure = undefined;
    return run.token;
  } catch (err) {
    const message = String(err);
    if (warnedReadFailure !== message) {
      warnedReadFailure = message;
      console.warn(
        `[vite] run.json からトークンを読めませんでした(先に \`mnemo start\` を起動してください): ${message}`,
      );
    }
    return undefined;
  }
}

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
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            const token = readDevToken();
            if (token !== undefined) {
              proxyReq.setHeader('Authorization', `Bearer ${token}`);
            }
          });
        },
      },
    },
  },
});
