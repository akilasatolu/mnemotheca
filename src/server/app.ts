// src/server/app.ts — Hono アプリ生成(設計 §2-3 / §10-1)。
//
// 責務(設計 §2-3「app」行):
//   - トークン認証ミドルウェア(`/api/*` は `Authorization: Bearer <token>`、
//     例外 `GET /api/events` はクエリ `?t=<token>`)
//   - セキュリティ / キャッシュヘッダ(全レスポンスに `Referrer-Policy: no-referrer`、
//     `/api/*` に `Cache-Control: no-store`)
//   - 静的配信(`dist/web` を serveStatic + SPA フォールバック)
//   - `/api` ルータのマウントポイント(routes/* を後付けする)
//   - 共通エラーハンドラ(`MnemoError` → §10-1 のエラー形式 + ステータス)
//
// `createApp` は `apiRouter`(任意)を受け取り `/api` にマウントするだけの構造にしてある。
// routes 側は個別に `new Hono()` を作り、`createApp({...}, apiRouter)` として注入する
// (`src/server/mount.ts` の `mountApiRoutes` 参照)。

import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { Env, Hono as HonoType } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { isMnemoError, type ErrorCode } from '../core/errors.js';
import { createHealthRoutes } from './routes/health.js';

/** `createApp` の依存(設計 §10-1「認証」/ boot.ts が生成して渡す)。 */
export interface CreateAppDeps {
  /** projectRoot 絶対パス。`/healthz` の応答に含める。 */
  projectRoot: string;
  /** vault パス(既定 `<projectRoot>/vault`)。`/healthz` の応答に含める。 */
  vaultPath?: string;
  /** サーバー起動時に生成した Bearer トークン(`run.json` と同値)。 */
  token: string;
  /** listen 中のポート。`/healthz` の応答に含める。 */
  port: number;
  /** サーバー起動時刻(ISO 文字列)。`/healthz` の応答に含める。 */
  startedAt: string;
  /** 表示用バージョン(既定 `package.json` の version 相当。呼び出し側が渡す)。 */
  version?: string;
  /**
   * SPA アセットのルート(既定 `dist/web`)。テストや特殊配置向けに上書き可能。
   * 実行時は compiled `dist/server/app.js` から見て `../web`。
   */
  webRoot?: string;
}

/**
 * `MnemoError.code` → HTTP ステータスのマッピング(設計 §10-1「共通エラー形式」/ §12-1)。
 *
 * 設計 §12-1 には共通マッピング関数の定義が無いため(§10-1 の本文記述に従い)ここで実装する。
 * - 401: `UNAUTHORIZED`(認証。§10-1 認証ミドルウェア)
 * - 400: `QUERY_TOO_SHORT`(バリデーション。§5-3 / §10-1)
 * - 409: `LOCK_TIMEOUT`(ロック競合)、`SLUG_COLLISION`(衝突)
 * - 422: frontmatter パース / スキーマ / 不変条件 / PII ブロック等の「処理不能」(§10-1)
 * - 503: `VAULT_UNAVAILABLE` / `VAULT_NOT_WRITABLE`(vault 不達)、`INDEX_BUILD_FAILED`(インデックス未構築)
 * - 500: それ以外(サーバー稼働中に起きるなら基本「想定外」。`NOT_INITIALIZED` 等)
 *
 * ノート / カテゴリ不在の 404 は専用 `ErrorCode` が無く、各 route が個別に返す。
 */
export function errorToStatus(code: ErrorCode): ContentfulStatusCode {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'QUERY_TOO_SHORT':
      return 400;
    case 'LOCK_TIMEOUT':
    case 'SLUG_COLLISION':
      return 409;
    case 'FRONTMATTER_PARSE':
    case 'FRONTMATTER_SCHEMA':
    case 'CATEGORY_INVARIANT':
    case 'SLUG_INVALID':
    case 'PII_BLOCKED':
    case 'PROPOSAL_CONFLICT':
    case 'DESTRUCTIVE_NOT_CONFIRMED':
    case 'ORGANIZE_SESSION_EXPIRED':
      return 422;
    case 'VAULT_UNAVAILABLE':
    case 'VAULT_NOT_WRITABLE':
    case 'INDEX_BUILD_FAILED':
      return 503;
    default:
      return 500;
  }
}

/** §10-1「共通エラー形式」 `{ error: { code, message, details } }`。 */
interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}

function errorBody(code: string, message: string, details: Record<string, unknown> = {}): ErrorBody {
  return { error: { code, message, details } };
}

