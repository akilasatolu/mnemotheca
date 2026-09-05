// src/mcp/organize/detect.ts — organize scan フェーズの決定論的検出器群(設計書 §8-N scan)。
//
// **純関数のみ**(I/O・時刻取得・乱数なし。`now` は引数で受ける)。入力はノート配列 +
// `ORGANIZE_THRESHOLDS`、出力は提案(`Suggestion`)配列。ファイルは一切触らない。
// 閾値は全て `core/organize-config.ts` の `ORGANIZE_THRESHOLDS` から渡される値を使い、
// このモジュール内にハードコードしない(設計書 §8-K / §13-9 / 付録 C)。
//
// カバーする kind(設計書 §8-N scan テーブルのうち、このモジュールが実装する分):
//   - split-category      … 同一カテゴリ `subdivideMinFiles` 件以上 + タグ偏り
//   - merge-category      … 2 カテゴリの集約本文 bigram Jaccard >= `mergeCandidateBigramJaccard`
//   - duplicate           … `titleKey` 完全一致 / `bodyHash`(sha256)一致
//   - move-uncategorized  … `_uncategorized` のノートが既存カテゴリと Jaccard >= `uncategorizedAssignMinJaccard`
//   - stale-content       … `updated` から `staleDays` 超 かつ tags に reference/permanent を含まない
//   - split-file          … ファイル名が日付プレフィックス(`^\d{4}-\d{2}-\d{2}-`)命名
//   - fix-frontmatter     … `categories` がスカラー / `categories[0]` != 実ディレクトリ経路 / `created > updated`
//
// rename-category / pii-found は scan の今後の拡張として未実装。
// split-file の「`## ` 見出し 4 個以上」判定(設計の完全形)は数値しきい値を
// `ORGANIZE_THRESHOLDS`(core/organize-config.ts)へ追加する必要があるため見送り、
// 日付プレフィックス命名のみを判定する。

import type { ORGANIZE_THRESHOLDS } from '../../core/organize-config.js';
import {
  bigramJaccard,
  bodyHash,
  jaccard,
  titleKey,
  toBigramSet,
} from '../../core/similarity.js';

/** `ORGANIZE_THRESHOLDS` の構造型(値は呼び出し側 / テストが定数から渡す)。 */
export type OrganizeThresholds = typeof ORGANIZE_THRESHOLDS;

/** `_uncategorized` を表すカテゴリキー(`core/categories-index.ts` と揃える)。 */
export const UNCATEGORIZED = '_uncategorized';

/** 検出対象の 1 ノート(frontmatter + 本文を検出器が必要な形へ落としたもの)。 */
export interface DetectNote {
  /** vault ルート相対・POSIX(例: `knowledge/tech/foo.md`)。 */
  relPath: string;
  /** `categories[0]`(trim 済み・POSIX)。未設定・空なら `_uncategorized`。 */
  category: string;
  /** frontmatter `title`。 */
  title: string;
  /** ノート本文(frontmatter を除いた Markdown)。 */
  body: string;
  /** frontmatter `tags`(文字列のみ)。 */
  tags: string[];
  /** frontmatter `updated`(ISO8601)。パース不能・未設定なら空文字。 */
  updated: string;
  /** frontmatter `created`(ISO8601)。パース不能・未設定なら空文字。 */
  created: string;
  /**
   * frontmatter の `categories` がスカラー(配列でない)、または旧式スカラー `category` キーが
   * 使われている(= 配列化が必要)。scan 側が raw frontmatter を見て立てる。
   */
  categoriesScalar: boolean;
}

export type SuggestionKind =
  | 'split-category'
  | 'merge-category'
  | 'duplicate'
  | 'move-uncategorized'
  | 'stale-content'
  | 'split-file'
  | 'fix-frontmatter';

