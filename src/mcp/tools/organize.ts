// src/mcp/tools/organize.ts — `mnemo_organize_scan`(設計書 §8-N の 4 tool 分割のうち scan)。
//
// preview / apply / undo(設計書 §8-N の残りフェーズ)は同ファイル内の下部に、
// それぞれ別の named export(`organizePreviewModule` / `organizeApplyModule` /
// `organizeUndoModule`)として実装されている。

import { z } from 'zod';

import fs from 'node:fs';

import { regenerateCategories } from '../../core/categories-index.js';
import { MnemoError } from '../../core/errors.js';
import { withLock } from '../../core/lock.js';
import { listNotes, readNote } from '../../core/note.js';
import { mnemothecaPaths } from '../../core/paths.js';
import {
  createSnapshot,
  finalizeSnapshotManifest,
  gcSnapshots,
  restoreSnapshot,
  SNAPSHOT_KEEP,
} from '../../core/snapshot.js';
import { appendUsage } from '../../core/usage-log.js';
import { checkVault } from '../../core/vault-check.js';
import { formatOrganizeApplyResult, formatOrganizePreview } from '../format.js';
import { affectedRelPaths, decideLockScope, executeFileOps } from '../organize/apply.js';
import {
  buildPreview,
  previewCategoryKey,
  type FileOp,
  type PreviewNote,
} from '../organize/preview.js';
import { scanVault } from '../organize/scan.js';
import { isSessionExpired, readSession, writeSession } from '../organize/session.js';
import { formatOrganizeUndoResult, organizeUndo } from '../organize/undo.js';
import { reindexPaths } from '../reindex-client.js';
import type { CallToolResult, ToolModule } from './types.js';

const ORGANIZE_DESCRIPTION =
  '過去に保存済みのナレッジファイル群全体を dry-run で走査し、再構成の変更提案を返す' +
  '(今の会話を保存するのは mnemo_store)。カテゴリ階層の見直し(サブディレクトリ化 / 統合候補)、' +
  '内容が近いファイル・重複の検出、_uncategorized の振り分け候補、陳腐化ノートの発見を行う。' +
  'この tool 自体はファイルを一切変更しない。返した提案を個別にユーザーへ提示し、' +
  '承認されたものだけを後続の適用フェーズへ渡すこと(削除・統合は一括承認させない)。';

/** scan(dry-run)の入力。`apply:true`(実適用)は後続の適用 tool の責務(設計書 §8-N)。 */
const scanInputSchema = z.object({
  apply: z
    .literal(false)
    .default(false)
    .describe('この tool は dry-run 専用。実際の適用は organize の適用フェーズ(設計書 §8-N)で行う'),
  scope: z.enum(['all', 'category']).default('all'),
  category: z
    .string()
    .optional()
    .describe('scope:"category" のとき対象にする categories[0] 値'),
  discardPendingRecovery: z
    .boolean()
    .default(false)
    .describe(
      '前回中断した organize の復元を諦め、applying:true の organize-session.json を ' +
        'applying:false に落として通常スキャンに進む。復元したい場合はこれを付けず ' +
        'mnemo_organize_undo({ snapshot: pendingRecovery.snapshotId }) を先に呼ぶこと',
    ),
});

/** `checkVault` の NG 理由を `MnemoError` コードへ(設計書 §12-2)。 */
function vaultError(reason: string | undefined): MnemoError {
  const code = reason === 'vault-not-writable' ? 'VAULT_NOT_WRITABLE' : 'VAULT_UNAVAILABLE';
  return new MnemoError(code, undefined, { reason });
}

/**
 * `mnemo_organize_scan`(scan / dry-run)。vault 健全性チェック → `scanVault` → 提案リストの text 整形。
 * 例外(`MnemoError`)は `withToolErrorBoundary`(mcp/server.ts)が拾って整形する。
 */
