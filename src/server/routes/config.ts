// src/server/routes/config.ts — `GET /api/config`(表示専用。設計 §10-1 エンドポイント表 / §2-3 / §8-B)。
//
// 責務:
//   - `GET /api/config`: 現在の設定・環境情報を返す。ポータブルモデルのため vault は
//     `<projectRoot>/vault` 固定で、**設定を変更する API は存在しない**(設計 §10-1 /
//     §8-B / §13-13「vault パス変更 API は存在しない(ルート未定義 → 404)」)。
//
// レスポンス形は設計 §10-1 の表に厳密に一致:
//   `{ projectRoot, vaultPath, noteCount, indexBuiltAt, serverPort }`
//   - noteCount    … `meta.json` の `docCount`(未ビルドなら 0)
//   - indexBuiltAt … `meta.json` の `builtAt`(未ビルドなら null)
//
// 機密(Bearer トークン等)はこのレスポンスに一切含めない(設計 §10-1「認証」/ トークンは
// `run.json` と `Authorization` ヘッダのみで流通)。認証は `server/app.ts` の `/api/*`
// ミドルウェアが担当する(このモジュールはルート定義だけを持つ)。
//
// **マウント位置**: `src/server/mount.ts` の `mountApiRoutes` が
// `apiRouter.route('/config', configRoutes(deps))` 相当で `/api` 配下にマウントする
// (`createApp(deps, apiRouter)` の `apiRouter`)。
//
// ## `PUT /api/config` を実装しない理由
// `PUT /api/config`(許可フィールド更新 + `saveConfig` 呼び出し)は実装しない。設計では:
//   - §10-1 のエンドポイント表に `PUT /api/config` は無い(`GET` のみ)。
//   - §8-B「`saveConfig` は `mnemo init`(および冪等再実行)以外からは呼ばない」不変条件。
//   - `Config` スキーマ(§9-2 / §8-B)は `{ v, createdAt, updatedAt }` のみで、ユーザーが
//     更新できるフィールドが 1 つも無い。`resolveVaultPath`/`setVaultPath`/`Config.vaultPath`
//     は「すべて廃止」と明記。
//   - §13-13「vault パス変更 API は存在しない(ルート未定義 → 404)」。
// 以上より設計を優先し、`GET` のみ実装する。未定義の `PUT /api/config` は `server/app.ts`
// の `/api/*` フォールスルーで 404(共通エラー形式)になる。
//
// 規約: ESM / NodeNext / strict / verbatimModuleSyntax / noUncheckedIndexedAccess。

import fs from 'node:fs';
import { Hono } from 'hono';
import { mnemothecaPaths } from '../../core/paths.js';
import { buildMcpSnippet } from '../../core/mcp-snippet.js';

/** `GET /api/config` が参照するインデックスメタ情報(`meta.json` の部分ビュー。設計 §6-2)。 */
export interface IndexMetaView {
  /** インデックス済みノート数(`meta.json.docCount`)。 */
  docCount: number;
  /** 直近のインデックス構築時刻(`meta.json.builtAt`、ISO 文字列)。 */
  builtAt: string;
}

/** `configRoutes` の依存(結線タスク / boot.ts が生成して渡す)。 */
export interface ConfigRouteDeps {
  /** projectRoot 絶対パス。 */
  projectRoot: string;
  /** vault パス(既定 `<projectRoot>/vault`)。 */
  vaultPath: string;
  /** listen 中のポート。レスポンスの `serverPort`。 */
  port: number;
  /**
   * `meta.json` を読む。存在しない / 壊れている場合は `null`。
   * 省略時は `<projectRoot>/.mnemotheca/index/meta.json` をディスクから読む
   * (`readIndexMetaFromDisk`)。テストではスタブを注入する。
   */
  readIndexMeta?: () => Promise<IndexMetaView | null>;
}

/** §10-1 の `GET /api/config` レスポンス schema。機密フィールドは含まない。 */
export interface ConfigResponse {
  projectRoot: string;
  vaultPath: string;
  noteCount: number;
  indexBuiltAt: string | null;
  serverPort: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `<projectRoot>/.mnemotheca/index/meta.json` から `docCount` / `builtAt` だけを読む。
 * 無い / JSON 破損 / 型不一致 → `null`(表示専用なので致命ではない)。
 */
export async function readIndexMetaFromDisk(projectRoot: string): Promise<IndexMetaView | null> {
  const { metaJson } = mnemothecaPaths(projectRoot);
  let raw: string;
  try {
    raw = await fs.promises.readFile(metaJson, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const docCount = parsed.docCount;
    const builtAt = parsed.builtAt;
    if (typeof docCount !== 'number' || typeof builtAt !== 'string') return null;
    return { docCount, builtAt };
  } catch {
    return null;
  }
}

/**
 * `GET /api/config`(表示専用)を持つ Hono サブアプリを返す。
 *
 * `/api` 配下にマウントされる前提(パスは `/config`)。認証は `server/app.ts` が担当。
 */
export function createConfigRoutes(deps: ConfigRouteDeps): Hono {
  const r = new Hono();
  const readIndexMeta = deps.readIndexMeta ?? (() => readIndexMetaFromDisk(deps.projectRoot));

  r.get('/config', async (c) => {
    const meta = await readIndexMeta();
    const body: ConfigResponse = {
      projectRoot: deps.projectRoot,
      vaultPath: deps.vaultPath,
      noteCount: meta?.docCount ?? 0,
      indexBuiltAt: meta?.builtAt ?? null,
      serverPort: deps.port,
    };
    return c.json(body);
  });

  // GET /api/config/mcp-snippet — MCP 連携スニペット(設計 §9-5 / §10-1 / §11-4 / §13-13)。
  //   `buildMcpSnippet(projectRoot)` の結果(`{ serverKey, snippet, filename }`)をそのまま返す。
  //   機密なし。`?client=code` で貼り付け先ファイル名が `.mcp.json` に変わる(既定 desktop)。
  //   `?env` 等の他クエリは無視される(`MNEMO_PROJECT` は常時同梱)。
  r.get('/config/mcp-snippet', (c) => {
    const client = c.req.query('client') === 'code' ? 'code' : 'desktop';
    return c.json(buildMcpSnippet(deps.projectRoot, { client }));
  });

  return r;
}

export default createConfigRoutes;
