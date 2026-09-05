// src/core/lock.ts — プロセス間ロックの単一の入口(設計書 §8-G / §12-3)。
//
// ロックディレクトリはランタイム領域(`<runtimeBase>/mnemotheca/<projectHash>/locks/`)に置く。
// projectRoot 配下・vault 配下には `.lock` を一切生成しない(git 管理下を汚さないため。§12-3)。
// `proper-lockfile` の `mkdir` 戦略 + stale 検出により、同期される可能性のある FS でも安全。
// 依存は node 標準 + `proper-lockfile` のみ(設計 §1-3 / §4-2)。

import fs from 'node:fs';
import path from 'node:path';
import { lock as acquire } from 'proper-lockfile';
import { MnemoError } from './errors.js';
import { ensureRuntimeDir, runtimePaths } from './paths.js';

/**
 * ロックのスコープ(設計 §8-G)。呼び出し側は最上位を 1 つだけ取る(入れ子禁止)。
 * - `vault`      … organize のカテゴリ横断変更・カテゴリリネーム(最上位)
 * - `knowledge`  … store の複数ファイル一括生成
 * - `category:X` … 単一カテゴリ内で完結する organize 変更(粒度を上げて並行性を確保)
 * - `usage-log`  … `appendUsage` 専用(短時間)
 * - `run`        … `mnemo_show` / `mnemo start` の起動処理(多重起動防止)
 * - `index`      … インデックスファイル書き込み(§6-3)
 */
export type LockScope = 'vault' | 'knowledge' | `category:${string}` | 'usage-log' | 'run' | 'index';

/** `withLock` のオプション(設計 §8-G)。 */
export interface WithLockOptions {
  /** 取得リトライ回数。既定 10(factor 1.5 / minTimeout 100ms / maxTimeout 3000ms、最大 ~15s)。 */
  retries?: number;
  /** stale ロックを奪取するまでの無応答時間(ms)。既定 20000。`proper-lockfile` の下限は 2000。 */
  staleMs?: number;
}

const DEFAULT_RETRIES = 10;
const DEFAULT_STALE_MS = 20_000;

/**
 * `LockScope` をファイル名に無害化する。`:` `/` `\` はファイル名に使えない/パス区切りになるため
 * すべて `__` に置換し、想定外の文字も同様に畳む(設計 §8-G: `category:a/b` → `category__a__b`)。
 */
export function scopeToFilename(scope: LockScope): string {
  return scope.replace(/[^a-zA-Z0-9_.-]+/g, '__');
}

/**
 * `proper-lockfile` に渡すロック対象パス(実ロックはこの `${path}.lock` に mkdir で作られる)。
 * ランタイムディレクトリ(0700)と `locks/` を用意したうえで対象ファイルを touch する。
 * `MNEMO_RUNTIME_DIR` が書き込み不可なら `ensureRuntimeDir` が投げる
 * `MnemoError('RUNTIME_DIR_UNWRITABLE')` をそのまま伝播する(設計 §8-G)。
 */
export async function lockfileTarget(projectRoot: string, scope: LockScope): Promise<string> {
  await ensureRuntimeDir(projectRoot); // RUNTIME_DIR_UNWRITABLE をそのまま伝播
  const { locksDir } = runtimePaths(projectRoot);
  await fs.promises.mkdir(locksDir, { recursive: true, mode: 0o700 });
  const target = path.join(locksDir, scopeToFilename(scope));
  await fs.promises.writeFile(target, '', { flag: 'a' }); // 無ければ touch(既存は変更しない)
  return target;
}

/**
 * `scope` のロックを取得して `fn` を実行し、`finally` で必ず解放する(設計 §8-G)。
 *
 * - 取得失敗(retries 使い切り)→ `MnemoError('LOCK_TIMEOUT', { scope })`
 * - ランタイム領域が書き込み不可 → `MnemoError('RUNTIME_DIR_UNWRITABLE')` をそのまま伝播
 * - stale ロック(mtime が `staleMs` より古い)は自動で奪取する
 * - ロックの入れ子は禁止。呼び出し側が最上位を 1 つだけ取ること。
 */
export async function withLock<T>(
  projectRoot: string,
  scope: LockScope,
  fn: () => Promise<T>,
  opts?: WithLockOptions,
): Promise<T> {
  const target = await lockfileTarget(projectRoot, scope);

  let release: () => Promise<void>;
  try {
    release = await acquire(target, {
      realpath: false,
      retries: {
        retries: opts?.retries ?? DEFAULT_RETRIES,
        factor: 1.5,
        minTimeout: 100,
        maxTimeout: 3000,
      },
      stale: opts?.staleMs ?? DEFAULT_STALE_MS,
    });
  } catch (err) {
    throw new MnemoError('LOCK_TIMEOUT', `ロック \`${scope}\` を取得できませんでした`, {
      scope,
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    return await fn();
  } finally {
    await release();
  }
}
