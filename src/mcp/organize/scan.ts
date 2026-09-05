// src/mcp/organize/scan.ts — organize scan フェーズのオーケストレーション(設計書 §8-N scan)。
//
// `listNotes` で vault の全ノートを読み(壊れたノートは `parseErrors` へ収集)、本文を
// `readNote` で取得して `detect.ts` の検出器群へ渡し、`OrganizePreview`(提案リスト +
// `heuristicsVersion`)へ整形する。**ファイルは一切変更しない**(dry-run)。
//
// 閾値は `ORGANIZE_THRESHOLDS` から、ヒューリスティクス世代は `ORGANIZE_HEURISTICS_VERSION`
// から取得する(設計書 §8-K / 付録 C。ハードコード禁止)。organize-session.json への
// 永続化・pendingRecovery は `session.ts`、apply/undo は `apply.ts` / `undo.ts` の担当で、
// ここには置かない。

import {
  ORGANIZE_HEURISTICS_VERSION,
  ORGANIZE_THRESHOLDS,
} from '../../core/organize-config.js';
import { listNotes, readNote } from '../../core/note.js';
import { detectAll, UNCATEGORIZED, type DetectNote, type Suggestion } from './detect.js';
import {
  buildSession,
  isSessionExpired,
  newSessionId,
  readSession,
  writeSession,
} from './session.js';

/** 提案 1 件(`Suggestion` に scan が採番した proposalId を付けたもの)。 */
export interface OrganizeProposal extends Suggestion {
  /** `${kind}-${n}`(kind ごとに 1 から連番。設計書 §8-N `Proposal.proposalId`)。 */
  proposalId: string;
}

/** scan(dry-run)の結果。ファイル変更は伴わない(設計書 §8-N `OrganizeScanResult`)。 */
export interface OrganizePreview {
  /** `organize-session.json` に保存される照合キー(`org-` + id)。preview / apply が参照。 */
  sessionId: string;
  /**
   * 前回の apply が異常終了して `organize-session.json` に `applying:true` が残っている場合の
   * 復帰情報(設計書 §12-10)。この回は `proposals` は空(スキャンしない)。通常は `null`。
   */
  pendingRecovery: { snapshotId: string; since: string } | null;
  /** scan 実行時刻(ISO8601)。 */
  scannedAt: string;
  /** organize ヒューリスティクスの世代(`ORGANIZE_HEURISTICS_VERSION`。付録 C)。 */
  heuristicsVersion: number;
  /** スキャン対象になった(正常に読めた)ノート数。 */
  noteCount: number;
  /** 機械検出した変更提案。 */
  proposals: OrganizeProposal[];
  /** パースに失敗し検出対象から外れたノート。 */
  parseErrors: { relPath: string; message: string }[];
}

export interface ScanOptions {
  /** stale 判定の基準時刻(既定 `Date.now()`)。テスト用。 */
  now?: number;
  /** `scope: 'category'` のとき、この単一カテゴリ(`categories[0]` 値)のノートだけを対象にする。 */
  onlyCategory?: string;
  /**
   * 前回中断した organize の復元を諦め、`applying:true` の `organize-session.json` を
   * `applying:false` / `snapshotId:null` に落としてから通常スキャンへ進む(設計書 §8-N / §10-5 step6)。
   */
  discardPendingRecovery?: boolean;
}

/** `categories[0]` を検出器用のカテゴリキーへ(未設定・空・不正なら `_uncategorized`)。 */
function categoryKey(categories: unknown): string {
  const first = Array.isArray(categories) ? categories[0] : undefined;
  if (typeof first !== 'string') return UNCATEGORIZED;
  const trimmed = first.trim();
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.includes('..')) return UNCATEGORIZED;
  return trimmed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** raw frontmatter を見て「`categories` がスカラー / 旧式 `category` キー」かを判定する。 */