/** scan が返す 1 提案(proposalId は `scan.ts` が採番する)。 */
export interface Suggestion {
  kind: SuggestionKind;
  /** 破壊度(設計書 §8-N `Proposal.destructiveness`)。 */
  destructiveness: 'safe' | 'move' | 'merge' | 'delete';
  /** 対象ノート / カテゴリの vault 相対パス。 */
  targets: string[];
  /** 人間可読の現状。 */
  before: string;
  /** 人間可読の適用後。 */
  after: string;
  /** 機械検出の根拠(件数・Jaccard 値・一致ハッシュ等)。 */
  evidence: Record<string, unknown>;
  /** delete / merge / rename-category 相当は個別承認必須。 */
  requiresIndividualApproval: boolean;
}

const MS_PER_DAY = 86_400_000;
const STALE_EXEMPT_TAGS = new Set(['reference', 'permanent']);

/** `YYYY-MM-DD-` で始まるファイル名(store が禁止している日付プレフィックス命名。§8-M slug)。 */
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;

/** `knowledge/<cat...>/<file>.md` の相対パスから実ディレクトリのカテゴリ経路を取り出す(無ければ空)。 */
function dirCategoryOf(relPath: string): string {
  const parts = relPath.split('/').filter((s) => s !== '');
  if (parts.length < 3 || parts[0] !== 'knowledge') return '';
  return parts.slice(1, -1).join('/');
}

/** カテゴリ名 → そのカテゴリのノート(`_uncategorized` を含む全カテゴリ)。 */
function groupByCategory(notes: DetectNote[]): Map<string, DetectNote[]> {
  const map = new Map<string, DetectNote[]>();
  for (const note of notes) {
    const list = map.get(note.category);
    if (list === undefined) map.set(note.category, [note]);
    else list.push(note);
  }
  return map;
}

/**
 * split-category: あるカテゴリ内のノートが `subdivideMinFiles` 件以上あり、
 * そのうち特定タグを持つノートが `subdivideMinFiles` 件以上、かつカテゴリ全体に対する
 * 割合が `clusterTagMinShare` 未満(全ノートが同じタグなら分割の意味がない)なら、
 * そのタグでサブディレクトリへ分割する提案を出す。
 */
