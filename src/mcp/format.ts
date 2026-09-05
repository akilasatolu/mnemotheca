// src/mcp/format.ts — MCP tool 戻り値本文(text)の日本語整形(設計 §8-M / §8-N / §8-O / §12-1)。
//
// このモジュールは **純関数のみ**(I/O・時刻取得・乱数なし)。store / organize / show の
// ハンドラが組み立てた DTO を受け取り、全 MCP クライアント共通の `content[0].text` 文字列を返す。
//
// 入力型は store/organize 側が DTO 型を公開していないため、
// ここで最小の構造型(`*Like`)をローカル定義する。呼び出し側はこの `*Like` に構造的に
// 適合する DTO を渡せばよい(シグネチャは安定させる方針)。

import type { ErrorCode } from '../core/errors.js';

// ───────────────────────── store: dry-run(StorePlan → text)─────────────────────────

/** store dry-run の提示に必要な最小構造(設計 §8-M `StorePlan`)。 */
export interface StorePlanLike {
  willCreate: Array<{
    slug: string;
    /** 書き込み予定パス(衝突解決後。例: `knowledge/architecture/aws-mcp-2.md`)。 */
    path: string;
    title: string;
    /** 保存先カテゴリの単一セグメント(= `categories[0]` = `targetDir`)。 */
    categorySegment: string;
    summary: string;
    collision: 'none' | 'auto-number' | 'append' | 'abort';
  }>;
  /** WARN 種別と件数のみ(保存は続行)。 */
  piiWarnings: Array<{ pattern: string; count: number }>;
  /** BLOCK(検出されると apply は失敗する)。 */
  piiBlocks: Array<{ pattern: string; noteSlug: string; masked: string }>;
  /** 新規作成されるカテゴリセグメント。 */
  newCategories: string[];
  totalApproxChars: number;
}

function collisionNote(collision: StorePlanLike['willCreate'][number]['collision']): string {
  switch (collision) {
    case 'auto-number':
      return ' → 既存と同名のため別名(連番)で作成予定';
    case 'append':
      return ' → 既存ファイルに追記予定';
    case 'abort':
      return ' → abort 指定のため衝突時は中断予定';
    case 'none':
    default:
      return '';
  }
}

/**
 * store `apply:false`(dry-run)の戻り値 text。設計 §8-M の「text 例」に準拠。
 * 承認導線(apply:true 再送)の一文で必ず締める。
 */
export function formatStorePlan(plan: StorePlanLike): string {
  const newCats = new Set(plan.newCategories);
  const lines: string[] = [];
  lines.push(`${plan.willCreate.length} 件のノートを保存予定です。`);

  plan.willCreate.forEach((n, i) => {
    const mkCat = newCats.has(n.categorySegment) ? `(新規カテゴリ ${n.categorySegment} を作成)` : '';
    lines.push(`${i + 1}. ${n.path} — 「${n.title}」${collisionNote(n.collision)}${mkCat}`);
  });

  if (plan.piiWarnings.length > 0) {
    const w = plan.piiWarnings.map((p) => `${p.pattern} ${p.count} 件`).join('、');
    lines.push(`PII: ${w} を検出(WARN、保存は続行)。`);
  } else {
    lines.push('PII: WARN の検出はありません。');
  }

  if (plan.piiBlocks.length > 0) {
    const b = plan.piiBlocks.map((p) => `${p.pattern}(${p.noteSlug}: ${p.masked})`).join('、');
    lines.push(`PII BLOCK: ${b}。このままでは apply は失敗します。`);
  } else {
    lines.push('クレデンシャル等の BLOCK はありません。');
  }

  lines.push(`合計およそ ${plan.totalApproxChars} 文字。`);

  if (plan.piiBlocks.length > 0) {
    lines.push('BLOCK を解消(該当ノートから機密情報を除去)してから apply:true で再送してください。');
  } else {
    lines.push('この内容で保存してよろしければ、承認後に apply:true で再送してください。');
  }

  return lines.join('\n');
}

// ───────────────────────── store: apply 結果サマリー ─────────────────────────

/** store `apply:true` の結果(設計 §8-M `StoreResult`)。 */
export interface StoreResultLike {
  created: Array<{ slug: string; path: string; id: string }>;
  appended: Array<{ slug: string; path: string; id?: string }>;
  categoriesRegenerated: boolean;
}

