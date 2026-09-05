// src/mcp/organize/preview.ts — organize preview フェーズの純ロジック(設計書 §8-N preview)。
//
// **純関数のみ**(I/O・時刻取得・乱数なし)。入力は「scan が確定した提案定義
// (`OrganizeProposal[]`)＋ 選択された proposalId ＋ 現在のノート内容(本文/frontmatter)」、
// 出力は「提案ごとの `FileOp[]` と、提案間の競合(`conflicts` / `combinedConflicts`)」。
// ファイルは一切触らない。実際の適用・スナップショットは apply(`src/mcp/organize/apply.ts`)の責務。
//
// SuggestionKind → FileOp 写像(設計書 §8-N の表を、detect.ts が実装した SuggestionKind に合わせたもの):
//   split-category     … mkdir(サブディレクトリ)+ 各メンバーを move(categories パッチ付き)
//   merge-category     … カテゴリ B の全ノートを A へ move + rmdir(B)
//   duplicate          … 2 本目以降を 1 本目へ merge-into し、続けて重複元を delete
//   move-uncategorized … mkdir(候補カテゴリ)+ 対象を move(categories パッチ付き)
//   fix-frontmatter    … rewrite-frontmatter(検出理由から算出できる範囲でパッチを付ける)
//   split-file         … 実分割は Claude の作業。決定論的な FileOp は無いので空(Before/After のみ提示)
//   stale-content      … 助言のみ。FileOp 無し
//
// 競合検出(設計書 §8-N「同一ファイルへの move+delete 等」): FileOp 列全体を走査し、
// 同一パスに対して 2 つ以上の別提案が破壊的操作(move / delete / merge-into / rewrite-frontmatter)を
// 行う、または 2 つ以上の別提案が別ソースから同一パスへ書き込む場合を競合とする。
// preview では **throw せず** `conflicts[]` / `combinedConflicts` に載せる(apply で未解消なら
// `PROPOSAL_CONFLICT` を throw する。これは apply の責務)。

import type { Frontmatter } from '../../core/frontmatter.js';
import type { SuggestionKind } from './detect.js';
import { UNCATEGORIZED } from './detect.js';
import type { OrganizeProposal } from './scan.js';

/**
 * 統合後本文プレビューの最大文字数。設計書 §8-N `OrganizePreviewResult.mergedBodyPreview`
 * 「結合本文の先頭 2000 字」の設計値(ハードコード値として扱ってよい)。
 */
export const MERGED_BODY_PREVIEW_MAX = 2000;

/** 実行される具体的なファイル操作(設計書 §8-N `FileOp`)。 */
export interface FileOp {
  op: 'move' | 'rewrite-frontmatter' | 'merge-into' | 'delete' | 'mkdir' | 'rmdir';
  from?: string;
  to?: string;
  frontmatterPatch?: Partial<Frontmatter>;
}

/** preview の 1 提案分の結果(設計書 §8-N `OrganizePreviewResult.diffs[]`)。 */
export interface ProposalDiff {
  proposalId: string;
  kind: SuggestionKind;
  before: string;
  after: string;
  fileOps: FileOp[];
  /** merge 系(duplicate)のとき統合後本文の先頭 2000 字。 */
  mergedBodyPreview?: string;
  /** 他の選択提案と競合する場合の説明(この提案が関与するものだけ)。 */
  conflicts: string[];
}

/** preview の戻り値(設計書 §8-N `OrganizePreviewResult`)。 */
export interface OrganizePreviewResult {
  diffs: ProposalDiff[];
  /** proposalIds 全体で矛盾があれば(例: 同じファイルを別提案が移動+削除)。 */
  combinedConflicts: string[];
}

/** 現在のノート 1 件分(preview 純関数への入力。呼び出し側が vault を読んで組み立てる)。 */
export interface PreviewNote {
  /** vault ルート相対・POSIX(例: `knowledge/tech/foo.md`)。 */
  relPath: string;
  /** `categories[0]`(未設定・空なら `_uncategorized`)。 */
  category: string;
  /** ノート本文(frontmatter を除く)。 */
  body: string;
  /** パース済み frontmatter。 */
  frontmatter: Frontmatter;
}

function basename(relPath: string): string {
  return relPath.split('/').filter((s) => s !== '').pop() ?? relPath;
}

/** `knowledge/<cat...>/<file>.md` → 実ディレクトリのカテゴリ経路(無ければ空)。 */
function dirCategoryOf(relPath: string): string {
  const parts = relPath.split('/').filter((s) => s !== '');
  if (parts.length < 3 || parts[0] !== 'knowledge') return '';
  return parts.slice(1, -1).join('/');
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** frontmatter の `categories` を検出器と同じ規則でカテゴリキーへ(未設定・不正なら `_uncategorized`)。 */
export function previewCategoryKey(categories: unknown): string {
  const first = Array.isArray(categories) ? categories[0] : undefined;
  if (typeof first !== 'string') return UNCATEGORIZED;
  const trimmed = first.trim();
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.includes('..')) return UNCATEGORIZED;
  return trimmed;
}