/** 長さに依存しない定数時間のトークン比較。 */
function tokensMatch(expected: string, presented: string | undefined | null): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** compiled: `dist/server/app.js` → `dist/web`。TS 実行時: `src/server` → `src/web`。 */
const DEFAULT_WEB_ROOT = path.resolve(HERE, '../web');

/**
 * Hono アプリを生成する(設計 §10-1)。
 *
 * @param deps  boot.ts が用意する projectRoot / token / port / startedAt など
 * @param apiRouter  `/api` にマウントする Hono ルータ(任意)。routes/* が用意でき次第
 *                   `mountApiRoutes()` 相当で束ねて渡す。省略時は `/api/*` は
 *                   認証・ヘッダだけ通り、未定義パスは 404(共通エラー形式)。
 */
export function createApp(deps: CreateAppDeps, apiRouter?: HonoType<Env>): Hono {
  const {
    projectRoot,
    token,
    port,
    startedAt,
    version = '0.0.0',
    vaultPath = path.join(projectRoot, 'vault'),
    webRoot = DEFAULT_WEB_ROOT,
  } = deps;

  const app = new Hono();

  // --- 全レスポンス共通: Referrer-Policy: no-referrer(トークン漏洩防止。§10-1) ---
  app.use('*', async (c, next) => {
    await next();
    c.header('Referrer-Policy', 'no-referrer');
  });

  // --- /api/* 共通: Cache-Control: no-store(§10-1) ---
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  // --- /api/* 認証(§10-1「認証」) ---
  //   通常: Authorization: Bearer <token>
  //   例外: GET /api/events は ?t=<token>(ヘッダがあればヘッダ優先、無ければ t)
  app.use('/api/*', async (c, next) => {
    const authHeader = c.req.header('Authorization');
    let presented: string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      presented = authHeader.slice('Bearer '.length).trim();
    } else if (c.req.method === 'GET' && c.req.path === '/api/events') {
      presented = c.req.query('t');
    }
    if (!tokensMatch(token, presented)) {
      return c.json(errorBody('UNAUTHORIZED', '認証に失敗しました。'), 401);
    }
    await next();
  });

  // --- GET /healthz(無認証。§10-1 エンドポイント表) ---
  //   `routes/health.ts` の `createHealthRoutes` に一本化(重複実装排除)。
  //   レスポンスは §10-1 の 7 キー固定で従来と bit 単位で同一。
  app.route('/', createHealthRoutes({ projectRoot, vaultPath, port, startedAt, version }));

  // --- /api ルータのマウントポイント ---
  //   `apiRouter` の組み立ては `src/server/mount.ts` の `mountApiRoutes` が行う
  //   (routes/* を統一規約で束ねて `/api` 配下にマウントする)。
  if (apiRouter) {
    app.route('/api', apiRouter);
  }

  // --- /api/* の未定義パスは 404 を共通エラー形式で(SPA フォールバックに流さない) ---
  app.all('/api/*', (c) => c.json(errorBody('NOT_FOUND', '該当するエンドポイントがありません。'), 404));

  // --- 静的配信 + SPA フォールバック(§1-2「Hono が serveStatic で配信」) ---
  //   serveStatic の root は cwd 相対。絶対 webRoot を cwd 相対に変換する。
  const relWebRoot = path.relative(process.cwd(), webRoot) || '.';
  app.use('*', serveStatic({ root: relWebRoot }));
  // ファイルが無ければ index.html を返す(クライアントルーティング)。
  app.get('*', serveStatic({ path: path.join(relWebRoot, 'index.html') }));
  // それでも無ければ 404。
  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'ページが見つかりません。'), 404));

  // --- 共通エラーハンドラ(§10-1「共通エラー形式」+ §12-1) ---
  app.onError((err, c) => {
    if (isMnemoError(err)) {
      return c.json(
        errorBody(err.code, err.message, err.details ?? {}),
        errorToStatus(err.code),
      );
    }
    if (err instanceof HTTPException) {
      const res = err.getResponse();
      if (res.headers.get('content-type')?.includes('application/json')) return res;
      return c.json(errorBody('HTTP_ERROR', err.message || 'リクエストを処理できません。'), err.status);
    }
    // 想定外
    // eslint-disable-next-line no-console
    console.error('[mnemo] unhandled error:', err);
    return c.json(errorBody('INTERNAL', '想定外のエラーが発生しました。'), 500);
  });

  return app;
}
