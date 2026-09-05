// src/server/mount.ts — HTTP ルートのマウント結線(設計 §10-1 / §9-6 / §12-10)。
//
// 責務: `src/server/routes/*.ts` の 8 つの `create*Routes(deps)` を **統一規約**で 1 つの
// `/api` ルータに束ね、`createApp(appDeps, apiRouter)` に渡せる形にする。ロジックは一切
// 持たず、import + プレフィックス調整 + deps の受け渡しだけを行う(MCP の `registry.ts`
// に対応する server 側の結線ステップ)。
//
// マウント規約(このファイルで一元化する):
//   - `GET /healthz`             … `/api` の外・無認証。`createApp` が `createHealthRoutes`
//                                   で一本化してマウントする(重複実装排除。下記 `healthDepsFrom`)。
//   - 残り 8 グループ            … すべて `/api` 直下。プレフィックスは各ルートモジュールの
//                                   内部パス規約に合わせてこの mount 側で決める:
//       health-issues: `r.get('/health/issues')`    → `api.route('/', ...)`         → `/api/health/issues`
//       config      : `r.get('/config')` `/config/mcp-snippet` → `api.route('/', ...)` → `/api/config*`
//       notes       : `r.get('/')` `/:id` `/:id/rendered` → `api.route('/notes', ...)`  → `/api/notes*`
//       categories  : `r.get('/')`                  → `api.route('/categories', ...)` → `/api/categories`
//       search      : `r.get('/')`                  → `api.route('/search', ...)`     → `/api/search`
//       dashboard   : `r.get('/')`                  → `api.route('/dashboard', ...)`  → `/api/dashboard`
//       reindex     : `r.post('/reindex')`          → `api.route('/', ...)`           → `/api/reindex`
//       events      : `r.get('/events')`            → `api.route('/', ...)`           → `/api/events`
//     ルートモジュール本体(`routes/*.ts`)は変更しない。ズレは prefix でのみ吸収する。
//
// `organizeRecoveryPending`(設計 §12-10 表 #3): boot が「フラグを立てるのみ・
// `organize-session.json` を書き換えない」で読み取った値は、`GET /api/health/issues` の
// レスポンスフィールドとして返す(設計 §10-1。以前は暫定的に `/api/config` へ上乗せ
// していたが、`/api/health/issues` へ移設済みで `/api/config` の上乗せは撤去した)。
//
// 規約: ESM / NodeNext / strict / verbatimModuleSyntax / noUncheckedIndexedAccess。

import { Hono } from 'hono';
import type { IndexHandle } from '../core/search.js';
import type { CreateAppDeps } from './app.js';
import { createHealthRoutes, createHealthIssuesRoutes, type HealthRouteDeps } from './routes/health.js';
import { createConfigRoutes, type IndexMetaView } from './routes/config.js';
import { createNotesRoutes } from './routes/notes.js';
import { createCategoriesRoutes } from './routes/categories.js';
import { createSearchRoutes } from './routes/search.js';
import { createDashboardRoutes } from './routes/dashboard.js';
import { createReindexRoutes } from './routes/reindex.js';
import { createEventsRoutes, type IndexEventPayload } from './routes/events.js';

/** boot が読み取った中断 organize の要約(設計 §10-1 `/api/health/issues` / §12-10)。 */
export interface OrganizeRecoveryPending {
  /** `restoreSnapshot` 対象(`<label>-<ts>`)。 */
  snapshotId: string;
  /** 中断 organize の scan 時刻(ISO 文字列)。 */
  since: string;
}

/**
 * `mountApiRoutes` の依存。`server/boot.ts` が live なインデックスハンドル・watcher 購読・
 * トークン等をまとめて組み立てて渡す。
 */
