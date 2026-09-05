// src/server/watcher.ts — chokidar 4 による vault 監視 → デバウンス → applyDelta → SSE 通知
// (設計 §6-5 / §10-1 / §13-13a / 付録 A「chokidar 4」/ 付録 C V-8)。
//
// chokidar 4 前提(付録 A・裏取り確定):
//   - v4 は glob パターンを一切受け付けない。`ignored` は RegExp または
//     `(path, stats?) => boolean` 関数のみ。ここでは関数フィルタで `.md` と隠し要素を選別する
//     (`watch()` に glob 文字列は渡さない)。
//   - v4 は `fsevents` をバンドルから除去 = 全 OS で純 `node:fs` の `fs.watch` ベース。
//   - ネットワーク FS / 高レイテンシ環境では `usePolling: true` + `interval: 1000` に切替
//     (`isNetworkFs` 判定。§12-2)。
//
// 責務境界(§6-5): watcher は「イベント発火」までを担う。SSE の実配信(stream・ハートビート)は
// `routes/events.ts` の責務。watcher は `onIndexUpdated(cb)` でコールバックを公開する。

import path from 'node:path';
import type { Stats } from 'node:fs';
import chokidarDefault from 'chokidar';
import type { ChokidarOptions, FSWatcher } from 'chokidar';
import { noteRelPath } from '../core/note.js';
import { vaultPaths } from '../core/paths.js';
import { applyDelta as coreApplyDelta, type IndexHandle } from '../core/search.js';
import { isNetworkFs as defaultIsNetworkFs } from '../core/vault-check.js';

/** watcher が扱う単発イベント種別(§6-5: add/change/unlink のみ。addDir/unlinkDir は無視)。 */
export type WatchEventType = 'add' | 'change' | 'unlink';

/** `onIndexUpdated` コールバックに渡すペイロード。 */
export interface IndexUpdatedPayload {
  type: 'index-updated';
  /** このバッチで `applyDelta` を適用した relPath の件数。 */
  changed: number;
}

/** `chokidar` の最小サブセット(注入用)。 */
export interface ChokidarLike {
  watch(paths: string | string[], options?: ChokidarOptions): FSWatcher;
}

/** `createWatcher` の依存注入ポイント(テストで実ファイル監視・実コマンドを避けるため)。 */
export interface WatcherDeps {
  /** インメモリインデックスハンドル。`applyDelta` の適用対象。 */
  handle: IndexHandle;
  /** 既定 `chokidar`。テストではフェイクの `watch` を渡す。 */
  chokidar?: ChokidarLike;
  /** 既定 `core/vault-check.isNetworkFs`。 */
  isNetworkFs?: (p: string) => boolean;
  /** 既定 `core/search.applyDelta`(handle にバインドして呼ぶ)。 */
  applyDelta?: (ev: { type: WatchEventType; relPath: string }) => Promise<void>;
  /** デバウンス時間(ms)。既定 500(§6-5)。 */
  debounceMs?: number;
  /** ログ出力。既定 `console.error`。 */
  logger?: (msg: string, err?: unknown) => void;
}

/** `createWatcher` の戻り値。 */
export interface Watcher {
  /** インデックス更新後に呼ばれるコールバックを登録する。戻り値で解除。 */
  onIndexUpdated(cb: (payload: IndexUpdatedPayload) => void): () => void;
  /**
   * watcher が縮退し監視が停止しているか(§6-5 / §10-1
   * `/api/health/issues.watcherDown`)。error からの 1 回再起動も失敗した場合 true。
   */
  isDown(): boolean;
  /** 現在ポーリングモードか(§13-13a の検証用)。 */
  isPolling(): boolean;
  /** 監視を停止する。 */
  close(): Promise<void>;
}

const AWAIT_WRITE_FINISH = { stabilityThreshold: 400, pollInterval: 100 } as const;
const POLL_INTERVAL_MS = 1000;
const DEFAULT_DEBOUNCE_MS = 500;

/**
 * chokidar 4 の関数フィルタ(§6-5)。true を返したものは監視しない。
 *
 * - ドットファイル / ドットディレクトリ(`.obsidian/` 等)は常に除外
 *   → ディレクトリが除外されれば chokidar はその配下へ降りないので配下も監視されない。
 * - `stats` ありでファイルなら拡張子 `.md` のものだけ通す(`.txt` / `.png` は弾く)。
 * - `stats` なしで「拡張子付きだが `.md` でない」パスは弾く。
 * - サブディレクトリ(`knowledge/<cat>/`)や `stats` なしの拡張子なしパスは通す。
 */
export function makeIgnored(): (p: string, stats?: Stats) => boolean {
  return (p: string, stats?: Stats): boolean => {
    const base = path.basename(p);
    if (base.startsWith('.')) return true;
    if (stats?.isFile() && !base.toLowerCase().endsWith('.md')) return true;
    if (!stats && /\.[^/\\.]+$/.test(base) && !base.toLowerCase().endsWith('.md')) return true;
    return false;
  };
}