/** 1 提案を FileOp 列へ展開する(SuggestionKind 別の写像。モジュール冒頭コメントの表)。 */
function expandProposal(
  p: OrganizeProposal,
  notesByRel: Map<string, PreviewNote>,
  notesByCategory: Map<string, PreviewNote[]>,
): { fileOps: FileOp[]; mergedBodyPreview?: string } {
  switch (p.kind) {
    case 'fix-frontmatter': {
      const relPath = p.targets[0];
      if (relPath === undefined) return { fileOps: [] };
      const reasons = asStringArray((p.evidence as Record<string, unknown>)['reasons']);
      const patch: Partial<Frontmatter> = {};
      if (reasons.includes('category-path-mismatch')) {
        const dirCat = dirCategoryOf(relPath);
        if (dirCat !== '') patch.categories = [dirCat];
      }
      const op: FileOp = { op: 'rewrite-frontmatter', from: relPath, to: relPath };
      if (Object.keys(patch).length > 0) op.frontmatterPatch = patch;
      return { fileOps: [op] };
    }

    case 'move-uncategorized': {
      const relPath = p.targets[0];
      const cand = (p.evidence as Record<string, unknown>)['candidateCategory'];
      if (relPath === undefined || typeof cand !== 'string') return { fileOps: [] };
      const to = `knowledge/${cand}/${basename(relPath)}`;
      return {
        fileOps: [
          { op: 'mkdir', to: `knowledge/${cand}` },
          { op: 'move', from: relPath, to, frontmatterPatch: { categories: [cand] } },
        ],
      };
    }

    case 'split-category': {
      const ev = p.evidence as Record<string, unknown>;
      const category = typeof ev['category'] === 'string' ? ev['category'] : undefined;
      const tag = typeof ev['clusterTag'] === 'string' ? ev['clusterTag'] : undefined;
      if (category === undefined || tag === undefined) return { fileOps: [] };
      const subdir = `knowledge/${category}/${tag}`;
      const members = p.targets.filter((t) => t.endsWith('.md'));
      const fileOps: FileOp[] = [{ op: 'mkdir', to: subdir }];
      for (const m of members) {
        fileOps.push({
          op: 'move',
          from: m,
          to: `${subdir}/${basename(m)}`,
          frontmatterPatch: { categories: [`${category}/${tag}`] },
        });
      }
      return { fileOps };
    }

    case 'merge-category': {
      const cats = asStringArray((p.evidence as Record<string, unknown>)['categories']);
      const [a, b] = cats;
      if (a === undefined || b === undefined) return { fileOps: [] };
      const members = notesByCategory.get(b) ?? [];
      const fileOps: FileOp[] = [];
      for (const n of members) {
        fileOps.push({
          op: 'move',
          from: n.relPath,
          to: `knowledge/${a}/${basename(n.relPath)}`,
          frontmatterPatch: { categories: [a] },
        });
      }
      fileOps.push({ op: 'rmdir', from: `knowledge/${b}` });
      return { fileOps };
    }

    case 'duplicate': {
      const [into, ...sources] = p.targets;
      if (into === undefined || sources.length === 0) return { fileOps: [] };
      // §8-N 写像表: 2 本目以降を 1 本目へ merge-into し、重複元を delete する
      // (apply の merge-into は本文統合まで、実ファイル削除は後続の delete で明示する。PM 確定 2026-09-03)。
      const fileOps: FileOp[] = [];
      for (const s of sources) {
        fileOps.push({ op: 'merge-into', from: s, to: into });
        fileOps.push({ op: 'delete', from: s });
      }

      const chunks: string[] = [];
      const intoBody = notesByRel.get(into)?.body ?? '';
      chunks.push(intoBody);
      for (const s of sources) chunks.push(notesByRel.get(s)?.body ?? '');
      const merged = chunks.join('\n\n---\n\n');
      return {
        fileOps,
        mergedBodyPreview: merged.slice(0, MERGED_BODY_PREVIEW_MAX),
      };
    }

    case 'split-file':
    case 'stale-content':
    default:
      return { fileOps: [] };
  }
}

/** FileOp の「破壊的にそのパスへ触れる」ソース側パス(mkdir / mkdir 以外の from)を返す。 */
function destructiveSourcePath(op: FileOp): string | undefined {
  if (op.op === 'move' || op.op === 'delete' || op.op === 'merge-into' || op.op === 'rewrite-frontmatter') {
    return op.from;
  }
  if (op.op === 'rmdir') return op.from;
  return undefined;
}

