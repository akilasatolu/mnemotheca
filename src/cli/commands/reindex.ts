// src/cli/commands/reindex.ts — `mnemo reindex [--full] [--no-categories]`(設計書 §6-6 / §9-1 / §13-14)。
//
// 役割:
//   - `--full`  : インデックスキャッシュ(`search-index.json` / `meta.json`)を削除してから
//                 `buildIndex` 全再構築。無印は `syncIndex` 差分。
//   - 稼働中の HTTP サーバーがあれば `mcp/reindex-client` の `reindexPaths` 経由で
//     `POST /api/reindex`(`full` フラグを渡す)、無ければ core を直接実行する。
//     この「サーバー経由 → ダメならファイル直更新」の分岐は `reindexPaths` に集約されている。
//     `reindexPaths` の直更新パスは内部で `buildIndex` / `syncIndex` が `withLock('index')` を
//     取るため、ここから追加でロックを取らない(§6-3「'index' ロックは入れ子取得しない」)。
//   - `--no-categories` を付けない限り、最後に `regenerateCategories(projectRoot)` を実行する。
//   - 結果を人間向け or `--json` で表示し、`usage_log` に 1 レコード(`mode:'reindex'`)を残す。

import fs from 'node:fs';

import { mnemothecaPaths } from '../../core/paths.js';
import { regenerateCategories, type RegenerateCategoriesResult } from '../../core/categories-index.js';
import { appendUsage } from '../../core/usage-log.js';
import { reindexPaths, type ReindexResult } from '../../mcp/reindex-client.js';
import type { CliCommandContext } from '../index.js';
import * as ui from '../ui.js';

/** `--json` 出力の形。 */
interface ReindexJson {
  ok: true;
  full: boolean;
  /** `'server'` = サーバーのインメモリインデックスも更新 / `'direct'` = ファイル直更新。 */
  via: 'server' | 'direct';
  /** サーバーは稼働していたが API 呼び出しに失敗しファイル直更新に切り替えた(§12-11)。 */
  serverFellBack: boolean;
  added: number;
  updated: number;
  removed: number;
  tookMs: number;
  /** `--no-categories` 指定時は null。 */
  categories: RegenerateCategoriesResult | null;
}

/** `--full` 時にインデックスキャッシュを削除する(設計 §6-6)。存在しなくてもエラーにしない。 */
async function clearIndexCache(projectRoot: string): Promise<void> {
  const paths = mnemothecaPaths(projectRoot);
  await Promise.all([
    fs.promises.rm(paths.searchIndexJson, { force: true }),
    fs.promises.rm(paths.metaJson, { force: true }),
  ]);
}

export async function run(ctx: CliCommandContext): Promise<void> {
  // reindex は `NEEDS_PROJECT`(cli/index.ts)なので projectRoot は解決済み。
  const projectRoot = ctx.projectRoot;
  if (projectRoot === undefined) {
    // 実運用では到達しない(未解決なら preAction で NOT_INITIALIZED が投げられる)。
    throw new Error('projectRoot が解決されていません');
  }

  const full = ctx.options['full'] === true;
  // commander の `--no-categories` は options.categories を false にする(既定 true)。
  const withCategories = ctx.options['categories'] !== false;
  const { json, quiet } = ctx.global;

  if (full) {
    await clearIndexCache(projectRoot);
  }

  const result: ReindexResult = await reindexPaths(projectRoot, undefined, { full });

  let categories: RegenerateCategoriesResult | null = null;
  if (withCategories) {
    categories = await regenerateCategories(projectRoot);
  }

  const delta = result.added + result.updated + result.removed;
  await appendUsage(projectRoot, {
    ts: new Date().toISOString(),
    mode: 'reindex',
    event: 'reindex',
    ok: true,
    count: delta,
    durationMs: result.tookMs,
  });

  if (json) {
    const payload: ReindexJson = {
      ok: true,
      full,
      via: result.via,
      serverFellBack: result.serverFellBack,
      added: result.added,
      updated: result.updated,
      removed: result.removed,
      tookMs: result.tookMs,
      categories,
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (quiet) {
    return;
  }

  const mode = full ? '全再構築' : '差分更新';
  const via = result.via === 'server' ? 'サーバー経由' : 'ファイル直更新';
  const lines: string[] = [
    ui.success(`再インデックス完了(${mode})`),
    `  追加 ${result.added} / 更新 ${result.updated} / 削除 ${result.removed}`,
    ui.dim(`  所要 ${result.tookMs}ms / 経路: ${via}`),
  ];
  if (categories !== null) {
    lines.push(ui.dim(`  カテゴリ一覧: ${categories.written} 生成 / ${categories.removed} 削除`));
  } else {
    lines.push(ui.dim('  カテゴリ一覧: スキップ(--no-categories)'));
  }
  if (result.serverFellBack) {
    lines.push(
      ui.warn(
        '  サーバーのインメモリインデックス更新に失敗したためファイルを直接更新しました。' +
          'サーバー側は再起動時、または次回の `mnemo reindex` で反映されます。',
      ),
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
