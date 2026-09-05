// src/server/routes/reindex.ts — `POST /api/reindex`(設計 §10-1 エンドポイント表 / §6-5 / §6-6 / §13-13)。
//
// 責務(薄いルート):
//   - リクエストボディ `{ full?: boolean, paths?: string[] }` の検証。
//   - `paths` は vault 相対 `knowledge/**` のみ許可(パストラバーサル拒否 → 400)。
//   - `full` → `core/search.buildIndex`(フル再構築)。
//   - `paths` あり → live handle に対し 1 件ずつ `applyDelta`(存在すれば change / 無ければ unlink)。
//   - `paths` なし(かつ `full` でない)→ `core/search.syncIndex`(mtime ベース全差分)。
//   - レスポンス `{ added, updated, removed, tookMs }`(§10-1 / `mcp/reindex-client.ts` の受け口と一致)。
//
// ロック方針(decision-log #49 / §6-3): `buildIndex` / `syncIndex` / `applyDelta` は内部で
// `withLock(projectRoot, 'index')` を取得する。`'index'` ロックは入れ子取得しない規約のため、
// **このルートでは withLock で二重に囲わない**。
//
// 認証・共通ヘッダ・エラーハンドラは `server/app.ts` の責務(このモジュールはルート定義のみ)。
//
// 規約: ESM / NodeNext / strict / verbatimModuleSyntax / noUncheckedIndexedAccess。

import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { vaultPaths } from '../../core/paths.js';
import {
  applyDelta as coreApplyDelta,
  buildIndex as coreBuildIndex,
  syncIndex as coreSyncIndex,
  type IndexHandle,
} from '../../core/search.js';

/** watcher / core と揃えた単発イベント種別。 */
type DeltaEventType = 'add' | 'change' | 'unlink';

/** `createReindexRoutes` の依存(結線タスク / boot.ts が用意する)。 */
export interface ReindexRoutesDeps {
  /** projectRoot 絶対パス。 */
  projectRoot: string;
  /** サーバーが保持するライブインデックスハンドルを返す(差分更新の適用対象)。 */
  getIndex: () => Promise<IndexHandle>;
  /** 既定 `core/search.buildIndex`。テストで差し替え。 */
  buildIndex?: (projectRoot: string) => Promise<IndexHandle>;
  /** 既定 `core/search.syncIndex`。テストで差し替え。 */
  syncIndex?: (h: IndexHandle) => Promise<{ added: number; updated: number; removed: number }>;
  /** 既定 `core/search.applyDelta`。テストで差し替え。 */
  applyDelta?: (h: IndexHandle, ev: { type: DeltaEventType; relPath: string }) => Promise<void>;
  /**
   * `full` 再構築後、`buildIndex` が返す新ハンドルを受け取る任意フック。
   * boot 側でライブハンドルを差し替えるために結線する(未結線なら次回起動 / `mnemo reindex` で反映)。
   */
  onRebuilt?: (h: IndexHandle) => void;
}

/** §10-1「`POST /api/reindex`」レスポンス。 */
export interface ReindexResponse {
  added: number;
  updated: number;
  removed: number;
  tookMs: number;
}

interface PathsOk {
  ok: true;
  paths: string[];
}
interface PathsErr {
  ok: false;
  message: string;
}

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

/**
 * `paths` を検証して正規化する(§10-1 バリデーション:「vault 相対 `knowledge/**` のみ許可」)。
 *
 * - 配列でない / 要素が非文字列 / 空文字列 → エラー。
 * - NUL バイト・絶対パス(POSIX / Windows ドライブ)→ エラー。
 * - `path.posix.normalize` 後に `..` が残る → エラー。
 * - 正規化後が `knowledge` 配下でない → エラー。
 * - 1 件でも違反したら全体を拒否する。
 */
export function validateReindexPaths(input: unknown): PathsOk | PathsErr {
  if (!Array.isArray(input)) {
    return { ok: false, message: 'paths は文字列配列である必要があります。' };
  }
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || raw === '') {
      return { ok: false, message: 'paths の要素は空でない文字列である必要があります。' };
    }
    if (raw.includes('\0')) {
      return { ok: false, message: `不正なパスです: ${raw}` };
    }
    const slashed = raw.replace(/\\/g, '/');
    if (slashed.startsWith('/') || WINDOWS_DRIVE_RE.test(slashed)) {
      return { ok: false, message: `絶対パスは指定できません: ${raw}` };
    }
    const norm = path.posix.normalize(slashed);
    if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) {
      return { ok: false, message: `パストラバーサルは許可されません: ${raw}` };
    }
    if (norm !== 'knowledge' && !norm.startsWith('knowledge/')) {
      return { ok: false, message: `knowledge/ 配下のパスのみ指定できます: ${raw}` };
    }
    out.push(norm);
  }
  return { ok: true, paths: out };
}

function errorBody(code: string, message: string, details: Record<string, unknown> = {}): {
  error: { code: string; message: string; details: Record<string, unknown> };
} {
  return { error: { code, message, details } };
}

/**
 * `POST /reindex` サブアプリを生成する。結線側は `/api` 直下にマウントする
 * (`api.route('/', createReindexRoutes(deps))` → `POST /api/reindex`)。
 */
export function createReindexRoutes(deps: ReindexRoutesDeps): Hono {
  const r = new Hono();
  const buildIndex = deps.buildIndex ?? coreBuildIndex;
  const syncIndex = deps.syncIndex ?? coreSyncIndex;
  const applyDelta = deps.applyDelta ?? coreApplyDelta;
  const vaultRoot = vaultPaths(deps.projectRoot).root;

  r.post('/reindex', async (c) => {
    const started = Date.now();

    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const b: Record<string, unknown> =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

    const full = b['full'] === true;

    let paths: string[] | undefined;
    if (b['paths'] !== undefined) {
      const v = validateReindexPaths(b['paths']);
      if (!v.ok) {
        return c.json(errorBody('INVALID_PATH', v.message, {}), 400);
      }
      paths = v.paths;
    }

    // --- full: フル再構築 ---
    if (full) {
      const handle = await buildIndex(deps.projectRoot);
      deps.onRebuilt?.(handle);
      const res: ReindexResponse = {
        added: handle.meta.docCount,
        updated: 0,
        removed: 0,
        tookMs: Date.now() - started,
      };
      return c.json(res);
    }

    const handle = await deps.getIndex();

    // --- paths 指定: 指定分だけ差分適用 ---
    if (paths !== undefined && paths.length > 0) {
      let added = 0;
      let updated = 0;
      let removed = 0;
      for (const rel of paths) {
        const existed = handle.meta.docs[rel] !== undefined;
        let type: DeltaEventType = 'unlink';
        try {
          await fs.promises.stat(path.join(vaultRoot, rel));
          type = 'change';
        } catch {
          type = 'unlink';
        }
        await applyDelta(handle, { type, relPath: rel });
        const present = handle.meta.docs[rel] !== undefined;
        if (!existed && present) added += 1;
        else if (existed && present) updated += 1;
        else if (existed && !present) removed += 1;
      }
      const res: ReindexResponse = { added, updated, removed, tookMs: Date.now() - started };
      return c.json(res);
    }

    // --- paths なし: 全差分 ---
    const delta = await syncIndex(handle);
    const res: ReindexResponse = { ...delta, tookMs: Date.now() - started };
    return c.json(res);
  });

  return r;
}

export default createReindexRoutes;