export function detectSplitCategory(
  notes: DetectNote[],
  t: OrganizeThresholds,
): Suggestion[] {
  const out: Suggestion[] = [];
  for (const [category, list] of groupByCategory(notes)) {
    if (category === UNCATEGORIZED || list.length < t.subdivideMinFiles) continue;

    const tagCounts = new Map<string, number>();
    for (const note of list) {
      for (const tag of new Set(note.tags)) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    for (const [tag, count] of [...tagCounts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const share = count / list.length;
      if (count < t.subdivideMinFiles || share >= t.clusterTagMinShare) continue;
      const members = list.filter((n) => n.tags.includes(tag)).map((n) => n.relPath).sort();
      out.push({
        kind: 'split-category',
        destructiveness: 'move',
        targets: [`knowledge/${category}`, ...members],
        before: `カテゴリ knowledge/${category}(${list.length} 件)`,
        after: `knowledge/${category}/${tag}/ へ ${count} 件を分割`,
        evidence: {
          category,
          categoryNoteCount: list.length,
          clusterTag: tag,
          clusterCount: count,
          clusterShare: share,
          thresholdKey: 'subdivideMinFiles',
        },
        requiresIndividualApproval: false,
      });
    }
  }
  return out;
}

/**
 * merge-category: 2 カテゴリの集約本文(そのカテゴリの全ノート本文を連結)の
 * bigram Jaccard が `mergeCandidateBigramJaccard` 以上なら統合候補として両方を提示する。
 * 名前が類義かどうかの最終判断は Claude に委ねる(候補提示に留める)。
 */
export function detectMergeCategory(
  notes: DetectNote[],
  t: OrganizeThresholds,
): Suggestion[] {
  const groups = [...groupByCategory(notes)]
    .filter(([category]) => category !== UNCATEGORIZED)
    .map(([category, list]) => ({
      category,
      list,
      body: list.map((n) => n.body).join('\n\n'),
    }))
    .sort((a, b) => (a.category < b.category ? -1 : 1));

  const out: Suggestion[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const a = groups[i];
      const b = groups[j];
      if (a === undefined || b === undefined) continue;
      const score = bigramJaccard(a.body, b.body);
      if (score < t.mergeCandidateBigramJaccard) continue;
      out.push({
        kind: 'merge-category',
        destructiveness: 'merge',
        targets: [`knowledge/${a.category}`, `knowledge/${b.category}`],
        before: `knowledge/${a.category}(${a.list.length} 件) と knowledge/${b.category}(${b.list.length} 件)`,
        after: `2 カテゴリを 1 つに統合`,
        evidence: {
          categories: [a.category, b.category],
          bigramJaccard: score,
          thresholdKey: 'mergeCandidateBigramJaccard',
        },
        requiresIndividualApproval: true,
      });
    }
  }
  return out;
}

/**
 * duplicate: `titleKey`(正規化タイトル)が完全一致するノートが 2 件以上、
 * または `bodyHash`(空白差を吸収した本文 sha256)が一致するノートが 2 件以上 → 重複候補。
 */
export function detectDuplicates(
  notes: DetectNote[],
  t: OrganizeThresholds,
): Suggestion[] {
  const out: Suggestion[] = [];

  const collect = (
    keyOf: (n: DetectNote) => string,
    reason: 'title-exact' | 'body-hash',
    label: string,
  ): void => {
    const buckets = new Map<string, DetectNote[]>();
    for (const note of notes) {
      const key = keyOf(note);
      if (key === '') continue;
      const list = buckets.get(key);
      if (list === undefined) buckets.set(key, [note]);
      else list.push(note);
    }
    for (const [key, list] of buckets) {
      if (list.length < 2) continue;
      const targets = list.map((n) => n.relPath).sort();
      out.push({
        kind: 'duplicate',
        destructiveness: 'merge',
        targets,
        before: `${label} が一致するノート ${list.length} 件`,
        after: `重複を統合 / 片方を削除`,
        evidence: { reason, key, count: list.length },
        requiresIndividualApproval: true,
      });
    }
  };

  if (t.duplicateTitleExact) collect((n) => titleKey(n.title), 'title-exact', 'タイトル');
  if (t.duplicateBodyHashExact) collect((n) => bodyHash(n.body), 'body-hash', '本文ハッシュ');

  return out;
}

/**
 * move-uncategorized: `_uncategorized` の各ノートについて、既存カテゴリの集約 bigram 集合との
 * Jaccard 最大値が `uncategorizedAssignMinJaccard` 以上なら、その候補カテゴリへの割り当てを提示。
 */
export function detectMoveUncategorized(
  notes: DetectNote[],
  t: OrganizeThresholds,
): Suggestion[] {
  const byCategory = groupByCategory(notes);
  const uncategorized = byCategory.get(UNCATEGORIZED) ?? [];
  if (uncategorized.length === 0) return [];

  const categorySets: { category: string; set: Set<string> }[] = [];
  for (const [category, list] of byCategory) {
    if (category === UNCATEGORIZED) continue;
    categorySets.push({ category, set: toBigramSet(list.map((n) => n.body).join('\n\n')) });
  }
  if (categorySets.length === 0) return [];

  const out: Suggestion[] = [];
  for (const note of uncategorized) {
    const noteSet = toBigramSet(note.body);
    let best: { category: string; score: number } | null = null;
    for (const { category, set } of categorySets) {
      const score = jaccard(noteSet, set);
      if (best === null || score > best.score) best = { category, score };
    }
    if (best === null || best.score < t.uncategorizedAssignMinJaccard) continue;
    out.push({
      kind: 'move-uncategorized',
      destructiveness: 'move',
      targets: [note.relPath],
      before: `${note.relPath}(_uncategorized)`,
      after: `knowledge/${best.category}/ へ移動`,
      evidence: {
        candidateCategory: best.category,
        jaccard: best.score,
        thresholdKey: 'uncategorizedAssignMinJaccard',
      },
      requiresIndividualApproval: false,
    });
  }
  return out;
}

/**
 * stale-content: `updated` から `staleDays` を超えて経過し、かつ `tags` に
 * `reference` / `permanent` を含まないノートに stale フラグを立てる(提示のみ)。
 */
export function detectStale(
  notes: DetectNote[],
  t: OrganizeThresholds,
  now: number,
): Suggestion[] {
  const out: Suggestion[] = [];
  for (const note of notes) {
    if (note.tags.some((tag) => STALE_EXEMPT_TAGS.has(tag))) continue;
    const updatedMs = Date.parse(note.updated);
    if (Number.isNaN(updatedMs)) continue;
    const ageDays = (now - updatedMs) / MS_PER_DAY;
    if (ageDays <= t.staleDays) continue;
    out.push({
      kind: 'stale-content',
      destructiveness: 'safe',
      targets: [note.relPath],
      before: `${note.relPath}(最終更新 ${note.updated})`,
      after: `内容の見直し / アーカイブを検討`,
      evidence: {
        updated: note.updated,
        ageDays: Math.floor(ageDays),
        thresholdKey: 'staleDays',
      },
      requiresIndividualApproval: false,
    });
  }
  return out;
}

/**
 * split-file: ファイル名が日付プレフィックス(`^\d{4}-\d{2}-\d{2}-`)で命名されているノートを、
 * トピック単位への分割 / 日付を外した slug へのリネーム候補として提示する(提示のみ)。
 * 見出し数ベースの完全形判定は数値しきい値が未定義のため見送り(モジュール冒頭コメント参照)。
 */
export function detectSplitFile(notes: DetectNote[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const note of notes) {
    const filename = note.relPath.split('/').pop() ?? note.relPath;
    if (!DATE_PREFIX_RE.test(filename)) continue;
    out.push({
      kind: 'split-file',
      destructiveness: 'safe',
      targets: [note.relPath],
      before: `${note.relPath}(日付プレフィックス命名)`,
      after: `トピック単位のファイルへ分割し、日付を外した slug へリネーム`,
      evidence: { reason: 'date-prefix', filename },
      requiresIndividualApproval: false,
    });
  }
  return out;
}

/**
 * fix-frontmatter: frontmatter の機械的な不整合を是正候補として提示する(提示のみ)。
 * 検出する不整合:
 *   - `categories-scalar`        … `categories` がスカラー / 旧式 `category` キー(配列化が必要)
 *   - `category-path-mismatch`   … `categories[0]` が実ディレクトリのカテゴリ経路と不一致
 *   - `created-after-updated`    … `created` が `updated` より後
 */
export function detectFixFrontmatter(notes: DetectNote[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const note of notes) {
    const reasons: string[] = [];

    if (note.categoriesScalar) reasons.push('categories-scalar');

    const dirCategory = dirCategoryOf(note.relPath);
    if (dirCategory !== '' && note.category !== dirCategory) {
      reasons.push('category-path-mismatch');
    }

    const createdMs = Date.parse(note.created);
    const updatedMs = Date.parse(note.updated);
    if (!Number.isNaN(createdMs) && !Number.isNaN(updatedMs) && createdMs > updatedMs) {
      reasons.push('created-after-updated');
    }

    if (reasons.length === 0) continue;
    out.push({
      kind: 'fix-frontmatter',
      destructiveness: 'safe',
      targets: [note.relPath],
      before: `${note.relPath}(frontmatter 不整合: ${reasons.join(', ')})`,
      after: `frontmatter を是正(${reasons.join(', ')})`,
      evidence: { reasons, declaredCategory: note.category, dirCategory },
      requiresIndividualApproval: false,
    });
  }
  return out;
}

/**
 * 全検出器を順に回して提案配列を返す(設計書 §8-N scan)。順序は
 * split-category → merge-category → duplicate → move-uncategorized → stale-content
 * → split-file → fix-frontmatter。
 */
export function detectAll(
  notes: DetectNote[],
  t: OrganizeThresholds,
  now: number,
): Suggestion[] {
  return [
    ...detectSplitCategory(notes, t),
    ...detectMergeCategory(notes, t),
    ...detectDuplicates(notes, t),
    ...detectMoveUncategorized(notes, t),
    ...detectStale(notes, t, now),
    ...detectSplitFile(notes),
    ...detectFixFrontmatter(notes),
  ];
}