export const organizeScanModule: ToolModule = {
  name: 'mnemo_organize_scan',
  config: {
    title: 'ナレッジベースの再構成提案(dry-run)',
    description: ORGANIZE_DESCRIPTION,
    inputSchema: scanInputSchema,
  },
  handler: async (args: z.infer<typeof scanInputSchema>, ctx): Promise<CallToolResult> => {
    const vault = await checkVault(ctx.projectRoot);
    if (!vault.ok) throw vaultError(vault.reason);

    const onlyCategory = args.scope === 'category' ? args.category : undefined;
    const preview = await scanVault(ctx.projectRoot, {
      onlyCategory,
      discardPendingRecovery: args.discardPendingRecovery,
    });

    if (preview.pendingRecovery !== null) {
      const { snapshotId, since } = preview.pendingRecovery;
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `前回の整理(organize apply)が中断されたままです` +
              `(snapshot ${snapshotId}、${since})。スキャンは実行していません。\n` +
              `元に戻すには mnemo_organize_undo({ snapshot: "${snapshotId}" }) を実行してください。\n` +
              `中断状態を受け入れて先へ進む場合は discardPendingRecovery:true を付けて再実行してください。`,
          },
        ],
        structuredContent: {
          sessionId: preview.sessionId,
          pendingRecovery: preview.pendingRecovery,
          scannedAt: preview.scannedAt,
          heuristicsVersion: preview.heuristicsVersion,
          noteCount: preview.noteCount,
          proposals: [],
          parseErrors: [],
        },
      };
    }

    const diffs = preview.proposals.map((p) => ({
      proposalId: p.proposalId,
      kind: p.kind,
      before: p.before,
      after: p.after,
      fileOps: [],
    }));

    const header =
      preview.proposals.length === 0
        ? `整理提案は見つかりませんでした(対象 ${preview.noteCount} 件、ヒューリスティクス v${preview.heuristicsVersion})。`
        : `${preview.proposals.length} 件の整理提案が見つかりました` +
          `(対象 ${preview.noteCount} 件、ヒューリスティクス v${preview.heuristicsVersion})。`;

    const parts = [header];
    if (preview.proposals.length > 0) parts.push(formatOrganizePreview(diffs));
    if (preview.parseErrors.length > 0) {
      parts.push(
        `パースできず除外したノート ${preview.parseErrors.length} 件:\n` +
          preview.parseErrors.map((e) => `  - ${e.relPath}: ${e.message}`).join('\n'),
      );
    }

    return {
      content: [{ type: 'text' as const, text: parts.join('\n\n') }],
      structuredContent: {
        sessionId: preview.sessionId,
        pendingRecovery: null,
        scannedAt: preview.scannedAt,
        heuristicsVersion: preview.heuristicsVersion,
        noteCount: preview.noteCount,
        proposals: preview.proposals,
        parseErrors: preview.parseErrors,
      },
    };
  },
};

// ───────────────────────── preview(§8-N)─────────────────────────

/** preview の入力(設計書 §8-N)。`sessionId` で scan が保存したセッションを照合する。 */
const previewInputSchema = z.object({
  sessionId: z.string().describe('mnemo_organize_scan が返した sessionId'),
  proposalIds: z
    .array(z.string())
    .min(1)
    .describe('Before/After を確認したい proposalId(scan の proposals[].proposalId)。1 件以上'),
});

/**
 * `mnemo_organize_preview`(設計書 §8-N preview)。scan が確定した提案定義を
 * `organize-session.json` から読み、選択された proposalId を具体的な `FileOp[]` へ展開し、
 * 提案間の競合を(throw せず)`conflicts` / `combinedConflicts` に載せて返す。
 *
 * session 照合失敗 / `now > expiresAt` / `applying:true` → `MnemoError('ORGANIZE_SESSION_EXPIRED')`。
 * ファイルは一切変更しない(実適用は mnemo_organize_apply)。
 */