/**
 * vault 監視 watcher を生成する(§6-5)。
 *
 * `chokidar.watch()` の初期化が throw した場合や、`error` イベント後の 1 回再起動も失敗した
 * 場合は `isDown()` が true になるが、この関数自体は throw しない(HTTP サーバー本体は落とさない)。
 */
export function createWatcher(projectRoot: string, deps: WatcherDeps): Watcher {
  const { knowledgeDir, root: vaultRoot } = vaultPaths(projectRoot);
  const chokidar = deps.chokidar ?? (chokidarDefault as unknown as ChokidarLike);
  const isNetworkFs = deps.isNetworkFs ?? ((p: string) => defaultIsNetworkFs(p));
  const applyDelta =
    deps.applyDelta ?? ((ev: { type: WatchEventType; relPath: string }) => coreApplyDelta(deps.handle, ev));
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  // eslint-disable-next-line no-console
  const logger = deps.logger ?? ((msg: string, err?: unknown) => console.error(`[mnemo:watcher] ${msg}`, err ?? ''));
  const ignored = makeIgnored();

  const listeners = new Set<(payload: IndexUpdatedPayload) => void>();
  /** relPath → 最新イベント種別(同一ファイルの連続イベントは最後だけ残す)。 */
  const pending = new Map<string, WatchEventType>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  let current: FSWatcher | null = null;
  let polling = false;
  let restartAttempted = false;
  let down = false;
  let closed = false;

  function markDown(): void {
    down = true;
    current = null;
    logger('ファイル監視が停止しました(手動リロードが必要です)。');
  }

  function flush(): void {
    timer = null;
    const batch = [...pending.entries()];
    pending.clear();
    if (batch.length === 0) return;
    void (async () => {
      let changed = 0;
      for (const [relPath, type] of batch) {
        try {
          await applyDelta({ type, relPath });
          changed += 1;
        } catch (err) {
          logger(`applyDelta に失敗しました(${relPath})`, err);
        }
      }
      const payload: IndexUpdatedPayload = { type: 'index-updated', changed };
      for (const cb of listeners) {
        try {
          cb(payload);
        } catch (err) {
          logger('onIndexUpdated コールバックが例外を投げました', err);
        }
      }
    })();
  }

  function enqueue(type: WatchEventType, absPath: string): void {
    if (closed || down) return;
    const relPath = noteRelPath(projectRoot, absPath);
    // ignored 関数で弾いているが二重に確認(§6-5)。
    if (!relPath.toLowerCase().endsWith('.md')) return;
    pending.set(relPath, type);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  function handleError(err: unknown): void {
    logger('chokidar error イベントを受信しました', err);
    if (restartAttempted) {
      markDown();
      return;
    }
    restartAttempted = true;
    void (async () => {
      try {
        await current?.close();
      } catch (closeErr) {
        logger('既存 watcher の close に失敗しました', closeErr);
      }
      // usePolling: true で 1 回だけ再起動を試みる(§6-5)。
      const next = spawn(true);
      if (next === null) {
        markDown();
        return;
      }
      current = next;
      polling = true;
    })();
  }

  /** chokidar.watch() を試みる。初期化 throw 時は null を返す(§6-5)。 */
  function spawn(usePolling: boolean): FSWatcher | null {
    let w: FSWatcher;
    try {
      // ★ paths は監視対象ディレクトリの絶対パスそのもの。glob 文字列は渡さない(v4 で無効)。
      w = chokidar.watch(knowledgeDir, {
        ignored,
        ignoreInitial: true,
        awaitWriteFinish: { ...AWAIT_WRITE_FINISH },
        usePolling,
        interval: POLL_INTERVAL_MS,
      });
    } catch (err) {
      logger('chokidar.watch() の初期化に失敗しました', err);
      return null;
    }
    // add/change/unlink のみ購読する。addDir/unlinkDir は購読しない = 無視(§6-5)。
    w.on('add', (p: string) => enqueue('add', p));
    w.on('change', (p: string) => enqueue('change', p));
    w.on('unlink', (p: string) => enqueue('unlink', p));
    w.on('error', (err: unknown) => handleError(err));
    return w;
  }

  // --- 起動 ---
  polling = isNetworkFs(vaultRoot);
  const initial = spawn(polling);
  if (initial === null) {
    markDown();
  } else {
    current = initial;
  }

  return {
    onIndexUpdated(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isDown() {
      return down;
    },
    isPolling() {
      return polling;
    },
    async close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
      const w = current;
      current = null;
      if (w) {
        try {
          await w.close();
        } catch (err) {
          logger('watcher の close に失敗しました', err);
        }
      }
    },
  };
}
