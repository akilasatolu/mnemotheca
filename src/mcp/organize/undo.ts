// src/mcp/organize/undo.ts — organize undo フェーズの本体(設計書 §8-N undo / §10-5 step4-5 / §12-10)。
//
// 「直近(または指定した)スナップショットを vault へ復元し、categories 再生成 + 全再インデックス、
//  そしてクラッシュ復帰の後始末(step4)を行う」ことに責務を限定する。
//
// step4(無限ループ解消の要): restore した snapshot が `organize-session.json`(`applying:true`)の
// `snapshotId` と一致したら、その session ファイルを削除する。これが「未完了 organize の正規の
// 復帰手段 = mnemo_organize_undo({ snapshot: pendingRecovery.snapshotId })」を閉じる唯一の手段。
// 通常 undo(apply 成功時に session は既に削除済み / 別 sessionId の session)は session を触らない。

import fs from 'node:fs';

import { regenerateCategories } from '../../core/categories-index.js';
import { MnemoError } from '../../core/errors.js';
import { withLock } from '../../core/lock.js';
import { mnemothecaPaths } from '../../core/paths.js';
import { listSnapshots, restoreSnapshot } from '../../core/snapshot.js';
import { appendUsage } from '../../core/usage-log.js';
import { reindexPaths } from '../reindex-client.js';
import { readSession } from './session.js';

/** `organizeUndo` の結果(設計書 §8-N undo `OrganizeUndoResult`)。 */
export interface OrganizeUndoResult {
  /** 復元を実行したか(スナップショットが存在し restore が完了したら true)。 */
  restored: boolean;
  /** 復元した snapshot ID。 */
  snapshot: string;
  /** 復元したファイル数(`SnapshotInfo.fileCount` = `files[]` + `created[]`)。 */
  fileCount: number;
  /** step4 で `organize-session.json`(applying:true・snapshotId 一致)を削除したか。 */
  sessionCleared: boolean;
  /** 全再インデックスがファイル直更新に降格したか(呼び出し側が 1 行付記)。 */
  reindexFellBack: boolean;
}

export interface OrganizeUndoOptions {
  /** 省略時は `listSnapshots` の先頭(= `createdAt` 最新)。 */
  snapshot?: string;
  /** usage ログの `ts`(テスト用に注入可能。既定 `Date.now()`)。 */
  now?: number;
}

/**
 * organize undo 本体(設計書 §8-N undo)。
 *
 * 1. snapshot 未指定なら直近を選ぶ(無ければ `SNAPSHOT_FAILED`)。
 * 2. `withLock(projectRoot, 'vault')` 内で `restoreSnapshot`。
 * 3. `regenerateCategories` → 全再インデックス(失敗は成功扱い + 付記)。
 * 4. クラッシュ復帰の後始末: `organize-session.json` が `applying:true` かつ
 *    `snapshotId === (復元した snapshot)` なら session ファイルを削除。
 * 5. `appendUsage({ event: 'organize.undo' })`。
 */
export async function organizeUndo(
  projectRoot: string,
  options: OrganizeUndoOptions = {},
): Promise<OrganizeUndoResult> {
  const now = options.now ?? Date.now();

  // step1: 復元対象の snapshot を決める。
  let snapshotId = options.snapshot;
  if (snapshotId === undefined || snapshotId === '') {
    const snaps = await listSnapshots(projectRoot);
    const latest = snaps[0];
    if (latest === undefined) {
      throw new MnemoError('SNAPSHOT_FAILED', '復元できるスナップショットがありません', {
        snapshotDir: mnemothecaPaths(projectRoot).snapshotsDir,
      });
    }
    snapshotId = latest.id;
  }
  const restoredId = snapshotId;

  // step2: vault ロック内で復元(restoreSnapshot は冪等。設計書 §8-H)。
  await withLock(projectRoot, 'vault', async () => {
    await restoreSnapshot(projectRoot, restoredId);
  });

  // 復元ファイル数(SnapshotInfo.fileCount = files[] + created[])。
  const infos = await listSnapshots(projectRoot);
  const fileCount = infos.find((s) => s.id === restoredId)?.fileCount ?? 0;

  // step3: categories 再生成 → 全再インデックス(失敗は保存成功扱い + 付記。設計書 §8-N / decision-log #48/#51)。
  await regenerateCategories(projectRoot);
  let reindexFellBack = false;
  try {
    const r = await reindexPaths(projectRoot, undefined, { full: true });
    reindexFellBack = r.serverFellBack;
  } catch {
    reindexFellBack = true;
  }

  // step4: クラッシュ復帰の後始末(§10-5 step4 / §12-10)。
  //   applying:true かつ snapshotId 一致 → この session ファイルを削除(無限ループを閉じる)。
  //   通常 undo(session 無し / applying:false / 別 sessionId・別 snapshotId)は触らない。
  let sessionCleared = false;
  const { session } = await readSession(projectRoot);
  if (session !== null && session.applying === true && session.snapshotId === restoredId) {
    const sessionFile = mnemothecaPaths(projectRoot).organizeSessionJson;
    await fs.promises.rm(sessionFile, { force: true }).catch(() => {
      /* 削除失敗は致命的でない(次回 scan が再度 pendingRecovery を返すだけ) */
    });
    sessionCleared = true;
  }

  // step5: usage 追記(失敗は握りつぶされる)。
  await appendUsage(projectRoot, {
    ts: new Date(now).toISOString(),
    mode: 'organize',
    event: 'organize.undo',
    ok: true,
    snapshot: restoredId,
  });

  return { restored: true, snapshot: restoredId, fileCount, sessionCleared, reindexFellBack };
}

/** undo の戻り値 text(設計書 §8-N。format.ts は touches 外のため undo 専用整形をここに置く)。 */
export function formatOrganizeUndoResult(result: OrganizeUndoResult): string {
  const lines: string[] = [];
  lines.push(
    `スナップショット ${result.snapshot} を復元しました(${result.fileCount} ファイル)。`,
  );
  if (result.sessionCleared) {
    lines.push('中断していた整理セッションを解消しました。以後の mnemo_organize_scan は通常提案を返します。');
  }
  if (result.reindexFellBack) {
    lines.push('(検索インデックスはファイル直更新で反映しました。)');
  }
  return lines.join('\n');
}