/** store `apply:true` の戻り値 text。設計 §8-M「3 件保存しました:\n- …」。 */
export function formatStoreResult(result: StoreResultLike): string {
  const total = result.created.length + result.appended.length;
  const lines: string[] = [`${total} 件保存しました:`];
  for (const c of result.created) lines.push(`- ${c.path}`);
  for (const a of result.appended) lines.push(`- ${a.path}(既存ファイルに追記)`);
  if (result.categoriesRegenerated) lines.push('カテゴリ一覧を再生成しました。');
  return lines.join('\n');
}

// ───────────────────────── organize: preview(FileOp 列 → Before/After text)─────────────────────────

export interface FileOpLike {
  op: 'move' | 'rewrite-frontmatter' | 'merge-into' | 'delete' | 'mkdir' | 'rmdir';
  from?: string;
  to?: string;
}

/** organize preview の 1 提案分(設計 §8-N `OrganizePreviewResult.diffs[]`)。 */
export interface ProposalDiffLike {
  proposalId: string;
  kind?: string;
  before?: string;
  after?: string;
  fileOps: FileOpLike[];
  /** merge-file のとき統合後本文プレビュー。 */
  mergedBodyPreview?: string;
  /** 他の選択提案との競合説明。 */
  conflicts?: string[];
}

function formatFileOp(op: FileOpLike): string {
  switch (op.op) {
    case 'move':
      return `移動: ${op.from ?? '?'} → ${op.to ?? '?'}`;
    case 'merge-into':
      return `統合: ${op.from ?? '?'} → ${op.to ?? '?'}`;
    case 'rewrite-frontmatter':
      return `frontmatter 修正: ${op.to ?? op.from ?? '?'}`;
    case 'delete':
      return `削除: ${op.from ?? op.to ?? '?'}`;
    case 'mkdir':
      return `ディレクトリ作成: ${op.to ?? '?'}`;
    case 'rmdir':
      return `ディレクトリ削除: ${op.from ?? op.to ?? '?'}`;
    default:
      return `${op.op as string}: ${op.from ?? ''}${op.to ? ` → ${op.to}` : ''}`;
  }
}

/**
 * organize preview の戻り値 text。設計 §8-N。提案ごとに Before/After と具体的な
 * ファイル操作を列挙し、競合があれば併記する。個別承認を促す一文で締める。
 */
export function formatOrganizePreview(
  diffs: ProposalDiffLike[],
  combinedConflicts: string[] = [],
): string {
  const blocks: string[] = [];
  for (const d of diffs) {
    const lines: string[] = [];
    lines.push(`[${d.proposalId}]${d.kind ? ` ${d.kind}` : ''}`);
    if (d.before !== undefined) lines.push(`  Before: ${d.before}`);
    if (d.after !== undefined) lines.push(`  After:  ${d.after}`);
    if (d.fileOps.length > 0) {
      lines.push('  操作:');
      for (const op of d.fileOps) lines.push(`    - ${formatFileOp(op)}`);
    }
    if (d.mergedBodyPreview !== undefined) {
      lines.push('  統合後本文(先頭):');
      lines.push(`    ${d.mergedBodyPreview.replace(/\n/g, '\n    ')}`);
    }
    if (d.conflicts && d.conflicts.length > 0) {
      lines.push(`  競合: ${d.conflicts.join(' / ')}`);
    }
    blocks.push(lines.join('\n'));
  }

  let text = blocks.join('\n\n');
  if (combinedConflicts.length > 0) {
    text += `\n\n全体の競合:\n${combinedConflicts.map((c) => `  - ${c}`).join('\n')}`;
  }
  text +=
    '\n\n各提案を個別にユーザーへ提示し、承認されたものだけを mnemo_organize_apply に渡してください' +
    '(削除・統合・カテゴリ名変更は confirmedDestructive にも列挙)。';
  return text;
}

// ───────────────────────── organize: apply 結果サマリー ─────────────────────────

export interface OrganizeApplySummaryLike {
  dirsCreated: string[];
  dirsRemoved: string[];
  filesMoved: Array<{ from: string; to: string }>;
  filesMerged: Array<{ sources: string[]; into: string }>;
  filesDeleted: string[];
  frontmatterFixed: string[];
}

export interface OrganizeApplyResultLike {
  snapshot: string;
  applied: string[];
  summary: OrganizeApplySummaryLike;
}