export const organizePreviewModule: ToolModule = {
  name: 'mnemo_organize_preview',
  config: {
    title: '整理提案の Before/After プレビュー',
    description:
      'mnemo_organize_scan が返した提案のうち指定したものについて、実行される具体的な' +
      'ファイル操作(移動・frontmatter 修正・統合・削除・ディレクトリ作成/削除)と' +
      '提案どうしの競合を提示する。この tool 自体はファイルを変更しない。',
    inputSchema: previewInputSchema,
  },
  handler: async (args: z.infer<typeof previewInputSchema>, ctx): Promise<CallToolResult> => {
    const vault = await checkVault(ctx.projectRoot);
    if (!vault.ok) throw vaultError(vault.reason);

    const now = Date.now();
    const { session } = await readSession(ctx.projectRoot);
    if (
      session === null ||
      session.sessionId !== args.sessionId ||
      session.applying ||
      isSessionExpired(session, now)
    ) {
      throw new MnemoError('ORGANIZE_SESSION_EXPIRED', undefined, {
        detail:
          session !== null && session.applying
            ? '前回の apply が未完了です。mnemo_organize_scan を呼び直し、pendingRecovery に従って ' +
              'mnemo_organize_undo で復元するか discardPendingRecovery で破棄してください'
            : undefined,
      });
    }

    const { notes } = await listNotes(ctx.projectRoot);
    const previewNotes = new Map<string, PreviewNote>();
    for (const note of notes) {
      let body = '';
      try {
        ({ body } = await readNote(note.absPath));
      } catch {
        /* 本文が読めないノートは body 空で続行(競合検出・写像には frontmatter で足りる) */
      }
      previewNotes.set(note.relPath, {
        relPath: note.relPath,
        category: previewCategoryKey(note.fm.categories),
        body,
        frontmatter: note.fm,
      });
    }

    const result = buildPreview(session.proposals, args.proposalIds, previewNotes);
    const text = formatOrganizePreview(result.diffs, result.combinedConflicts);

    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: {
        sessionId: session.sessionId,
        diffs: result.diffs,
        combinedConflicts: result.combinedConflicts,
      },
    };
  },
};

// ───────────────────────── apply(§8-N)─────────────────────────

/** apply の入力(設計書 §8-N)。`label` は `createSnapshot` の接頭辞になる。 */
const applyInputSchema = z.object({
  sessionId: z.string().describe('mnemo_organize_scan が返した sessionId'),
  proposalIds: z
    .array(z.string())
    .min(1)
    .describe('適用する proposalId(scan の proposals[].proposalId)。1 件以上'),
  label: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .default('organize')
    .describe('スナップショットのラベル(a-z0-9- のみ、1〜40 字)'),
  confirmedDestructive: z
    .array(z.string())
    .default([])
    .describe(
      'destructiveness が merge/delete の proposalId は、ここに個別に列挙されていないと拒否される',
    ),
});

/** 現在の vault を読んで preview 純関数用の `PreviewNote` マップを組み立てる(preview handler と同じ手順)。 */
async function loadPreviewNotes(projectRoot: string): Promise<Map<string, PreviewNote>> {
  const { notes } = await listNotes(projectRoot);
  const map = new Map<string, PreviewNote>();
  for (const note of notes) {
    let body = '';
    try {
      ({ body } = await readNote(note.absPath));
    } catch {
      /* 本文が読めないノートは body 空で続行 */
    }
    map.set(note.relPath, {
      relPath: note.relPath,
      category: previewCategoryKey(note.fm.categories),
      body,
      frontmatter: note.fm,
    });
  }
  return map;
}

/**
 * `mnemo_organize_apply`(設計書 §8-N apply)。
 *
 * scan が確定した提案定義を `organize-session.json` から読み、選択された proposalId を
 * `FileOp[]` へ展開し、スナップショットを取ってから順に適用する。途中失敗は
 * `restoreSnapshot` で全戻し。`applying:true` + `snapshotId` を FileOp 実行の直前に
 * `organize-session.json` へ書き、正常完了・ロールバック完了時にはファイルごと削除する
 * (クラッシュして `restoreSnapshot` すら走らなかった場合のみ `applying:true` が残る)。
 */