export interface MountApiRoutesDeps {
  /** projectRoot 絶対パス。 */
  projectRoot: string;
  /** vault パス(既定 `<projectRoot>/vault`)。 */
  vaultPath: string;
  /** listen 中のポート。 */
  port: number;
  /** サーバー起動時刻(ISO 文字列)。 */
  startedAt: string;
  /** 表示用バージョン。 */
  version: string;
  /** Bearer トークン(`run.json` と同値)。SSE の `?t=` 照合に使う。 */
  token: string;
  /** サーバーが保持する live インデックスハンドルを返す(search / reindex 差分適用の対象)。 */
  getIndex: () => Promise<IndexHandle>;
  /** `POST /api/reindex {full:true}` 後、新ハンドルで boot の live ハンドルを差し替えるコールバック。 */
  onRebuilt?: (h: IndexHandle) => void;
  /**
   * インデックス更新イベントの購読関数。`cb` を登録し解除関数を返す。
   * boot 側で watcher の `onIndexUpdated` をファンアウトした購読関数を渡す。
   */
  subscribe: (cb: (payload: IndexEventPayload) => void) => () => void;
  /**
   * `GET /api/config` の `noteCount` / `indexBuiltAt` に使うインデックスメタ。
   * 省略時は config.ts が `<projectRoot>/.mnemotheca/index/meta.json` をディスクから読む。
   */
  readIndexMeta?: () => Promise<IndexMetaView | null>;
  /**
   * 中断 organize の有無を返す(設計 §12-10。boot が `organize-session.json` を読み取り専用で判定)。
   * 省略時 / null 時は `GET /api/config` に `organizeRecoveryPending: null` を返す。
   */
  getOrganizeRecoveryPending?: () => Promise<OrganizeRecoveryPending | null>;
  /** SSE keepalive 間隔(ms)。テスト用に透過。 */
  keepaliveMs?: number;
  /**
   * watcher が縮退し監視停止中か(watcher の `isDown()`。設計 §6-5 / §10-1
   * `/api/health/issues.watcherDown`)。boot が watcher 起動後に配線する。未配線時は `false` 扱い。
   */
  watcherIsDown?: () => boolean;
}

/** `MountApiRoutesDeps` から `createHealthRoutes` 用の deps を切り出す(`createApp` が使う)。 */
export function healthDepsFrom(
  deps: Pick<CreateAppDeps, 'projectRoot' | 'port' | 'startedAt'> & {
    vaultPath: string;
    version: string;
  },
): HealthRouteDeps {
  return {
    projectRoot: deps.projectRoot,
    vaultPath: deps.vaultPath,
    port: deps.port,
    startedAt: deps.startedAt,
    version: deps.version,
  };
}

/**
 * 7 グループ(health を除く)を `/api` 直下に束ねた Hono を返す。
 * `createApp(appDeps, mountApiRoutes(deps))` として渡す(`createApp` は `/api` にマウントする)。
 *
 * `/healthz` は `/api` の外・無認証のためこのルータには含めない。`createApp` が
 * `createHealthRoutes(healthDepsFrom(deps))` で別途マウントする(設計タスク項目 (2))。
 * 「8 ルート群」= この 7 + `createApp` 側の health で過不足なく満たす。
 */
export function mountApiRoutes(deps: MountApiRoutesDeps): Hono {
  const api = new Hono();

  // --- GET /api/health/issues(§10-1。診断バナー。organizeRecoveryPending / watcherDown の行き先) ---
  api.route('/', createHealthIssuesRoutes({
    projectRoot: deps.projectRoot,
    vaultPath: deps.vaultPath,
    ...(deps.watcherIsDown ? { watcherIsDown: deps.watcherIsDown } : {}),
    ...(deps.getOrganizeRecoveryPending ? { getOrganizeRecoveryPending: deps.getOrganizeRecoveryPending } : {}),
  }));

  // --- 7 グループを統一規約でマウント ---
  api.route('/', createConfigRoutes({
    projectRoot: deps.projectRoot,
    vaultPath: deps.vaultPath,
    port: deps.port,
    ...(deps.readIndexMeta ? { readIndexMeta: deps.readIndexMeta } : {}),
  }));
  api.route('/notes', createNotesRoutes({ projectRoot: deps.projectRoot }));
  api.route('/categories', createCategoriesRoutes({ projectRoot: deps.projectRoot }));
  api.route('/search', createSearchRoutes({ projectRoot: deps.projectRoot, getIndex: deps.getIndex }));
  api.route('/dashboard', createDashboardRoutes({ projectRoot: deps.projectRoot }));
  api.route('/', createReindexRoutes({
    projectRoot: deps.projectRoot,
    getIndex: deps.getIndex,
    ...(deps.onRebuilt ? { onRebuilt: deps.onRebuilt } : {}),
  }));
  api.route('/', createEventsRoutes({
    token: deps.token,
    subscribe: deps.subscribe,
    ...(deps.keepaliveMs !== undefined ? { keepaliveMs: deps.keepaliveMs } : {}),
  }));

  return api;
}

export { createHealthRoutes };