/** FileOp の「書き込み先」パス(move / merge-into の to)を返す。 */
function writeTargetPath(op: FileOp): string | undefined {
  if (op.op === 'move' || op.op === 'merge-into') return op.to;
  return undefined;
}

interface Expanded {
  proposalId: string;
  fileOps: FileOp[];
}

/** 展開済み FileOp 列の集合から提案間競合を検出する(設計書 §8-N。throw しない)。 */
function detectConflicts(expanded: Expanded[]): {
  perProposal: Map<string, string[]>;
  combined: string[];
} {
  const perProposal = new Map<string, string[]>();
  const combined: string[] = [];
  const add = (ids: string[], msg: string): void => {
    if (!combined.includes(msg)) combined.push(msg);
    for (const id of ids) {
      const list = perProposal.get(id) ?? [];
      if (!list.includes(msg)) list.push(msg);
      perProposal.set(id, list);
    }
  };

  // (1) 同一ソースパスに複数提案が破壊的操作
  const bySource = new Map<string, Set<string>>();
  for (const e of expanded) {
    for (const op of e.fileOps) {
      const src = destructiveSourcePath(op);
      if (src === undefined) continue;
      const set = bySource.get(src) ?? new Set<string>();
      set.add(e.proposalId);
      bySource.set(src, set);
    }
  }
  for (const [path, ids] of bySource) {
    if (ids.size >= 2) {
      const sorted = [...ids].sort();
      add(sorted, `同一ファイル ${path} に対する操作が提案 ${sorted.join(', ')} で競合しています`);
    }
  }

  // (2) 別ソースから同一パスへの書き込みが複数提案で衝突
  const byTarget = new Map<string, Map<string, Set<string>>>(); // to -> (proposalId -> from set)
  for (const e of expanded) {
    for (const op of e.fileOps) {
      const to = writeTargetPath(op);
      if (to === undefined) continue;
      const perId = byTarget.get(to) ?? new Map<string, Set<string>>();
      const froms = perId.get(e.proposalId) ?? new Set<string>();
      if (op.from !== undefined) froms.add(op.from);
      perId.set(e.proposalId, froms);
      byTarget.set(to, perId);
    }
  }
  for (const [path, perId] of byTarget) {
    if (perId.size >= 2) {
      const sorted = [...perId.keys()].sort();
      add(sorted, `書き込み先 ${path} が提案 ${sorted.join(', ')} で競合しています`);
    }
  }

  return { perProposal, combined };
}

/**
 * preview の本体(設計書 §8-N preview)。選択された proposalId を FileOp 列へ展開し、
 * 提案間競合を(throw せず)`conflicts` / `combinedConflicts` に載せて返す。
 * 未知の proposalId は無視し、`combinedConflicts` に情報行として残す(設計 §8-N は
 * 「エラー or 無視」を許容。preview は非破壊なので無視を選択)。
 */
export function buildPreview(
  proposals: OrganizeProposal[],
  proposalIds: string[],
  notes: Map<string, PreviewNote>,
): OrganizePreviewResult {
  const byId = new Map(proposals.map((p) => [p.proposalId, p]));

  const notesByCategory = new Map<string, PreviewNote[]>();
  for (const n of notes.values()) {
    const list = notesByCategory.get(n.category) ?? [];
    list.push(n);
    notesByCategory.set(n.category, list);
  }

  const combinedExtra: string[] = [];
  const selected: { proposal: OrganizeProposal; expanded: ReturnType<typeof expandProposal> }[] = [];
  const seen = new Set<string>();
  for (const id of proposalIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const proposal = byId.get(id);
    if (proposal === undefined) {
      combinedExtra.push(`未知の proposalId ${id}(無視しました)`);
      continue;
    }
    selected.push({ proposal, expanded: expandProposal(proposal, notes, notesByCategory) });
  }

  const { perProposal, combined } = detectConflicts(
    selected.map((s) => ({ proposalId: s.proposal.proposalId, fileOps: s.expanded.fileOps })),
  );

  const diffs: ProposalDiff[] = selected.map(({ proposal, expanded }) => {
    const diff: ProposalDiff = {
      proposalId: proposal.proposalId,
      kind: proposal.kind,
      before: proposal.before,
      after: proposal.after,
      fileOps: expanded.fileOps,
      conflicts: perProposal.get(proposal.proposalId) ?? [],
    };
    if (expanded.mergedBodyPreview !== undefined) diff.mergedBodyPreview = expanded.mergedBodyPreview;
    return diff;
  });

  return { diffs, combinedConflicts: [...combined, ...combinedExtra] };
}