export const organizeApplyModule: ToolModule = {
  name: 'mnemo_organize_apply',
  config: {
    title: '整理提案の適用(スナップショット付き)',
    description:
      'mnemo_organize_preview で確認し、ユーザーが個別承認した提案を実際に適用する。' +
      '適用前に必ずスナップショットを取り、途中で失敗した場合は自動で全て元に戻す。' +
      '削除・統合の提案は confirmedDestructive にも proposalId を列挙しないと拒否される。' +
      '元に戻すには mnemo_organize_undo。',
    inputSchema: applyInputSchema,
  },
  handler: async (args: z.infer<typeof applyInputSchema>, ctx): Promise<CallToolResult> => {
    const vault = await checkVault(ctx.projectRoot);
    if (!vault.ok) throw vaultError(vault.reason);

    const now = Date.now();

    // step1: session ロード + 照合(readSession が JSON 破損を .corrupt-<ts> へ退避する)。
    const { session } = await readSession(ctx.projectRoot);
    if (session === null || session.sessionId !== args.sessionId || isSessionExpired(session, now)) {
      throw new MnemoError('ORGANIZE_SESSION_EXPIRED');
    }
    if (session.applying) {
      throw new MnemoError('ORGANIZE_SESSION_EXPIRED', undefined, {
        detail:
          '前回の apply が未完了です。mnemo_organize_scan を呼び直し、pendingRecovery に従って ' +
          'mnemo_organize_undo で復元するか discardPendingRecovery で破棄してください',
      });
    }

    // 既知の proposalId のみ対象にする(未知は無視。preview の非 throw 方針に合わせる)。
    const byId = new Map(session.proposals.map((p) => [p.proposalId, p]));
    const knownIds: string[] = [];
    const seen = new Set<string>();
    for (const id of args.proposalIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (byId.has(id)) knownIds.push(id);
    }
    if (knownIds.length === 0) {
      throw new MnemoError('PROPOSAL_CONFLICT', undefined, {
        conflicts: ['指定された proposalId はいずれもこのセッションに存在しません'],
      });
    }
    const selected = knownIds.map((id) => byId.get(id)!);

    // step2: 破壊的提案の個別承認チェック(merge / delete)。
    const confirmed = new Set(args.confirmedDestructive);
    for (const p of selected) {
      if ((p.destructiveness === 'merge' || p.destructiveness === 'delete') && !confirmed.has(p.proposalId)) {
        throw new MnemoError('DESTRUCTIVE_NOT_CONFIRMED', undefined, { proposalId: p.proposalId });
      }
    }

    // step3: FileOp 展開 + 提案間矛盾チェック(preview と同じ関数)。
    const previewNotes = await loadPreviewNotes(ctx.projectRoot);
    const preview = buildPreview(session.proposals, knownIds, previewNotes);
    if (preview.combinedConflicts.length > 0) {
      throw new MnemoError('PROPOSAL_CONFLICT', undefined, {
        conflicts: preview.combinedConflicts,
      });
    }

    const allOps: FileOp[] = [];
    for (const d of preview.diffs) allOps.push(...d.fileOps);
    const proposalKinds = selected.map((p) => p.kind);

    // step4-5: 影響パス算出・ロックスコープ決定。
    const affected = affectedRelPaths(allOps);
    const lockScope = decideLockScope(allOps, proposalKinds);

    const sessionFile = mnemothecaPaths(ctx.projectRoot).organizeSessionJson;

    // step6: ロック内で snapshot → applying フラグ → FileOp → finalize / ロールバック。
    const outcome = await withLock(ctx.projectRoot, lockScope, async () => {
      // ロック取得前(step1)の session 読み取りから、このロックを実際に取得するまでの間に
      // 別の apply がすでに完了/クラッシュしている可能性がある(TOCTOU)。lock 内で再検証
      // してから initial write に進む(古い session オブジェクトのまま書き戻さない)。
      const { session: freshSession } = await readSession(ctx.projectRoot);
      if (
        freshSession === null ||
        freshSession.sessionId !== args.sessionId ||
        freshSession.applying ||
        isSessionExpired(freshSession, now)
      ) {
        throw new MnemoError('ORGANIZE_SESSION_EXPIRED');
      }

      const snap = await createSnapshot(ctx.projectRoot, args.label, affected, knownIds);

      // FileOp ループの直前に applying:true + snapshotId(atomic write。設計書 §10-5 step2)。
      await writeSession(ctx.projectRoot, { ...freshSession, applying: true, snapshotId: snap });

      try {
        const result = await executeFileOps(ctx.projectRoot, allOps, now);
        await finalizeSnapshotManifest(ctx.projectRoot, snap, {
          created: result.created,
          deletions: result.deletions,
        });
        // 正常完了 → セッション消費済み。applying フラグごと削除(設計書 §10-5 step3)。
        await fs.promises.rm(sessionFile, { force: true }).catch(() => {});
        return { snap, summary: result.summary };
      } catch (err) {
        try {
          await restoreSnapshot(ctx.projectRoot, snap);
        } catch {
          // restoreSnapshot 自体が失敗 → applying:true を残したまま SNAPSHOT_FAILED(設計書 §12-10)。
          throw new MnemoError('SNAPSHOT_FAILED', 'ロールバックに失敗しました', {
            snapshotDir: `${mnemothecaPaths(ctx.projectRoot).snapshotsDir}/${snap}`,
          });
        }
        // ロールバック成功 → セッション削除(復帰不要。設計書 §10-5 step4)。
        await fs.promises.rm(sessionFile, { force: true }).catch(() => {});
        throw err;
      }
    });

    // step7: categories 再生成。
    await regenerateCategories(ctx.projectRoot);

    // step8: 全再構築(サーバー経由 or ファイル直更新)。失敗は保存成功扱い + 付記(decision-log #48/#51)。
    let reindexFellBack = false;
    try {
      const r = await reindexPaths(ctx.projectRoot, affected.length > 0 ? affected : undefined, {
        full: true,
      });
      reindexFellBack = r.serverFellBack;
    } catch {
      reindexFellBack = true;
    }

    // step9: usage 追記。
    await appendUsage(ctx.projectRoot, {
      ts: new Date(now).toISOString(),
      mode: 'organize',
      event: 'organize.apply',
      ok: true,
      count: knownIds.length,
      paths: affected,
      proposalKinds,
      snapshot: outcome.snap,
    });

    // step10: snapshot 世代 GC。
    await gcSnapshots(ctx.projectRoot, SNAPSHOT_KEEP);

    // step11: サマリー返却。
    const result = { snapshot: outcome.snap, applied: knownIds, summary: outcome.summary };
    const text =
      formatOrganizeApplyResult(result) +
      (reindexFellBack ? '\n(検索インデックスはファイル直更新で反映しました。)' : '');

    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: {
        snapshot: outcome.snap,
        applied: knownIds,
        summary: outcome.summary as unknown as Record<string, unknown>,
      },
    };
  },
};