/** organize apply の戻り値 text。設計 §8-N。undo 導線を必ず添える。 */
export function formatOrganizeApplyResult(result: OrganizeApplyResultLike): string {
  const s = result.summary;
  const lines: string[] = [];
  lines.push(`整理を適用しました(スナップショット ${result.snapshot})。`);
  if (result.applied.length > 0) lines.push(`適用した提案: ${result.applied.join(', ')}`);

  if (s.filesMoved.length > 0) {
    lines.push(`- 移動: ${s.filesMoved.length} 件`);
    for (const m of s.filesMoved) lines.push(`    ${m.from} → ${m.to}`);
  }
  if (s.filesMerged.length > 0) {
    lines.push(`- 統合: ${s.filesMerged.length} 件`);
    for (const m of s.filesMerged) lines.push(`    ${m.sources.join(', ')} → ${m.into}`);
  }
  if (s.filesDeleted.length > 0) {
    lines.push(`- 削除: ${s.filesDeleted.length} 件`);
    for (const d of s.filesDeleted) lines.push(`    ${d}`);
  }
  if (s.frontmatterFixed.length > 0) {
    lines.push(`- frontmatter 修正: ${s.frontmatterFixed.length} 件`);
  }
  if (s.dirsCreated.length > 0) lines.push(`- 作成したディレクトリ: ${s.dirsCreated.join(', ')}`);
  if (s.dirsRemoved.length > 0) lines.push(`- 削除したディレクトリ: ${s.dirsRemoved.join(', ')}`);

  lines.push(`元に戻すには mnemo_organize_undo({ snapshot: "${result.snapshot}" }) を実行してください。`);
  return lines.join('\n');
}

// ───────────────────────── show: URL 案内 ─────────────────────────

export interface ShowResultLike {
  url: string;
  started: boolean;
  browserOpened: boolean;
  port: number;
}

/** show の戻り値 text。設計 §8-O。 */
export function formatShowResult(result: ShowResultLike): string {
  if (result.browserOpened) {
    return `ブラウザで UI を開きました: ${result.url}`;
  }
  return `UI サーバーは起動しています。ブラウザを自動で開けなかったので次の URL を開いてください: ${result.url}`;
}

// ───────────────────────── エラー(MnemoError → text)─────────────────────────

/** `MnemoError` の運搬に必要な最小構造(`src/core/errors.ts` の `MnemoError` に構造適合)。 */
export interface MnemoErrorLike {
  code: ErrorCode;
  message?: string;
  details?: Record<string, unknown>;
}