function hasScalarCategories(fm: unknown): boolean {
  if (typeof fm !== 'object' || fm === null) return false;
  const rec = fm as Record<string, unknown>;
  if (rec.categories !== undefined && !Array.isArray(rec.categories)) return true;
  if (rec.categories === undefined && typeof rec.category === 'string') return true;
  return false;
}

/**
 * vault をスキャンして変更提案(dry-run)を返す(設計書 §8-N scan)。
 * ファイルは読むだけで、書き込み・移動・削除は行わない。
 */
export async function scanVault(
  projectRoot: string,
  options: ScanOptions = {},
): Promise<OrganizePreview> {
  const now = options.now ?? Date.now();
  const scannedAt = new Date(now).toISOString();

  // step0 + scan 冒頭のクラッシュ復帰チェック(設計書 §8-N L1483〜1498 / §10-5 / §12-10)。
  // readSession が JSON 破損を `.corrupt-<ts>` へ退避し「セッション無し」で返す。
  const { session } = await readSession(projectRoot);
  if (session !== null && session.applying && !isSessionExpired(session, now)) {
    if (options.discardPendingRecovery !== true) {
      // 復元は諦めず即 return(スキャンしない)。Claude は pendingRecovery を見て
      // mnemo_organize_undo({ snapshot: pendingRecovery.snapshotId }) をユーザー承認後に呼ぶ。
      return {
        sessionId: session.sessionId,
        pendingRecovery: {
          snapshotId: session.snapshotId ?? '',
          // §10-5 スキーマに「applying を立てた時刻」フィールドは無いため scannedAt で近似する。
          since: session.scannedAt,
        },
        scannedAt,
        heuristicsVersion: ORGANIZE_HEURISTICS_VERSION,
        noteCount: 0,
        proposals: [],
        parseErrors: [],
      };
    }
    // discardPendingRecovery:true → applying を落としてから通常スキャンへ(設計書 §10-5 step6)。
    await writeSession(projectRoot, { ...session, applying: false, snapshotId: null });
  }

  const { notes, errors } = await listNotes(projectRoot);

  const parseErrors = errors.map((e) => ({ relPath: e.relPath, message: e.message }));
  const detectNotes: DetectNote[] = [];

  for (const note of notes) {
    let body: string;
    try {
      ({ body } = await readNote(note.absPath));
    } catch (err) {
      parseErrors.push({
        relPath: note.relPath,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    detectNotes.push({
      relPath: note.relPath,
      category: categoryKey(note.fm.categories),
      title: typeof note.fm.title === 'string' ? note.fm.title : '',
      body,
      tags: stringArray(note.fm.tags),
      updated: typeof note.fm.updated === 'string' ? note.fm.updated : '',
      created: typeof note.fm.created === 'string' ? note.fm.created : '',
      categoriesScalar: hasScalarCategories(note.fm),
    });
  }

  const scanned =
    options.onlyCategory === undefined
      ? detectNotes
      : detectNotes.filter((n) => n.category === options.onlyCategory);

  const suggestions = detectAll(scanned, ORGANIZE_THRESHOLDS, now);

  const perKind = new Map<string, number>();
  const proposals: OrganizeProposal[] = suggestions.map((s) => {
    const n = (perKind.get(s.kind) ?? 0) + 1;
    perKind.set(s.kind, n);
    return { ...s, proposalId: `${s.kind}-${n}` };
  });

  // scan 完了 → sessionId を採番し proposals を organize-session.json へ atomic 保存
  // (preview / apply が同じ提案定義を参照する。設計書 §8-N L1498 / §10-5 step1)。
  const sessionId = newSessionId(now);
  await writeSession(projectRoot, buildSession(sessionId, scannedAt, proposals));

  return {
    sessionId,
    pendingRecovery: null,
    scannedAt,
    heuristicsVersion: ORGANIZE_HEURISTICS_VERSION,
    noteCount: scanned.length,
    proposals,
    parseErrors,
  };
}
