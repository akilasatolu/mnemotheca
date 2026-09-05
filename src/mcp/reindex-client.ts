// src/mcp/reindex-client.ts — 再インデックスのオーケストレーション(設計書 §6-6)。
//
// 「稼働中の HTTP サーバーに `POST /api/reindex`(run.json の token を Bearer)を投げる →
//  失敗時(run.json 無し / pid 死亡 / healthz 不一致 / 非2xx / タイムアウト)は
//  core のインデックス関数(`syncIndex` / `buildIndex`)でファイルを直接更新する」
// という調整ロジックを 1 か所に集約する。MCP tool(store / organize apply 後)と
// CLI(`cli/commands/reindex.ts`)の両方から共有利用される(§2-2 モジュール表)。
//
// レイヤー所属(§6-6 確定): この層は `core` の**外**。`core/search.ts` は外部通信を
// 持たず、直更新パス(`loadIndex` / `syncIndex` / `buildIndex`)のみを公開する。
//
// 依存は node 標準 + `core/*` のみ。実サーバーは立てず、`fetch` は差し替え可能にする。

import fs from 'node:fs';

import { normalizePath, runtimePaths } from '../core/paths.js';
import { buildIndex, loadIndex, syncIndex } from '../core/search.js';

/** `<runtimeBase>/mnemotheca/<projectHash>/run.json` のスキーマ(設計 §10-3)。 */
export interface RunInfo {
  v?: number;
  pid: number;
  port: number;
  token: string;
  startedAt?: string;
  projectRoot: string;
  version?: string;
  detached?: boolean;
}

/** `GET /healthz` のレスポンス(設計 §10-1。無認証)。 */
export interface HealthzResponse {
  ok?: boolean;
  name?: string;
  version?: string;
  projectRoot?: string;
  vaultPath?: string;
  port?: number;
  startedAt?: string;
}

/** 差し替え可能な `fetch`(テストでスタブ)。既定は `globalThis.fetch`。 */
export type FetchLike = typeof globalThis.fetch;

/** `detectRunningServer` / `reindexPaths` 共通の注入ポイント。 */
export interface ReindexDeps {
  /** 内部 API 呼び出しに使う `fetch`。省略時は `globalThis.fetch`。 */
  fetch?: FetchLike;
}

const DEFAULT_HEALTHZ_TIMEOUT_MS = 800;
const DEFAULT_API_TIMEOUT_MS = 3000;

/**
 * `run.json` を真実の源にしない(§12-13 N-4)。pid 生存 + `/healthz` の projectRoot 一致で
 * 「稼働中サーバー」を判定する(設計 §8-O / §13-11b)。
 *
 * この判定は設計上 `mcp/tools/list.ts` / `mcp/tools/show.ts` と共有される
 * (§13-11b「§8-O と同じ判定関数を使う」)。本モジュールで実装・export し、
 * list / show はここから `detectRunningServer` を import して使う。
 */
export interface ServerDetection {
  /** pid 生存 + healthz の projectRoot 一致まで確認できたら true。 */
  running: boolean;
  /** 読めた `run.json`(パース不能 / 不在なら null)。 */
  run: RunInfo | null;
  /** `running` のとき `http://127.0.0.1:<port>`。それ以外は null。 */
  url: string | null;
}

/** `process.kill(pid, 0)` が例外を投げなければ生存(EPERM = 別ユーザーの生存プロセス)。 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

async function fetchHealthz(
  port: number,
  timeoutMs: number,
  fetchImpl: FetchLike | undefined,
): Promise<HealthzResponse | null> {
  if (typeof fetchImpl !== 'function') {
    return null;
  }
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as HealthzResponse;
  } catch {
    return null;
  }
}

/**
 * 稼働中の HTTP サーバーを検出する(設計 §6-6 / §8-O)。
 *
 * 1. tmp 側 `run.json` を読む。不在 / JSON 破損 / 必須フィールド欠落 → 未稼働。
 * 2. `run.projectRoot` が引数の projectRoot と不一致 → 未稼働扱い(§6-6)。
 * 3. `process.kill(run.pid, 0)` で pid 生存を確認。死亡 → 未稼働。
 * 4. `GET /healthz` の `ok` + `projectRoot` 一致を確認(§13-11b)。不一致 / 無応答 → 未稼働。
 */
export async function detectRunningServer(
  projectRoot: string,
  deps: ReindexDeps & { healthzTimeoutMs?: number } = {},
): Promise<ServerDetection> {
  const runPath = runtimePaths(projectRoot).runJson;

  let raw: string;
  try {
    raw = await fs.promises.readFile(runPath, 'utf8');
  } catch {
    return { running: false, run: null, url: null };
  }

  let run: RunInfo;
  try {
    const parsed = JSON.parse(raw) as Partial<RunInfo>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.projectRoot !== 'string'
    ) {
      return { running: false, run: null, url: null };
    }
    run = parsed as RunInfo;
  } catch {
    return { running: false, run: null, url: null };
  }

  if (normalizePath(run.projectRoot) !== normalizePath(projectRoot)) {
    return { running: false, run, url: null };
  }

  if (!isPidAlive(run.pid)) {
    return { running: false, run, url: null };
  }

  const health = await fetchHealthz(
    run.port,
    deps.healthzTimeoutMs ?? DEFAULT_HEALTHZ_TIMEOUT_MS,
    deps.fetch ?? globalThis.fetch,
  );
  const healthOk =
    health?.ok === true &&
    typeof health.projectRoot === 'string' &&
    normalizePath(health.projectRoot) === normalizePath(projectRoot);
  if (!healthOk) {
    return { running: false, run, url: null };
  }

  return { running: true, run, url: `http://127.0.0.1:${run.port}` };
}