/** code ごとの「説明 + 対処」。全 `ErrorCode`(26)を網羅(`satisfies` で保証)。 */
const ERROR_TEXT = {
  NOT_INITIALIZED: {
    desc: 'このディレクトリはまだ Mnemo で初期化されていません。',
    action: 'projectRoot で `mnemo init` を実行してください。',
  },
  CONFIG_CORRUPT: {
    desc: '.mnemotheca/config.json が壊れています。',
    action: '`mnemo doctor` で診断し、必要なら再初期化してください。',
  },
  PROJECT_NOT_WRITABLE: {
    desc: 'projectRoot に書き込めません。',
    action: 'ディレクトリの権限を確認してください。',
  },
  VAULT_UNAVAILABLE: {
    desc: 'vault/ にアクセスできません。ディレクトリが消えていないか確認してください。',
    action: '`mnemo doctor --fix` で再作成できます。',
  },
  VAULT_NOT_WRITABLE: {
    desc: 'vault/ に書き込めません。',
    action: 'vault/ ディレクトリの権限を確認してください。',
  },
  NODE_MODULES_MISSING: {
    desc: '本体(`node_modules/mnemo`)が見つかりません(install 忘れ、または別マシンへの移動後)。',
    action: 'projectRoot で `npm install` を実行してください。',
  },
  RUNTIME_DIR_UNWRITABLE: {
    desc: 'ランタイムディレクトリに書き込めません。',
    action: '`MNEMO_RUNTIME_DIR=<書き込み可能なパス>` を設定して再実行してください。',
  },
  LOCK_TIMEOUT: {
    desc: '別の保存/整理処理が実行中です。',
    action: '数秒待ってから再試行してください。',
  },
  FRONTMATTER_PARSE: {
    desc: 'ノートの frontmatter(YAML)を解釈できませんでした。',
    action: 'details のパスのファイルを開き、frontmatter の書式を修正してください。',
  },
  FRONTMATTER_SCHEMA: {
    desc: 'ノートの frontmatter が必須項目を満たしていません。',
    action: 'details のフィールドを確認して修正してください。',
  },
  CATEGORY_INVARIANT: {
    desc: 'categories[0] と保存先カテゴリ(targetDir)が一致していません。',
    action: 'categories[0] を targetDir と同じ単一セグメント文字列にしてください。',
  },
  SLUG_COLLISION: {
    desc: '同名の slug が既に存在します(collisionStrategy=abort)。',
    action: 'slug を変えるか、collisionStrategy を auto-number / append-to-existing にしてください。',
  },
  SLUG_INVALID: {
    desc: 'slug の形式が不正です。',
    action: '英小文字・数字・ハイフンのみ(日付プレフィックス禁止)の slug にしてください。',
  },
  PII_BLOCKED: {
    desc: '本文に機密情報(クレデンシャル等)が含まれるため処理を中止しました。',
    action: '該当箇所を除去してから再実行してください。',
  },
  ORGANIZE_SESSION_EXPIRED: {
    desc: '整理セッションが失効しているか、前回の整理が未完了です。',
    action:
      'mnemo_organize_scan からやり直してください。pendingRecovery が返る場合は ' +
      'mnemo_organize_undo({ snapshot: pendingRecovery.snapshotId }) で復元します。',
  },
  DESTRUCTIVE_NOT_CONFIRMED: {
    desc: '破壊的な提案(削除・統合・カテゴリ名変更)は個別承認が必要です。',
    action: '対象の proposalId を confirmedDestructive に列挙して再実行してください。',
  },
  PROPOSAL_CONFLICT: {
    desc: '選択した提案どうしが矛盾しています(同一ファイルへの move+delete など)。',
    action: '競合する提案のどちらかを外して再実行してください。',
  },
  SNAPSHOT_FAILED: {
    desc: 'スナップショットの作成または復元に失敗しました。',
    action: 'details.snapshotDir から手動で復元できます。ディスク容量と権限を確認してください。',
  },
  PORT_UNAVAILABLE: {
    desc: 'UI サーバー用のポートを確保できませんでした。',
    action: '使用中のプロセスを終了するか、`mnemo start --port <N>` で別ポートを指定してください。',
  },
  SERVER_START_TIMEOUT: {
    desc: 'UI サーバーを起動できませんでした。',
    action: 'projectRoot 内で `mnemo start` を実行してください。',
  },
  BROWSER_OPEN_FAILED: {
    desc: 'ブラウザを自動で開けませんでした。',
    action: '表示された URL を手動で開いてください。',
  },
  INDEX_BUILD_FAILED: {
    desc: '検索インデックスの構築に失敗しました。',
    action: '`mnemo reindex --full` を実行してください。',
  },
  QUERY_TOO_SHORT: {
    desc: '検索クエリが短すぎます。',
    action: '2 文字以上のクエリを指定してください。',
  },
  NODE_VERSION_UNSUPPORTED: {
    desc: 'Node.js のバージョンが古すぎます(20 以上が必要)。',
    action: 'Node.js 20 以降をインストールして再実行してください。',
  },
  SNIPPET_STALE: {
    desc: '登録済みの MCP 連携スニペットが現在の設定とずれています。',
    action: 'node を切り替えた場合は `mnemo init` でスニペットを再取得してください。',
  },
  UNAUTHORIZED: {
    desc: '認証に失敗しました。',
    action: 'トークンを確認してください。',
  },
} satisfies Record<ErrorCode, { desc: string; action: string }>;

/**
 * `MnemoError` を MCP tool 戻り値の text に整形(設計 §12-1)。
 * Claude がユーザーへ対処を伝えられるよう「説明 + 対処」を日本語で返す。
 * `structuredContent: { code, details }` はハンドラ側で別途付与する。
 */
export function formatMnemoError(err: MnemoErrorLike): string {
  const entry = ERROR_TEXT[err.code];
  const lines: string[] = [];
  lines.push(entry ? entry.desc : (err.message ?? err.code));

  const detail = err.details && typeof err.details['detail'] === 'string'
    ? (err.details['detail'] as string)
    : undefined;
  if (detail) lines.push(detail);

  if (entry) lines.push(`対処: ${entry.action}`);

  const snapshotDir = err.details?.['snapshotDir'];
  if (typeof snapshotDir === 'string') lines.push(`スナップショット: ${snapshotDir}`);

  return lines.join('\n');
}