// ───────────────────────── undo(§8-N)─────────────────────────

/** undo の入力(設計書 §8-N)。`snapshot` 省略時は直近スナップショット。 */
const undoInputSchema = z.object({
  snapshot: z
    .string()
    .optional()
    .describe(
      '復元するスナップショット ID。省略時は直近。前回 apply が中断していれば ' +
        'mnemo_organize_scan が返す pendingRecovery.snapshotId を渡す',
    ),
});

/**
 * `mnemo_organize_undo`(設計書 §8-N undo)。直近(または指定)スナップショットを vault へ復元し、
 * categories 再生成 + 全再インデックスを行う。復元した snapshot が `applying:true` の
 * `organize-session.json` の `snapshotId` と一致した場合のみ、その session ファイルを削除して
 * クラッシュ復帰ループを閉じる(step4)。通常 undo は session を触らない。
 */
export const organizeUndoModule: ToolModule = {
  name: 'mnemo_organize_undo',
  config: {
    title: '整理の取り消し(スナップショット復元)',
    description:
      'mnemo_organize_apply による直近の整理を取り消し、スナップショット時点の vault に戻す。' +
      'snapshot を省略すると最も新しいスナップショットを使う。前回の apply が中断されたまま' +
      '(mnemo_organize_scan が pendingRecovery を返す)の場合は、その ' +
      'pendingRecovery.snapshotId を snapshot に指定して呼ぶことで中断状態も解消される。',
    inputSchema: undoInputSchema,
  },
  handler: async (args: z.infer<typeof undoInputSchema>, ctx): Promise<CallToolResult> => {
    const vault = await checkVault(ctx.projectRoot);
    if (!vault.ok) throw vaultError(vault.reason);

    const result = await organizeUndo(ctx.projectRoot, { snapshot: args.snapshot });

    return {
      content: [{ type: 'text' as const, text: formatOrganizeUndoResult(result) }],
      structuredContent: {
        restored: result.restored,
        snapshot: result.snapshot,
        fileCount: result.fileCount,
        sessionCleared: result.sessionCleared,
      },
    };
  },
};