/** `reindexPaths` の結果。 */
export interface ReindexResult {
  ok: true;
  /** `'server'` = API 経由でサーバーのインメモリインデックスも更新した / `'direct'` = ファイル直更新。 */
  via: 'server' | 'direct';
  /** サーバーは稼働していたが API 呼び出しに失敗し、ファイル直更新にフォールバックした(§12-11)。 */
  serverFellBack: boolean;
  /** フル再構築だったか。 */
  full: boolean;
  added: number;
  updated: number;
  removed: number;
  tookMs: number;
}

/** `reindexPaths` のオプション。 */
export interface ReindexOptions extends ReindexDeps {
  /** true で全再構築(`buildIndex`)。false / 省略で差分(`syncIndex`)。 */
  full?: boolean;
  /** `/healthz` のタイムアウト(ms)。既定 800。 */
  healthzTimeoutMs?: number;
  /** `POST /api/reindex` のタイムアウト(ms)。既定 3000(§6-6)。 */
  apiTimeoutMs?: number;
}

interface Counts {
  added: number;
  updated: number;
  removed: number;
  tookMs: number;
}

async function postReindex(
  run: RunInfo,
  body: { full: boolean; paths?: string[] },
  timeoutMs: number,
  fetchImpl: FetchLike | undefined,
): Promise<Counts | null> {
  if (typeof fetchImpl !== 'function') {
    return null;
  }
  const payload: Record<string, unknown> = { full: body.full };
  if (body.paths !== undefined) {
    payload.paths = body.paths;
  }
  try {
    const res = await fetchImpl(`http://127.0.0.1:${run.port}/api/reindex`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${run.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return null; // 非 2xx → ファイル直更新へフォールバック(§6-6 / §12-11)
    }
    const json = (await res.json()) as Partial<Counts>;
    return {
      added: num(json.added),
      updated: num(json.updated),
      removed: num(json.removed),
      tookMs: num(json.tookMs),
    };
  } catch {
    return null; // タイムアウト / ネットワーク断 → フォールバック
  }
}

/**
 * ファイル直更新パス(§6-6)。
 *
 * `buildIndex` / `syncIndex` は内部で `withLock(projectRoot, 'index')` を取得する(§6-3)。
 * `'index'` ロックは入れ子取得しない方針(§6-3)なので、ここで **外側から `withLock` しない**
 * (二重取得は proper-lockfile では取得タイムアウトになる)。設計 §6-6 の文面上は
 * 「CLI が `withLock(projectRoot, 'index')` で…」とあるが、ロックの実所在は core 側であり
 * §6-3 の「入れ子取得しない」規約を優先する。
 */
async function directReindex(projectRoot: string, full: boolean): Promise<Counts> {
  const startedAt = Date.now();
  if (full) {
    // `buildIndex` は既存キャッシュを読まず search-index.json / meta.json を上書きする
    // フル再構築なので、明示的なキャッシュ削除は不要(§6-6)。
    const handle = await buildIndex(projectRoot);
    return { added: handle.meta.docCount, updated: 0, removed: 0, tookMs: Date.now() - startedAt };
  }
  const handle = await loadIndex(projectRoot);
  const delta = await syncIndex(handle);
  return { ...delta, tookMs: Date.now() - startedAt };
}

/**
 * 再インデックスを実行する(設計 §6-6)。
 *
 * - 稼働中サーバーあり → `POST /api/reindex`(`run.json` の token を `Authorization: Bearer`)。
 *   2xx なら `via:'server'` で返す。
 * - サーバー無し / healthz 不一致 → 最初からファイル直更新(`via:'direct'`, `serverFellBack:false`)。
 * - サーバーは生きているが API が非2xx / タイムアウト → ファイル直更新にフォールバック
 *   (`via:'direct'`, `serverFellBack:true`。§12-11: 呼び出し側は 1 行付記する)。
 *
 * @param paths 変更のあった vault 相対パス(`knowledge/**`)。省略で全体対象。
 */
export async function reindexPaths(
  projectRoot: string,
  paths?: string[],
  opts: ReindexOptions = {},
): Promise<ReindexResult> {
  const full = opts.full ?? false;
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  const detection = await detectRunningServer(projectRoot, {
    fetch: fetchImpl,
    healthzTimeoutMs: opts.healthzTimeoutMs,
  });

  if (detection.running && detection.run) {
    const server = await postReindex(
      detection.run,
      { full, paths },
      opts.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS,
      fetchImpl,
    );
    if (server) {
      return { ok: true, via: 'server', serverFellBack: false, full, ...server };
    }
    const direct = await directReindex(projectRoot, full);
    return { ok: true, via: 'direct', serverFellBack: true, full, ...direct };
  }

  const direct = await directReindex(projectRoot, full);
  return { ok: true, via: 'direct', serverFellBack: false, full, ...direct };
}
